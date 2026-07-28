// Copyright (C) 2017-2026 Smart code 203358507

import type { Config } from '../config.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { parseEnvelope, type ParsedEnvelope } from '../protocol/envelopes.ts';
import { CLOSE_CODES, ProtocolError, isProtocolError } from '../protocol/errors.ts';
import {
    createClientMessageSchemas,
    isClientMessageType,
    validateClientMessage,
    type ClientMessagePayload,
    type ClientMessageSchemas,
} from '../protocol/schemas.ts';
import {
    MIN_SUPPORTED_PROTOCOL_VERSION,
    PROTOCOL_VERSION,
    REQUIRED_CAPABILITIES,
    type ClientMessageType,
    type RoomCloseReason,
} from '../protocol/types.ts';
import { RoomStore } from '../rooms/RoomStore.ts';
import { missingCapabilities } from '../rooms/RoomPolicy.ts';
import type { Room } from '../rooms/Room.ts';
import { SessionStore, type SessionRecord } from '../sessions/SessionStore.ts';
import type { Connection, RateBucketName } from './connection.ts';

/**
 * The room service.
 *
 * Every inbound message goes through the same funnel: parse the envelope, check
 * the handshake, spend a rate-limit token, validate the payload, then dispatch.
 * A message that fails any earlier step never reaches room state.
 */

const RATE_BUCKETS: Record<ClientMessageType, RateBucketName> = {
    'session.hello': 'command',
    'clock.ping': 'clock',
    'room.create': 'command',
    'room.join': 'command',
    'room.leave': 'command',
    'room.close': 'command',
    'participant.ready': 'status',
    'playback.command': 'command',
    'playback.observation': 'status',
    'media.change': 'command',
    'source.refresh': 'command',
};

export type WatchPartyServiceDependencies = {
    config: Config;
    logger: Logger;
    metrics: Metrics;
    now?: () => number;
};

export class WatchPartyService {
    readonly rooms: RoomStore;
    readonly sessions: SessionStore;

    private readonly config: Config;
    private readonly logger: Logger;
    private readonly metrics: Metrics;
    private readonly now: () => number;
    private readonly schemas: ClientMessageSchemas;
    private readonly connectionsBySessionId = new Map<string, Connection>();
    private shuttingDown = false;

    constructor(dependencies: WatchPartyServiceDependencies) {
        this.config = dependencies.config;
        this.logger = dependencies.logger;
        this.metrics = dependencies.metrics;
        this.now = dependencies.now ?? Date.now;
        this.schemas = createClientMessageSchemas({ maxDisplayNameLength: this.config.maxDisplayNameLength });
        this.sessions = new SessionStore({ resumeGraceMs: this.config.resumeGraceMs });
        this.rooms = new RoomStore({
            maxRooms: this.config.maxRooms,
            roomTtlMs: this.config.roomTtlMs,
            roomIdleTtlMs: this.config.roomIdleTtlMs,
            maxParticipantsPerRoom: this.config.maxParticipantsPerRoom,
            commandHistorySize: this.config.commandHistorySize,
            defaultLeadMs: this.config.defaultLeadMs,
            hostGraceMs: this.config.hostGraceMs,
        });
    }

    get openConnectionCount(): number {
        return this.connectionsBySessionId.size;
    }

    handleOpen(connection: Connection): void {
        this.metrics.connectionsTotal.inc();
        this.metrics.connectionsOpen.inc();
        this.logger.debug('connection_open', { connectionId: connection.connectionId });
    }

    handleMessage(connection: Connection, raw: string): void {
        let envelope: ParsedEnvelope | null = null;
        try {
            envelope = parseEnvelope(raw, { maxBytes: this.config.maxMessageBytes });
            this.dispatch(connection, envelope);
        } catch (error) {
            this.reportFailure(connection, error, envelope?.requestId);
        }
    }

    handleClose(connection: Connection): void {
        this.metrics.connectionsOpen.dec();
        const sessionId = connection.sessionId;
        if (sessionId === null) {
            return;
        }
        this.connectionsBySessionId.delete(sessionId);
        const nowMs = this.now();
        const record = this.sessions.markDisconnected(sessionId, nowMs);
        if (record === undefined || record.roomId === null || record.participantId === null) {
            return;
        }
        const room = this.rooms.get(record.roomId);
        if (room === undefined) {
            return;
        }
        room.markDisconnected(record.participantId, nowMs);
        this.metrics.participantsOpen.dec();
        const participant = room.getParticipant(record.participantId);
        if (participant !== undefined) {
            this.broadcast(room, 'participant.updated', { participant: room.toParticipantPublic(participant) });
        }
        this.logger.info('participant_disconnected', {
            roomId: room.roomId,
            participantId: record.participantId,
            isHost: participant?.isHost === true,
        });
    }

