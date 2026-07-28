// Copyright (C) 2017-2026 Smart code 203358507

import { ProtocolError } from '../protocol/errors.ts';
import type {
    MediaDescriptor,
    ParticipantPublic,
    PlaybackState,
    PlayerCapabilities,
    RoomCloseReason,
    RoomPolicy,
    RoomSnapshot,
    SourceBundle,
} from '../protocol/types.ts';
import { CommandHistory, applyPlaybackCommand, type ApplyCommandResult, type PlaybackCommand } from '../sync/commands.ts';
import {
    clampPositionMs,
    createInitialPlaybackState,
    freezePlayback,
    positionAtServerMs,
    resetPlaybackForMedia,
} from '../sync/canonicalPlayback.ts';
import { generateParticipantId, generateRoomId, generateInviteSecret, secretsMatch } from './ids.ts';
import { isSupportedClient, normalizeRoomPolicy } from './RoomPolicy.ts';

/**
 * A single ephemeral room.
 *
 * All state is in memory and expires; nothing here is persisted. That is a
 * deliberate MVP decision (plan section 15.1) — silently restoring a stale room
 * after a restart is worse than ending it.
 */

/** Shortest window over which progress is meaningful rather than jitter. */
const MIN_STALL_SAMPLE_MS = 500;

/** Below this fraction of expected progress, the host counts as stalled. */
const STALL_PROGRESS_RATIO = 0.25;

export type PauseReason = 'host_stalled' | 'participant_buffering';

export type HostObservationResult = {
    changed: boolean;
    /** Set when the service paused the room rather than merely rebasing it. */
    reason: PauseReason | null;
};

export type Participant = {
    participantId: string;
    displayName: string;
    deviceLabel: string | null;
    isHost: boolean;
    capabilities: PlayerCapabilities;
    supported: boolean;
    connected: boolean;
    /** Current session id, or the last one while within the resume grace period. */
    sessionId: string | null;
    ready: boolean;
    loaded: boolean;
    buffering: boolean;
    durationMs: number | null;
    mediaRevision: number;
    sourceFingerprint: string | null;
    joinedAtServerMs: number;
    lastSeenServerMs: number;
    disconnectedAtServerMs: number | null;
};

export type RoomOptions = {
    nowMs: number;
    ttlMs: number;
    maxParticipants: number;
    commandHistorySize: number;
    defaultLeadMs: number;
    hostGraceMs: number;
};

export type CreateRoomInput = {
    host: {
        displayName: string;
        deviceLabel: string | null;
        capabilities: PlayerCapabilities;
    };
    media: MediaDescriptor;
    source: SourceBundle;
    observation: { positionMs: number; rate: number; durationMs: number | null };
    policy: Partial<RoomPolicy> | undefined;
};

export class Room {
    readonly roomId: string;
    /** Bearer credential; never included in a snapshot or a log line. */
    readonly inviteSecret: string;
    readonly createdAtServerMs: number;
    readonly expiresAtServerMs: number;
    readonly options: RoomOptions;

    hostParticipantId: string;
    media: MediaDescriptor;
    source: SourceBundle;
    playback: PlaybackState;
    policy: RoomPolicy;
    mediaRevision: number;
    lastActivityServerMs: number;
    closed: boolean = false;
    closeReason: RoomCloseReason | null = null;
    /** When the host's last connection dropped, for the grace-period freeze. */
    hostDisconnectedAtServerMs: number | null = null;
    /** Whether the current media revision has ever started playing. */
    hasStartedCurrentMedia: boolean = false;
    /**
     * Set when the service, not the host, paused the room. Surfaced to clients
     * so the interface can explain why playback stopped.
     */
    pauseReason: PauseReason | null = null;

    private readonly participants = new Map<string, Participant>();
    private readonly commandHistory: CommandHistory;
    private readonly appliedMediaChangeIds = new Set<string>();
    /**
     * Revision at which the server last mutated playback without a host command.
     * Host commands older than this are refused so the host resynchronizes.
     */
    private lastServerInitiatedRevision = 0;
    /** Previous host observation, used to measure whether it is making progress. */
    private lastHostObservation: { positionMs: number; atServerMs: number } | null = null;
    /** When the host first stopped making progress, or null while it is keeping up. */
    private hostStalledSinceServerMs: number | null = null;

