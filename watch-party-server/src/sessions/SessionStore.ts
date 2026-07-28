// Copyright (C) 2017-2026 Smart code 203358507

import { ProtocolError } from '../protocol/errors.ts';
import type { PlayerCapabilities } from '../protocol/types.ts';
import { generateResumeToken, generateSessionId } from '../rooms/ids.ts';
import { hashResumeToken, resumeTokenMatches } from './ResumeToken.ts';

/**
 * Sessions bind a socket to a room participant.
 *
 * A session — not a Stremio account — is the unit of identity. Two devices
 * signed into the same account hold two sessions and remain two participants
 * (plan section 11.4).
 */

export type SessionRecord = {
    sessionId: string;
    resumeTokenHash: string;
    clientVersion: string;
    capabilities: PlayerCapabilities;
    roomId: string | null;
    participantId: string | null;
    connected: boolean;
    createdAtServerMs: number;
    lastSeenServerMs: number;
    /** Set when the socket drops; the session is reclaimable until this time. */
    resumableUntilServerMs: number | null;
};

export type CreatedSession = {
    record: SessionRecord;
    /** Plaintext resume token, returned to the client exactly once. */
    resumeToken: string;
};

export class SessionStore {
    private readonly sessions = new Map<string, SessionRecord>();
    private readonly resumeGraceMs: number;

    constructor(options: { resumeGraceMs: number }) {
        this.resumeGraceMs = options.resumeGraceMs;
    }

    get size(): number {
        return this.sessions.size;
    }

    create(input: { clientVersion: string; capabilities: PlayerCapabilities; nowMs: number }): CreatedSession {
        const resumeToken = generateResumeToken();
        const record: SessionRecord = {
            sessionId: generateSessionId(),
            resumeTokenHash: hashResumeToken(resumeToken),
            clientVersion: input.clientVersion,
            capabilities: input.capabilities,
            roomId: null,
            participantId: null,
            connected: true,
            createdAtServerMs: input.nowMs,
            lastSeenServerMs: input.nowMs,
            resumableUntilServerMs: null,
        };
        this.sessions.set(record.sessionId, record);
        return { record, resumeToken };
    }

    get(sessionId: string): SessionRecord | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Reclaims a disconnected session.
     *
     * Every failure returns the same `RESUME_REJECTED` code: distinguishing
     * "unknown session" from "wrong token" would let a caller enumerate live
     * sessions. An already-connected session is refused too, so a stolen token
     * cannot displace the participant currently holding it.
     */
    resume(input: { sessionId: string; resumeToken: string; nowMs: number }): SessionRecord {
        const record = this.sessions.get(input.sessionId);
        const rejected = new ProtocolError('RESUME_REJECTED', 'session cannot be resumed');
        if (record === undefined) {
            throw rejected;
        }
        if (!resumeTokenMatches(record.resumeTokenHash, input.resumeToken)) {
            throw rejected;
        }
        if (record.connected) {
            throw rejected;
        }
        if (record.resumableUntilServerMs !== null && input.nowMs > record.resumableUntilServerMs) {
            this.sessions.delete(record.sessionId);
            throw rejected;
        }
        record.connected = true;
        record.resumableUntilServerMs = null;
        record.lastSeenServerMs = input.nowMs;
        return record;
    }

    markDisconnected(sessionId: string, nowMs: number): SessionRecord | undefined {
        const record = this.sessions.get(sessionId);
        if (record === undefined) {
            return undefined;
        }
        record.connected = false;
        record.lastSeenServerMs = nowMs;
        record.resumableUntilServerMs = nowMs + this.resumeGraceMs;
        return record;
    }

    touch(sessionId: string, nowMs: number): void {
        const record = this.sessions.get(sessionId);
        if (record !== undefined) {
            record.lastSeenServerMs = nowMs;
        }
    }

    delete(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    /** Drops sessions whose resume window has closed. Returns the dropped records. */
    sweep(nowMs: number): SessionRecord[] {
        const expired: SessionRecord[] = [];
        for (const record of this.sessions.values()) {
            if (
                !record.connected &&
                record.resumableUntilServerMs !== null &&
                nowMs > record.resumableUntilServerMs
            ) {
                expired.push(record);
            }
        }
        for (const record of expired) {
            this.sessions.delete(record.sessionId);
        }
        return expired;
    }

    /** All sessions currently bound to a room, for broadcast and cleanup. */
    listForRoom(roomId: string): SessionRecord[] {
        return [...this.sessions.values()].filter((record) => record.roomId === roomId);
    }
}
