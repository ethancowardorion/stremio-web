// Copyright (C) 2017-2026 Smart code 203358507

import type { IncomingMessage } from 'node:http';

/**
 * WebSocket upgrade admission checks.
 *
 * These run before a socket is accepted, so a rejected origin never reaches the
 * protocol layer at all.
 */

export const WS_PATH = '/v1/ws';

export type UpgradeRejection = 'bad_path' | 'bad_origin' | 'rate_limited';

export type UpgradeDecision = { allowed: true } | { allowed: false; reason: UpgradeRejection };

/**
 * Origin allowlist.
 *
 * A browser always sends `Origin`. Non-browser clients (tests, health probes)
 * may omit it, and that is allowed — the invitation secret, not the origin, is
 * what authorizes joining a room. An origin that is *present but not allowed*
 * is always rejected, which is what stops a hostile page from driving a user's
 * session.
 */
export const isOriginAllowed = (origin: string | undefined, allowedOrigins: readonly string[]): boolean => {
    if (origin === undefined || origin === '') {
        return true;
    }
    if (allowedOrigins.includes('*')) {
        return true;
    }
    if (allowedOrigins.length === 0) {
        return false;
    }
    // Compare normalized origins so a trailing slash in configuration does not
    // silently reject every request.
    const normalize = (value: string): string => {
        try {
            return new URL(value).origin;
        } catch {
            return value.replace(/\/+$/, '');
        }
    };
    const normalizedOrigin = normalize(origin);
    return allowedOrigins.some((allowed) => normalize(allowed) === normalizedOrigin);
};

export const requestPath = (request: IncomingMessage): string => {
    const url = request.url ?? '/';
    const queryIndex = url.indexOf('?');
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
};

/**
 * Resolves the client address used for per-IP limits.
 *
 * `X-Forwarded-For` is honoured only when the operator has declared a trusted
 * proxy, otherwise any client could spoof its own rate-limit bucket.
 */
export const clientAddress = (request: IncomingMessage, trustProxy: boolean): string => {
    if (trustProxy) {
        const forwarded = request.headers['x-forwarded-for'];
        const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        const first = raw?.split(',')[0]?.trim();
        if (first !== undefined && first.length > 0) {
            return first;
        }
    }
    return request.socket.remoteAddress ?? 'unknown';
};

export const evaluateUpgrade = (
    request: IncomingMessage,
    options: { allowedOrigins: readonly string[]; allowConnection: (address: string) => boolean; trustProxy: boolean },
): UpgradeDecision => {
    if (requestPath(request) !== WS_PATH) {
        return { allowed: false, reason: 'bad_path' };
    }
    const origin = request.headers.origin;
    if (!isOriginAllowed(Array.isArray(origin) ? origin[0] : origin, options.allowedOrigins)) {
        return { allowed: false, reason: 'bad_origin' };
    }
    if (!options.allowConnection(clientAddress(request, options.trustProxy))) {
        return { allowed: false, reason: 'rate_limited' };
    }
    return { allowed: true };
};