    private constructor(input: CreateRoomInput, options: RoomOptions) {
        this.options = options;
        this.roomId = generateRoomId();
        this.inviteSecret = generateInviteSecret();
        this.createdAtServerMs = options.nowMs;
        this.expiresAtServerMs = options.nowMs + options.ttlMs;
        this.lastActivityServerMs = options.nowMs;
        this.media = input.media;
        this.source = input.source;
        this.policy = normalizeRoomPolicy(input.policy);
        this.mediaRevision = 1;
        this.commandHistory = new CommandHistory(options.commandHistorySize);
        this.playback = createInitialPlaybackState({
            nowMs: options.nowMs,
            positionMs: input.observation.positionMs,
            rate: input.observation.rate,
            mediaRevision: this.mediaRevision,
            durationMs: input.observation.durationMs,
        });

        const host = this.createParticipant({
            displayName: input.host.displayName,
            deviceLabel: input.host.deviceLabel,
            capabilities: input.host.capabilities,
            isHost: true,
            nowMs: options.nowMs,
        });
        this.hostParticipantId = host.participantId;
    }

    static create(input: CreateRoomInput, options: RoomOptions): Room {
        if (input.media.live) {
            throw new ProtocolError('UNSUPPORTED_MEDIA', 'live media has no stable timeline and cannot be synchronized');
        }
        return new Room(input, options);
    }

    private createParticipant(input: {
        displayName: string;
        deviceLabel: string | null;
        capabilities: PlayerCapabilities;
        isHost: boolean;
        nowMs: number;
    }): Participant {
        const participant: Participant = {
            participantId: generateParticipantId(),
            displayName: input.displayName,
            deviceLabel: input.deviceLabel,
            isHost: input.isHost,
            capabilities: input.capabilities,
            supported: isSupportedClient(input.capabilities),
            connected: true,
            sessionId: null,
            ready: false,
            loaded: false,
            buffering: false,
            durationMs: null,
            mediaRevision: this.mediaRevision,
            sourceFingerprint: null,
            joinedAtServerMs: input.nowMs,
            lastSeenServerMs: input.nowMs,
            disconnectedAtServerMs: null,
        };
        this.participants.set(participant.participantId, participant);
        return participant;
    }

    /**
     * Adds a guest.
     *
     * Two devices signed into the same Stremio account are two participants —
     * the room has no notion of account identity at all, which is what makes
     * plan section 11.4 hold by construction rather than by a rule.
     */
    join(input: {
        inviteSecret: string;
        displayName: string;
        deviceLabel: string | null;
        capabilities: PlayerCapabilities;
        nowMs: number;
    }): Participant {
        if (this.closed) {
            throw new ProtocolError('ROOM_NOT_FOUND', 'room is no longer available');
        }
        if (!secretsMatch(this.inviteSecret, input.inviteSecret)) {
            // Same code as a missing room, so probing cannot distinguish the two.
            throw new ProtocolError('ROOM_NOT_FOUND', 'room is no longer available');
        }
        if (this.participants.size >= this.options.maxParticipants) {
            throw new ProtocolError('ROOM_FULL', 'room has reached its participant limit');
        }
        this.touch(input.nowMs);
        return this.createParticipant({
            displayName: input.displayName,
            deviceLabel: input.deviceLabel,
            capabilities: input.capabilities,
            isHost: false,
            nowMs: input.nowMs,
        });
    }

    getParticipant(participantId: string): Participant | undefined {
        return this.participants.get(participantId);
    }

    requireParticipant(participantId: string): Participant {
        const participant = this.participants.get(participantId);
        if (participant === undefined) {
            throw new ProtocolError('NOT_IN_ROOM', 'participant is not a member of this room');
        }
        return participant;
    }

    listParticipants(): Participant[] {
        return [...this.participants.values()];
    }

    get participantCount(): number {
        return this.participants.size;
    }

    get connectedParticipantCount(): number {
        return this.listParticipants().filter((participant) => participant.connected).length;
    }