    // ---------------------------------------------------------------- dispatch

    private dispatch(connection: Connection, envelope: ParsedEnvelope): void {
        const { type } = envelope;
        if (!isClientMessageType(type)) {
            throw new ProtocolError('UNKNOWN_MESSAGE_TYPE', `unknown message type ${JSON.stringify(type)}`);
        }
        if (this.shuttingDown) {
            throw new ProtocolError('SERVER_SHUTTING_DOWN', 'server is shutting down', {
                closeCode: CLOSE_CODES.SHUTTING_DOWN,
            });
        }

        const nowMs = this.now();
        const bucket = RATE_BUCKETS[type];
        if (!connection.consume(bucket, nowMs)) {
            this.metrics.rateLimitedTotal.inc({ bucket });
            // Deliberately not counted as an invalid message: a burst of legal
            // traffic must not close a healthy connection.
            connection.sendError('RATE_LIMITED', 'too many messages', {
                requestId: envelope.requestId,
                details: { bucket },
            });
            return;
        }

        if (type === 'session.hello') {
            this.handleHello(connection, validateClientMessage(this.schemas, type, envelope.payload), envelope, nowMs);
            return;
        }

        const session = this.requireSession(connection);
        this.sessions.touch(session.sessionId, nowMs);

        switch (type) {
            case 'clock.ping':
                this.handleClockPing(connection, validateClientMessage(this.schemas, type, envelope.payload), envelope, nowMs);
                return;
            case 'room.create':
                this.handleRoomCreate(connection, session, validateClientMessage(this.schemas, type, envelope.payload), envelope, nowMs);
                return;
            case 'room.join':
                this.handleRoomJoin(connection, session, validateClientMessage(this.schemas, type, envelope.payload), envelope, nowMs);
                return;
            case 'room.leave':
                this.handleRoomLeave(connection, session, envelope, nowMs);
                return;
            case 'room.close':
                this.handleRoomClose(session);
                return;
            case 'participant.ready':
                this.handleParticipantReady(session, validateClientMessage(this.schemas, type, envelope.payload), nowMs);
                return;
            case 'playback.command':
                this.handlePlaybackCommand(connection, session, validateClientMessage(this.schemas, type, envelope.payload), envelope, nowMs);
                return;
            case 'playback.observation':
                this.handlePlaybackObservation(session, validateClientMessage(this.schemas, type, envelope.payload), nowMs);
                return;
            case 'media.change':
                this.handleMediaChange(session, validateClientMessage(this.schemas, type, envelope.payload), nowMs);
                return;
            case 'source.refresh':
                this.handleSourceRefresh(session, validateClientMessage(this.schemas, type, envelope.payload), nowMs);
                return;
            default: {
                const exhaustive: never = type;
                throw new ProtocolError('UNKNOWN_MESSAGE_TYPE', `unhandled message type ${String(exhaustive)}`);
            }
        }
    }

    // ---------------------------------------------------------------- handlers

