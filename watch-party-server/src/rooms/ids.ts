// Copyright (C) 2017-2026 Smart code 203358507

import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Identifier and secret generation.
 *
 * The room id and the invitation secret are separate values (plan section 13):
 * the id appears in logs, metrics and error messages, the secret never does.
 * Knowing an id must not be enough to join.
 */

/** 96 bits: enough that ids do not collide, short enough to appear in a URL. */
const ROOM_ID_BYTES = 12;

/** 192 bits, comfortably above the 128-bit minimum the plan requires. */
const INVITE_SECRET_BYTES = 24;

const PARTICIPANT_ID_BYTES = 12;
const SESSION_ID_BYTES = 12;
const RESUME_TOKEN_BYTES = 32;

const token = (bytes: number): string => randomBytes(bytes).toString('base64url');

export const generateRoomId = (): string => token(ROOM_ID_BYTES);
export const generateInviteSecret = (): string => token(INVITE_SECRET_BYTES);
export const generateParticipantId = (): string => token(PARTICIPANT_ID_BYTES);
export const generateSessionId = (): string => token(SESSION_ID_BYTES);
export const generateResumeToken = (): string => token(RESUME_TOKEN_BYTES);

/**
 * Constant-time secret comparison.
 *
 * Length is compared first because `timingSafeEqual` throws on mismatched
 * lengths; that leaks only the length, which is fixed for our tokens anyway.
 */
export const secretsMatch = (expected: string, received: string): boolean => {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(received, 'utf8');
    if (expectedBuffer.length !== receivedBuffer.length) {
        return false;
    }
    return timingSafeEqual(expectedBuffer, receivedBuffer);
};