    removeParticipant(participantId: string, nowMs: number): boolean {
        const removed = this.participants.delete(participantId);
        if (removed) {
            this.touch(nowMs);
        }
        return removed;
    }

    markDisconnected(participantId: string, nowMs: number): void {
        const participant = this.participants.get(participantId);
        if (participant === undefined) {
            return;
        }
        participant.connected = false;
        participant.disconnectedAtServerMs = nowMs;
        participant.lastSeenServerMs = nowMs;
        // A disconnected participant cannot be synchronized, so it must not keep
        // satisfying a ready barrier for everyone else.
        participant.ready = false;
        if (participant.isHost) {
            this.hostDisconnectedAtServerMs = nowMs;
        }
    }

    markConnected(participantId: string, sessionId: string, nowMs: number): void {
        const participant = this.participants.get(participantId);
        if (participant === undefined) {
            return;
        }
        participant.connected = true;
        participant.sessionId = sessionId;
        participant.disconnectedAtServerMs = null;
        participant.lastSeenServerMs = nowMs;
        if (participant.isHost) {
            this.hostDisconnectedAtServerMs = null;
        }
        this.touch(nowMs);
    }

    /**
     * Re-reads a participant's capabilities on resume.
     *
     * They can legitimately change across a reload — switching to a cast device
     * is the obvious case — and `supported` must follow, otherwise a client that
     * lost a capability would keep counting toward the readiness barrier.
     */
    updateCapabilities(participantId: string, capabilities: PlayerCapabilities): void {
        const participant = this.participants.get(participantId);
        if (participant === undefined) {
            return;
        }
        participant.capabilities = capabilities;
        participant.supported = isSupportedClient(capabilities);
        if (!participant.supported) {
            participant.ready = false;
        }
    }

    updateReadiness(
        participantId: string,
        input: {
            ready: boolean;
            loaded: boolean;
            buffering: boolean;
            durationMs: number | null;
            mediaRevision: number;
            sourceFingerprint: string | null;
        },
        nowMs: number,
    ): Participant {
        const participant = this.requireParticipant(participantId);
        participant.loaded = input.loaded;
        participant.buffering = input.buffering;
        participant.durationMs = input.durationMs;
        participant.mediaRevision = input.mediaRevision;
        participant.sourceFingerprint = input.sourceFingerprint;
        // Readiness is only meaningful for the current media revision, and an
        // unsupported client never claims to be synchronized.
        participant.ready = input.ready && input.mediaRevision === this.mediaRevision && participant.supported;
        participant.lastSeenServerMs = nowMs;
        this.touch(nowMs);
        return participant;
    }

    get hostParticipant(): Participant | undefined {
        return this.participants.get(this.hostParticipantId);
    }

    /**
     * Whether the readiness barrier permits starting playback.
     *
     * `requireAllReadyToStart` gates only the *first* start of a media revision
     * (plan section 6.1). Once the room has played, a guest that reconnects or
     * rebuffers must never be able to stop the host from resuming — it catches
     * up through drift correction instead (plan section 10).
     */
    canStartPlayback(): boolean {
        const host = this.hostParticipant;
        if (host === undefined || !host.ready) {
            return false;
        }
        if (!this.policy.requireAllReadyToStart || this.hasStartedCurrentMedia) {
            return true;
        }
        return this.listParticipants().every(
            (participant) => !participant.connected || !participant.supported || participant.ready,
        );
    }

    /** Duration the room trusts for clamping: the host's, when it knows one. */
    get durationMs(): number | null {
        return this.hostParticipant?.durationMs ?? this.media.expectedDurationMs;
    }