    private handleHello(
        connection: Connection,
        payload: ClientMessagePayload<'session.hello'>,
        envelope: ParsedEnvelope,
        nowMs: number,
    ): void {
        if (connection.sessionId !== null) {
            throw new ProtocolError('ALREADY_HANDSHAKEN', 'session.hello has already been accepted');
        }
        if (
            payload.protocolVersion < MIN_SUPPORTED_PROTOCOL_VERSION ||
            payload.protocolVersion > PROTOCOL_VERSION
        ) {
            throw new ProtocolError('UNSUPPORTED_PROTOCOL_VERSION', 'client protocol version is not supported', {
                details: { min: MIN_SUPPORTED_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
                closeCode: CLOSE_CODES.UNSUPPORTED_VERSION,
            });
        }

        const missing = missingCapabilities(payload.capabilities);
        let record: SessionRecord;
        let resumeToken: string | null = null;
        let resumed = false;

        if (payload.resume !== undefined) {
            record = this.sessions.resume({
                sessionId: payload.resume.sessionId,
                resumeToken: payload.resume.resumeToken,
                nowMs,
            });
            // Capabilities can legitimately change across a reload, for example
            // when the user switched to a cast device.
            record.capabilities = payload.capabilities;
            record.clientVersion = payload.clientVersion;
            resumed = true;
            this.metrics.reconnectsTotal.inc();
        } else {
            const created = this.sessions.create({
                clientVersion: payload.clientVersion,
                capabilities: payload.capabilities,
                nowMs,
            });
            record = created.record;
            resumeToken = created.resumeToken;
        }

        connection.sessionId = record.sessionId;
        this.connectionsBySessionId.set(record.sessionId, connection);

        connection.send(
            'session.welcome',
            {
                sessionId: record.sessionId,
                resumeToken,
                resumed,
                protocolVersion: PROTOCOL_VERSION,
                minProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
                serverTimeMs: nowMs,
                requiredCapabilities: [...REQUIRED_CAPABILITIES],
                missingCapabilities: missing,
                supported: missing.length === 0,
                limits: {
                    maxMessageBytes: this.config.maxMessageBytes,
                    maxParticipantsPerRoom: this.config.maxParticipantsPerRoom,
                    defaultLeadMs: this.config.defaultLeadMs,
                    resumeGraceMs: this.config.resumeGraceMs,
                },
            },
            { requestId: envelope.requestId },
        );

        if (!resumed) {
            return;
        }
        this.rebindResumedSession(connection, record, nowMs);
    }

    /**
     * Restores a resumed session's room membership.
     *
     * If the room is gone the client is told once and the session is unbound —
     * it must not keep believing it is in a room that no longer exists.
     */
    private rebindResumedSession(connection: Connection, record: SessionRecord, nowMs: number): void {
        if (record.roomId === null || record.participantId === null) {
            return;
        }
        const room = this.rooms.get(record.roomId);
        if (room === undefined || room.closed || room.getParticipant(record.participantId) === undefined) {
            record.roomId = null;
            record.participantId = null;
            connection.send('room.closed', { reason: 'expired' satisfies RoomCloseReason });
            return;
        }
        room.updateCapabilities(record.participantId, record.capabilities);
        room.markConnected(record.participantId, record.sessionId, nowMs);
        this.metrics.participantsOpen.inc();
        connection.send('room.snapshot', { room: room.toSnapshot(nowMs), selfParticipantId: record.participantId });
        const participant = room.getParticipant(record.participantId);
        if (participant !== undefined) {
            this.broadcast(room, 'participant.updated', { participant: room.toParticipantPublic(participant) });
        }
        this.logger.info('participant_resumed', { roomId: room.roomId, participantId: record.participantId });
    }

    private handleClockPing(
        connection: Connection,
        payload: ClientMessagePayload<'clock.ping'>,
        envelope: ParsedEnvelope,
        nowMs: number,
    ): void {
        // The client's own timestamp is echoed, never trusted: only the two
        // server timestamps enter the offset estimate.
        connection.send(
            'clock.pong',
            {
                nonce: payload.nonce,
                clientSentMs: payload.clientSentMs,
                serverRecvMs: nowMs,
                serverSendMs: this.now(),
            },
            { requestId: envelope.requestId },
        );
    }

    private handleRoomCreate(
        connection: Connection,
        session: SessionRecord,
        payload: ClientMessagePayload<'room.create'>,
        envelope: ParsedEnvelope,
        nowMs: number,
    ): void {
        this.assertNotInRoom(session);
        const room = this.rooms.create(
            {
                host: {
                    displayName: payload.displayName,
                    deviceLabel: payload.deviceLabel,
                    capabilities: session.capabilities,
                },
                media: payload.media,
                source: payload.source,
                observation: {
                    positionMs: payload.observation.positionMs,
                    rate: payload.observation.rate,
                    durationMs: payload.observation.durationMs,
                },
                policy: payload.policy,
            },
            nowMs,
        );

        session.roomId = room.roomId;
        session.participantId = room.hostParticipantId;
        room.markConnected(room.hostParticipantId, session.sessionId, nowMs);
        this.metrics.roomsCreatedTotal.inc();
        this.metrics.roomsOpen.set(this.rooms.size);
        this.metrics.participantsOpen.inc();

        connection.send(
            'room.created',
            {
                roomId: room.roomId,
                // The only time the invitation secret is ever transmitted.
                inviteSecret: room.inviteSecret,
                selfParticipantId: room.hostParticipantId,
                room: room.toSnapshot(nowMs),
            },
            { requestId: envelope.requestId },
        );
        this.logger.info('room_created', { roomId: room.roomId, participantId: room.hostParticipantId });
    }

    private handleRoomJoin(
        connection: Connection,
        session: SessionRecord,
        payload: ClientMessagePayload<'room.join'>,
        envelope: ParsedEnvelope,
        nowMs: number,
    ): void {
        this.assertNotInRoom(session);
        const room = this.rooms.requireOpen(payload.roomId, nowMs);
        const participant = room.join({
            inviteSecret: payload.inviteSecret,
            displayName: payload.displayName,
            deviceLabel: payload.deviceLabel,
            capabilities: session.capabilities,
            nowMs,
        });

        session.roomId = room.roomId;
        session.participantId = participant.participantId;
        room.markConnected(participant.participantId, session.sessionId, nowMs);
        this.metrics.joinsTotal.inc();
        this.metrics.participantsOpen.inc();

        connection.send(
            'room.snapshot',
            { room: room.toSnapshot(nowMs), selfParticipantId: participant.participantId },
            { requestId: envelope.requestId },
        );
        this.broadcast(room, 'participant.updated', { participant: room.toParticipantPublic(participant) }, {
            exceptSessionId: session.sessionId,
        });
        this.logger.info('room_joined', { roomId: room.roomId, participantId: participant.participantId });
    }

    private handleRoomLeave(
        connection: Connection,
        session: SessionRecord,
        envelope: ParsedEnvelope,
        nowMs: number,
    ): void {
        const { room, participantId } = this.requireRoomMembership(session);
        const participant = room.requireParticipant(participantId);

        if (participant.isHost) {
            // An explicit host departure ends the room. That is distinct from a
            // host *disconnect*, which only freezes playback and allows a resume.
            this.closeRoom(room, 'host_ended');
            connection.send('room.closed', { reason: 'host_ended' satisfies RoomCloseReason }, { requestId: envelope.requestId });
            return;
        }

        room.removeParticipant(participantId, nowMs);
        session.roomId = null;
        session.participantId = null;
        this.metrics.participantsOpen.dec();
        connection.send('room.closed', { reason: 'left' satisfies RoomCloseReason }, { requestId: envelope.requestId });
        this.broadcast(room, 'participant.left', { participantId });
        this.logger.info('room_left', { roomId: room.roomId, participantId });
    }

    private handleRoomClose(session: SessionRecord): void {
        const { room, participantId } = this.requireRoomMembership(session);
        if (participantId !== room.hostParticipantId) {
            throw new ProtocolError('NOT_HOST', 'only the host can end the room');
        }
        this.closeRoom(room, 'host_ended');
    }

    private handleParticipantReady(
        session: SessionRecord,
        payload: ClientMessagePayload<'participant.ready'>,
        nowMs: number,
    ): void {
        const { room, participantId } = this.requireRoomMembership(session);
        const participant = room.updateReadiness(participantId, payload, nowMs);
        this.broadcast(room, 'participant.updated', { participant: room.toParticipantPublic(participant) });
    }

    private handlePlaybackCommand(
        connection: Connection,
        session: SessionRecord,
        payload: ClientMessagePayload<'playback.command'>,
        envelope: ParsedEnvelope,
        nowMs: number,
    ): void {
        const { room, participantId } = this.requireRoomMembership(session);
        let result;
        try {
            result = room.applyHostCommand(participantId, payload, nowMs);
        } catch (error) {
            if (isProtocolError(error)) {
                this.metrics.commandsRejectedTotal.inc({ reason: error.code });
                // A rejected command means the sender's view is stale, so hand
                // back the current truth rather than only an error.
                connection.send('playback.state', { playback: room.playback, serverTimeMs: this.now() });
            }
            throw error;
        }

        if (result.outcome === 'duplicate') {
            // Replayed after a reconnect: acknowledge with current state, do not
            // apply anything a second time.
            connection.send('playback.state', { playback: room.playback, serverTimeMs: this.now() }, { requestId: envelope.requestId });
            return;
        }

        this.metrics.commandsTotal.inc({ action: payload.action });
        this.metrics.commandLatency.observe(this.now() - nowMs);
        this.broadcast(room, 'playback.state', { playback: room.playback, serverTimeMs: this.now() });
    }

    private handlePlaybackObservation(
        session: SessionRecord,
        payload: ClientMessagePayload<'playback.observation'>,
        nowMs: number,
    ): void {
        const { room, participantId } = this.requireRoomMembership(session);
        const participant = room.getParticipant(participantId);
        if (participant === undefined) {
            return;
        }
        participant.buffering = payload.buffering;
        participant.durationMs = payload.durationMs;
        participant.mediaRevision = payload.mediaRevision;
        participant.lastSeenServerMs = nowMs;

        if (participant.isHost) {
            const changed = room.applyHostObservation(
                participantId,
                payload,
                nowMs,
                this.config.hostObservationToleranceMs,
            );
            if (changed) {
                this.broadcast(room, 'playback.state', { playback: room.playback, serverTimeMs: this.now() });
            }
            return;
        }

        if (payload.mediaRevision === room.mediaRevision && !room.playback.paused) {
            this.metrics.guestDrift.observe(Math.abs(payload.positionMs - room.canonicalPositionMs(nowMs)));
        }
        room.touch(nowMs);
    }

    private handleMediaChange(
        session: SessionRecord,
        payload: ClientMessagePayload<'media.change'>,
        nowMs: number,
    ): void {
        const { room, participantId } = this.requireRoomMembership(session);
        const { changed } = room.changeMedia(participantId, payload, nowMs);
        if (!changed) {
            // Duplicate `media.change` after a retry: the room is already there.
            return;
        }
        this.metrics.mediaChangesTotal.inc();
        this.broadcast(room, 'media.changed', {
            mediaRevision: room.mediaRevision,
            media: room.media,
            source: room.source,
            playback: room.playback,
            serverTimeMs: this.now(),
        });
        this.logger.info('media_changed', { roomId: room.roomId, mediaRevision: room.mediaRevision });
    }

    private handleSourceRefresh(
        session: SessionRecord,
        payload: ClientMessagePayload<'source.refresh'>,
        nowMs: number,
    ): void {
        const { room, participantId } = this.requireRoomMembership(session);
        room.refreshSource(participantId, payload.source, nowMs);
        this.broadcast(room, 'source.updated', { mediaRevision: room.mediaRevision, source: room.source });
    }

    // ------------------------------------------------------------- maintenance

    /**
     * Periodic maintenance: host-grace freezes, session expiry and room expiry.
     * Called from a single interval so there is exactly one place where time
     * advances the room state machine.
     */
    sweep(): void {
        const nowMs = this.now();

        for (const room of this.rooms.applyHostGrace(nowMs)) {
            this.broadcast(room, 'playback.state', { playback: room.playback, serverTimeMs: nowMs });
            this.logger.info('host_grace_freeze', { roomId: room.roomId });
        }

        for (const record of this.sessions.sweep(nowMs)) {
            if (record.roomId === null || record.participantId === null) {
                continue;
            }
            const room = this.rooms.get(record.roomId);
            if (room === undefined) {
                continue;
            }
            const participant = room.getParticipant(record.participantId);
            room.removeParticipant(record.participantId, nowMs);
            if (participant?.isHost === true) {
                // The host's resume window closed: the room cannot continue.
                this.closeRoom(room, 'host_left');
            } else {
                this.broadcast(room, 'participant.left', { participantId: record.participantId });
            }
        }

        for (const { room, reason } of this.rooms.sweep(nowMs)) {
            this.notifyRoomClosed(room, reason);
        }

        this.metrics.roomsOpen.set(this.rooms.size);
    }

    private closeRoom(room: Room, reason: RoomCloseReason): void {
        room.close(reason);
        this.rooms.delete(room.roomId);
        this.notifyRoomClosed(room, reason);
        this.metrics.roomsClosedTotal.inc({ reason });
        this.metrics.roomsOpen.set(this.rooms.size);
    }

    /**
     * Tells every connected session the room is gone and unbinds it.
     *
     * A *disconnected* session keeps its binding on purpose: it could not
     * receive this notice, so leaving the binding in place lets a later resume
     * discover the missing room and report `room.closed` then. The session
     * itself still expires with its resume window, so nothing leaks.
     */
    private notifyRoomClosed(room: Room, reason: RoomCloseReason): void {
        for (const record of this.sessions.listForRoom(room.roomId)) {
            if (!record.connected) {
                continue;
            }
            this.connectionsBySessionId.get(record.sessionId)?.send('room.closed', { reason });
            this.metrics.participantsOpen.dec();
            record.roomId = null;
            record.participantId = null;
        }
        this.logger.info('room_closed', { roomId: room.roomId, reason });
    }

    /**
     * Refuses new work and tells every client why, so a deploy shows up as a
     * clean `room.closed` rather than a silent socket drop.
     */
    shutdown(): void {
        this.shuttingDown = true;
        for (const room of this.rooms.closeAll('server_shutdown')) {
            this.notifyRoomClosed(room, 'server_shutdown');
        }
        for (const connection of this.connectionsBySessionId.values()) {
            connection.close(CLOSE_CODES.SHUTTING_DOWN, 'server shutting down');
        }
        this.connectionsBySessionId.clear();
        this.metrics.roomsOpen.set(0);
        this.metrics.participantsOpen.set(0);
    }

    // ------------------------------------------------------------------ shared

    private broadcast(
        room: Room,
        type: string,
        payload: unknown,
        options: { exceptSessionId?: string } = {},
    ): void {
        for (const record of this.sessions.listForRoom(room.roomId)) {
            if (options.exceptSessionId !== undefined && record.sessionId === options.exceptSessionId) {
                continue;
            }
            this.connectionsBySessionId.get(record.sessionId)?.send(type, payload, { roomId: room.roomId });
        }
    }

    private requireSession(connection: Connection): SessionRecord {
        const sessionId = connection.sessionId;
        const record = sessionId === null ? undefined : this.sessions.get(sessionId);
        if (record === undefined) {
            throw new ProtocolError('HANDSHAKE_REQUIRED', 'session.hello must be sent first');
        }
        return record;
    }

    private assertNotInRoom(session: SessionRecord): void {
        if (session.roomId !== null) {
            throw new ProtocolError('ALREADY_IN_ROOM', 'session is already in a room');
        }
    }

    private requireRoomMembership(session: SessionRecord): { room: Room; participantId: string } {
        if (session.roomId === null || session.participantId === null) {
            throw new ProtocolError('NOT_IN_ROOM', 'session is not in a room');
        }
        const room = this.rooms.get(session.roomId);
        if (room === undefined || room.closed) {
            session.roomId = null;
            session.participantId = null;
            throw new ProtocolError('ROOM_NOT_FOUND', 'room is no longer available');
        }
        return { room, participantId: session.participantId };
    }

    /**
     * Converts a thrown error into a protocol error frame.
     *
     * Unexpected errors become a generic `INTERNAL_ERROR`: an exception message
     * could otherwise carry a stream URL or an auth key to the client.
     */
    private reportFailure(connection: Connection, error: unknown, requestId: string | undefined): void {
        if (isProtocolError(error)) {
            this.metrics.invalidMessagesTotal.inc({ code: error.code });
            connection.sendError(error.code, error.message, { requestId, details: error.details });
            if (error.closeCode !== undefined) {
                connection.close(error.closeCode, error.code);
                return;
            }
            this.countInvalidMessage(connection, error.code);
            return;
        }

        this.metrics.invalidMessagesTotal.inc({ code: 'INTERNAL_ERROR' });
        this.logger.error('message_handling_failed', {
            connectionId: connection.connectionId,
            error: error instanceof Error ? error : String(error),
        });
        connection.sendError('INTERNAL_ERROR', 'internal error', { requestId });
        this.countInvalidMessage(connection, 'INTERNAL_ERROR');
    }

    /** Repeated protocol violations from one socket close it (plan section 13). */
    private countInvalidMessage(connection: Connection, code: string): void {
        connection.invalidMessages += 1;
        if (connection.invalidMessages >= this.config.maxInvalidMessages) {
            this.logger.warn('connection_closed_invalid_messages', {
                connectionId: connection.connectionId,
                code,
                count: connection.invalidMessages,
            });
            connection.close(CLOSE_CODES.TOO_MANY_INVALID_MESSAGES, 'too many invalid messages');
        }
    }
}
