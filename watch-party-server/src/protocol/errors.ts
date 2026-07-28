// Copyright (C) 2017-2026 Smart code 203358507

/**
 * Machine-readable protocol error codes.
 *
 * Clients branch on `code`; `message` is developer-facing only and must never be
 * rendered as interface copy. Room lookup failures deliberately collapse to
 * `ROOM_NOT_FOUND` so that invitation guessing cannot be distinguished from an
 * expired room (plan section 13).
 */
export const ERROR_CODES = [
    'MALFORMED_MESSAGE',
    'MESSAGE_TOO_LARGE',
    'UNSUPPORTED_PROTOCOL_VERSION',
    'UNKNOWN_MESSAGE_TYPE',
    'VALIDATION_FAILED',
    'HANDSHAKE_REQUIRED',
    'ALREADY_HANDSHAKEN',
    'RESUME_REJECTED',
    'ROOM_NOT_FOUND',
    'ROOM_FULL',
    'ROOM_LIMIT_REACHED',
    'ALREADY_IN_ROOM',
    'NOT_IN_ROOM',
    'NOT_HOST',
    'READINESS_BARRIER',
    'STALE_REVISION',
    'STALE_MEDIA_REVISION',
    'CAPABILITY_REQUIRED',
    'RATE_LIMITED',
    'UNSUPPORTED_MEDIA',
    'SERVER_SHUTTING_DOWN',
    'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Close codes in the 4000-4999 application range. */
export const CLOSE_CODES = {
    NORMAL: 1000,
    GOING_AWAY: 1001,
    POLICY_VIOLATION: 1008,
    MESSAGE_TOO_LARGE: 1009,
    PROTOCOL_ERROR: 4000,
    UNSUPPORTED_VERSION: 4001,
    TOO_MANY_INVALID_MESSAGES: 4002,
    ROOM_CLOSED: 4003,
    REPLACED_BY_RESUME: 4004,
    SHUTTING_DOWN: 4005,
} as const;

export class ProtocolError extends Error {
    readonly code: ErrorCode;
    /** Small, non-sensitive hints echoed back to the client. */
    readonly details: Record<string, string | number | boolean> | undefined;
    /** When set, the connection is closed after the error frame is written. */
    readonly closeCode: number | undefined;

    constructor(
        code: ErrorCode,
        message: string,
        options?: { details?: Record<string, string | number | boolean>; closeCode?: number },
    ) {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
        this.details = options?.details;
        this.closeCode = options?.closeCode;
    }
}

export const isProtocolError = (value: unknown): value is ProtocolError =>
    value instanceof ProtocolError;