    applyHostCommand(participantId: string, command: PlaybackCommand, nowMs: number): ApplyCommandResult {
        if (participantId !== this.hostParticipantId) {
            throw new ProtocolError('NOT_HOST', 'only the host can change playback');
        }
        const host = this.requireParticipant(participantId);
        if (!host.supported) {
            throw new ProtocolError('CAPABILITY_REQUIRED', 'host client lacks a required capability');
        }
        // Staleness is checked before the readiness barrier: a command aimed at
        // a previous episode should be reported as stale, not as "not ready",
        // otherwise the client would retry instead of resynchronizing.
        if (this.commandHistory.has(command.commandId)) {
            return { outcome: 'duplicate', state: this.playback };
        }
        if (command.mediaRevision !== this.playback.mediaRevision) {
            throw new ProtocolError('STALE_MEDIA_REVISION', 'command targets a different media revision', {
                details: { expected: this.playback.mediaRevision, received: command.mediaRevision },
            });
        }
        if (command.action === 'play' && !this.canStartPlayback()) {
            throw new ProtocolError('READINESS_BARRIER', 'the room readiness barrier has not been satisfied');
        }

        const result = applyPlaybackCommand(this.playback, command, {
            nowMs,
            durationMs: this.durationMs,
            defaultLeadMs: this.options.defaultLeadMs,
            lastServerInitiatedRevision: this.lastServerInitiatedRevision,
            appliedCommandIds: this.commandHistory.asSet(),
        });

        if (result.outcome === 'applied') {
            this.playback = result.state;
            this.commandHistory.add(command.commandId);
            // Any deliberate timeline change invalidates progress measured
            // against the previous position.
            this.resetHostProgressTracking();
            this.pauseReason = null;
            if (command.action === 'play') {
                this.hasStartedCurrentMedia = true;
            }
            this.touch(nowMs);
        }
        return result;
    }

    /**
     * Freezes a running room when a supported participant reports sustained
     * buffering. Short blips are filtered by the client before they reach here.
     *
     * The host always gates the room because it is the reference playback. A
     * guest gates it only when the room policy opts in.
     */
    pauseForBuffering(participantId: string, nowMs: number): HostObservationResult {
        const unchanged: HostObservationResult = { changed: false, reason: null };
        const participant = this.participants.get(participantId);
        if (
            participant === undefined ||
            !participant.connected ||
            !participant.supported ||
            !participant.buffering ||
            participant.mediaRevision !== this.mediaRevision ||
            this.playback.paused ||
            (!participant.isHost && !this.policy.pauseOnGuestBuffering)
        ) {
            return unchanged;
        }

        this.playback = freezePlayback(this.playback, nowMs, this.durationMs);
        this.lastServerInitiatedRevision = this.playback.revision;
        this.pauseReason = 'participant_buffering';
        this.resetHostProgressTracking();
        this.touch(nowMs);
        return { changed: true, reason: 'participant_buffering' };
    }

    /**
     * Moves the room to a new media revision.
     *
     * Readiness resets for everyone, and playback restarts paused, so a stale
     * `media.changed` cannot leave a guest playing the previous episode.
     */
    changeMedia(
        participantId: string,
        input: { mediaChangeId: string; media: MediaDescriptor; source: SourceBundle },
        nowMs: number,
    ): { changed: boolean } {
        if (participantId !== this.hostParticipantId) {
            throw new ProtocolError('NOT_HOST', 'only the host can change media');
        }
        if (this.appliedMediaChangeIds.has(input.mediaChangeId)) {
            return { changed: false };
        }
        if (input.media.live) {
            throw new ProtocolError('UNSUPPORTED_MEDIA', 'live media has no stable timeline and cannot be synchronized');
        }

        this.appliedMediaChangeIds.add(input.mediaChangeId);
        this.mediaRevision += 1;
        this.hasStartedCurrentMedia = false;
        this.resetHostProgressTracking();
        this.pauseReason = null;
        this.media = input.media;
        this.source = input.source;
        this.commandHistory.clear();
        this.playback = resetPlaybackForMedia(this.playback, {
            nowMs,
            mediaRevision: this.mediaRevision,
            positionMs: 0,
            durationMs: input.media.expectedDurationMs,
        });
        this.lastServerInitiatedRevision = this.playback.revision;
        for (const participant of this.participants.values()) {
            participant.ready = false;
            participant.loaded = false;
            participant.buffering = false;
            participant.durationMs = null;
            participant.sourceFingerprint = null;
        }
        this.touch(nowMs);
        return { changed: true };
    }

