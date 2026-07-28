// Copyright (C) 2017-2026 Smart code 203358507

import { ProtocolError, CLOSE_CODES } from './errors.ts';
import { MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION, type Envelope } from './types.ts';
import { object, optional, string, integer, jsonValue } from './validate.ts';

/**
 * Envelope framing.
 *
 * Version and type are checked before the payload so a client on an
 * incompatible build gets `UNSUPPORTED_PROTOCOL_VERSION` rather than a
 * confusing field-level validation error (plan section 14).
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const envelopeValidator = object({
    v: integer({ min: 0, max: 1_000_000 }),
    type: string({ min: 1, max: 64, pattern: /^[a-z]+(\.[a-z]+)+$/ }),
    requestId: optional(string({ min: 1, max: 64, pattern: ID_PATTERN })),
    roomId: optional(string({ min: 1, max: 64, pattern: ID_PATTERN })),
    payload: jsonValue({ maxDepth: 10, maxKeys: 512 }),
});

export type ParsedEnvelope = Envelope<string, Record<string, unknown>>;

/**
 * Parses a raw frame into an envelope.
 *
 * `maxBytes` is enforced here as well as at the socket layer, because the socket
 * limit counts bytes while a caller may hand us an already-decoded string.
 */
export const parseEnvelope = (raw: string, options: { maxBytes: number }): ParsedEnvelope => {
    if (Buffer.byteLength(raw, 'utf8') > options.maxBytes) {
        throw new ProtocolError('MESSAGE_TOO_LARGE', `message exceeds ${options.maxBytes} bytes`, {
            closeCode: CLOSE_CODES.MESSAGE_TOO_LARGE,
        });
    }

    let decoded: unknown;
    try {
        decoded = JSON.parse(raw);
    } catch {
        throw new ProtocolError('MALFORMED_MESSAGE', 'message is not valid JSON');
    }

    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        throw new ProtocolError('MALFORMED_MESSAGE', 'message must be a JSON object');
    }

    const version = (decoded as { v?: unknown }).v;
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
        throw new ProtocolError('MALFORMED_MESSAGE', 'message is missing an integer protocol version "v"');
    }
    if (version < MIN_SUPPORTED_PROTOCOL_VERSION || version > PROTOCOL_VERSION) {
        throw new ProtocolError('UNSUPPORTED_PROTOCOL_VERSION', `protocol version ${version} is not supported`, {
            details: { min: MIN_SUPPORTED_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
            closeCode: CLOSE_CODES.UNSUPPORTED_VERSION,
        });
    }

    const parsed = envelopeValidator(decoded, '');
    const payload = parsed.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new ProtocolError('MALFORMED_MESSAGE', 'payload must be a JSON object');
    }

    return {
        v: parsed.v,
        type: parsed.type,
        ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
        ...(parsed.roomId === undefined ? {} : { roomId: parsed.roomId }),
        payload: payload as Record<string, unknown>,
    };
};

export const serializeEnvelope = <TPayload>(
    type: string,
    payload: TPayload,
    options: { requestId?: string | undefined; roomId?: string | undefined } = {},
): string =>
    JSON.stringify({
        v: PROTOCOL_VERSION,
        type,
        ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
        ...(options.roomId === undefined ? {} : { roomId: options.roomId }),
        payload,
    });
