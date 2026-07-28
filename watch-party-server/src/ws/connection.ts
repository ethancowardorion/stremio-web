// Copyright (C) 2017-2026 Smart code 203358507

import type { WebSocket } from 'ws';
import type { Config } from '../config.ts';
import { serializeEnvelope } from '../protocol/envelopes.ts';
import type { ErrorCode } from '../protocol/errors.ts';
import { TokenBucket } from './rateLimit.ts';

/**
 * One client socket.
 *
 * The service talks to this interface rather than to `ws` directly, so the
 * protocol logic is testable without a socket and a future transport swap stays
 * local to this file.
 */

export type RateBucketName = 'clock' | 'status' | 'command';

export type Connection = {
    readonly connectionId: string;
    readonly remoteAddress: string;
    sessionId: string | null;
    invalidMessages: number;
    isOpen(): boolean;
    send(type: string, payload: unknown, options?: { requestId?: string | undefined; roomId?: string | undefined }): void;
    sendError(
        code: ErrorCode,
        message: string,
        options?: { requestId?: string | undefined; details?: Record<string, string | number | boolean> | undefined },
    ): void;
    close(code: number, reason: string): void;
    consume(bucket: RateBucketName, nowMs: number): boolean;
};

let connectionCounter = 0;

const nextConnectionId = (): string => {
    connectionCounter = (connectionCounter + 1) % Number.MAX_SAFE_INTEGER;
    return `c${connectionCounter.toString(36)}`;
};

export const createConnection = (socket: WebSocket, options: {
    config: Config;
    remoteAddress: string;
    nowMs: number;
}): Connection => {
    const { rateLimits } = options.config;
    const buckets: Record<RateBucketName, TokenBucket> = {
        clock: new TokenBucket(rateLimits.clockPingPerSec, rateLimits.clockPingBurst, options.nowMs),
        status: new TokenBucket(rateLimits.statusPerSec, rateLimits.statusBurst, options.nowMs),
        command: new TokenBucket(rateLimits.commandPerSec, rateLimits.commandBurst, options.nowMs),
    };

    const connection: Connection = {
        connectionId: nextConnectionId(),
        remoteAddress: options.remoteAddress,
        sessionId: null,
        invalidMessages: 0,
        isOpen: () => socket.readyState === socket.OPEN,
        send(type, payload, sendOptions) {
            if (socket.readyState !== socket.OPEN) {
                return;
            }
            socket.send(serializeEnvelope(type, payload, sendOptions ?? {}));
        },
        sendError(code, message, errorOptions) {
            connection.send(
                'error',
                {
                    code,
                    // Developer-facing only; clients render copy from the code.
                    message,
                    ...(errorOptions?.details === undefined ? {} : { details: errorOptions.details }),
                },
                { requestId: errorOptions?.requestId },
            );
        },
        close(code, reason) {
            try {
                socket.close(code, reason);
            } catch {
                socket.terminate();
            }
        },
        consume(bucket, nowMs) {
            return buckets[bucket].tryConsume(nowMs);
        },
    };

    return connection;
};