    /**
     * Rebases canonical position from a periodic host observation.
     *
     * The host is the reference clock, so its own natural drift is what the room
     * should follow. Two guards keep this from doing damage: a pending scheduled
     * transition is never cancelled, and an observation whose `paused` or `rate`
     * disagrees with canonical state is ignored rather than adopted — a
     * transient host rebuffer must not flip the whole room's play state. The
     * host issues an explicit command when it really means to change state.
     *
     * Returns true when canonical state changed and should be broadcast.
     */
    applyHostObservation(
        participantId: string,
        observation: { positionMs: number; paused: boolean; rate: number; mediaRevision: number },
        nowMs: number,
        toleranceMs: number,
        stallGraceMs: number = 0,
    ): HostObservationResult {
        const unchanged: HostObservationResult = { changed: false, reason: null };
        if (participantId !== this.hostParticipantId) {
            return unchanged;
        }
        if (observation.mediaRevision !== this.mediaRevision) {
            return unchanged;
        }
        if (nowMs < this.playback.effectiveAtServerMs) {
            return unchanged;
        }
        if (observation.paused !== this.playback.paused || observation.rate !== this.playback.rate) {
            return unchanged;
        }

        if (this.playback.paused) {
            // Nothing to measure progress against while stopped.
            this.resetHostProgressTracking();
            this.touch(nowMs);
            return unchanged;
        }

        const stalled = this.trackHostProgress(observation.positionMs, nowMs);

        if (
            stalled &&
            this.policy.pauseOnHostStall &&
            this.hostStalledSinceServerMs !== null &&
            nowMs - this.hostStalledSinceServerMs > stallGraceMs
        ) {
            // Pause where the host actually is, not where the room had reached.
            // That is the position it has data for, so resuming does not ask it
            // to buffer all over again, and it is a single deliberate move
            // rather than the repeated backwards nudges that caused a sawtooth.
            this.playback = {
                revision: this.playback.revision + 1,
                mediaRevision: this.playback.mediaRevision,
                paused: true,
                positionMs: clampPositionMs(observation.positionMs, this.durationMs),
                rate: this.playback.rate,
                updatedAtServerMs: nowMs,
                effectiveAtServerMs: nowMs,
            };
            this.lastServerInitiatedRevision = this.playback.revision;
            this.pauseReason = 'host_stalled';
            this.resetHostProgressTracking();
            this.touch(nowMs);
            return { changed: true, reason: 'host_stalled' };
        }

        const canonicalPositionMs = positionAtServerMs(this.playback, nowMs, this.durationMs);
        const deltaMs = observation.positionMs - canonicalPositionMs;
        if (Math.abs(deltaMs) <= toleranceMs) {
            this.touch(nowMs);
            return unchanged;
        }
        if (deltaMs < 0) {
            // The host is *behind* the room. That means its own playback stalled
            // — after a seek, while it rebuffers — not that the room is in the
            // wrong place.
            //
            // Rewinding canonical to meet it would drag every other participant
            // backwards, and because they keep playing forward they would run
            // ahead again before the next observation, get yanked back, and
            // repeat: a sawtooth that never settles while the host is stalled.
            // Worse, canonical would track the stalled host closely enough that
            // everyone still looks synchronized while nobody is watching
            // anything.
            //
            // Backwards motion is what an explicit seek command, or the stall
            // pause above, is for.
            this.touch(nowMs);
            return unchanged;
        }
        this.playback = {
            revision: this.playback.revision + 1,
            mediaRevision: this.playback.mediaRevision,
            paused: this.playback.paused,
            positionMs: clampPositionMs(observation.positionMs, this.durationMs),
            rate: this.playback.rate,
            updatedAtServerMs: nowMs,
            effectiveAtServerMs: nowMs,
        };
        this.touch(nowMs);
        return { changed: true, reason: null };
    }

