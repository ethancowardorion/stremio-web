// Copyright (C) 2017-2026 Smart code 203358507

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Resume tokens are stored hashed.
 *
 * The plaintext token is handed to the client once, in `session.welcome`, and
 * never kept: a memory dump or an accidental snapshot of the session table then
 * cannot be replayed to take over a participant.
 */

export const hashResumeToken = (token: string): string =>
    createHash('sha256').update(token, 'utf8').digest('base64url');

export const resumeTokenMatches = (storedHash: string, presentedToken: string): boolean => {
    const expected = Buffer.from(storedHash, 'utf8');
    const received = Buffer.from(hashResumeToken(presentedToken), 'utf8');
    if (expected.length !== received.length) {
        return false;
    }
    return timingSafeEqual(expected, received);
};