    /**
     * Records how far the host advanced since the previous observation and
     * returns whether it is failing to keep up.
     *
     * Deliberately measured from position rather than the reported buffering
     * flag: browsers report a healthy playing element as buffering for some
     * sources, so that flag cannot distinguish a stall from normal playback. A
     * position that does not advance can.
     */
    private trackHostProgress(positionMs: number, nowMs: number): boolean {
        const previous = this.lastHostObservation;
        this.lastHostObservation = { positionMs, atServerMs: nowMs };
        if (previous === null) {
            return false;
        }
        const elapsedMs = nowMs - previous.atServerMs;
        if (elapsedMs < MIN_STALL_SAMPLE_MS) {
            // Too short a window to tell playback apart from jitter.
            return this.hostStalledSinceServerMs !== null;
        }
        const advancedMs = positionMs - previous.positionMs;
        const expectedMs = elapsedMs * this.playback.rate;
        if (advancedMs >= expectedMs * STALL_PROGRESS_RATIO) {
            this.hostStalledSinceServerMs = null;
            return false;
        }
        if (this.hostStalledSinceServerMs === null) {
            // Date the stall from the start of the window in which it happened.
            this.hostStalledSinceServerMs = previous.atServerMs;
        }
        return true;
    }

    private resetHostProgressTracking(): void {
        this.lastHostObservation = null;
        this.hostStalledSinceServerMs = null;
    }

    /** Replaces the source bundle without changing media identity or readiness. */
    refreshSource(participantId: string, source: SourceBundle, nowMs: number): void {
        if (participantId !== this.hostParticipantId) {
            throw new ProtocolError('NOT_HOST', 'only the host can refresh the source');
        }
        this.source = source;
        this.touch(nowMs);
    }

    /**
     * Freezes playback after the host has been gone longer than the grace period.
     * Returns true when the state actually changed.
     */
    freezeForHostGrace(nowMs: number): boolean {
        if (this.hostDisconnectedAtServerMs === null || this.playback.paused) {
            return false;
        }
        if (nowMs - this.hostDisconnectedAtServerMs < this.options.hostGraceMs) {
            return false;
        }
        this.playback = freezePlayback(this.playback, nowMs, this.durationMs);
        this.lastServerInitiatedRevision = this.playback.revision;
        return true;
    }

    touch(nowMs: number): void {
        this.lastActivityServerMs = nowMs;
    }

    isExpired(nowMs: number, idleTtlMs: number): boolean {
        if (this.closed) {
            return true;
        }
        if (nowMs >= this.expiresAtServerMs) {
            return true;
        }
        return this.connectedParticipantCount === 0 && nowMs - this.lastActivityServerMs >= idleTtlMs;
    }

    close(reason: RoomCloseReason): void {
        this.closed = true;
        this.closeReason = reason;
    }

    /** Server-authoritative position right now, for observation/drift metrics. */
    canonicalPositionMs(nowMs: number): number {
        return positionAtServerMs(this.playback, nowMs, this.durationMs);
    }

    toParticipantPublic(participant: Participant): ParticipantPublic {
        return {
            participantId: participant.participantId,
            displayName: participant.displayName,
            deviceLabel: participant.deviceLabel,
            isHost: participant.isHost,
            connected: participant.connected,
            ready: participant.ready,
            loaded: participant.loaded,
            buffering: participant.buffering,
            durationMs: participant.durationMs,
            mediaRevision: participant.mediaRevision,
            sourceFingerprint: participant.sourceFingerprint,
            capabilities: participant.capabilities,
            supported: participant.supported,
            joinedAtServerMs: participant.joinedAtServerMs,
            lastSeenServerMs: participant.lastSeenServerMs,
        };
    }

    /**
     * Full room state for a member.
     *
     * The invitation secret is deliberately absent: it is delivered once, to the
     * host, in the `room.created` response.
     */
    toSnapshot(nowMs: number): RoomSnapshot {
        return {
            roomId: this.roomId,
            hostParticipantId: this.hostParticipantId,
            createdAtServerMs: this.createdAtServerMs,
            expiresAtServerMs: this.expiresAtServerMs,
            revision: this.playback.revision,
            mediaRevision: this.mediaRevision,
            media: this.media,
            source: this.source,
            playback: this.playback,
            participants: this.listParticipants().map((participant) => this.toParticipantPublic(participant)),
            policy: this.policy,
            serverTimeMs: nowMs,
        };
    }
}
