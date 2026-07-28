// Copyright (C) 2017-2026 Smart code 203358507

import { ProtocolError } from './errors.ts';
import {
    CLIENT_MESSAGE_TYPES,
    PLAYBACK_ACTIONS,
    SOURCE_KINDS,
    type ClientMessageType,
} from './types.ts';
import {
    arrayOf,
    boolean,
    displayName,
    enumeration,
    finiteNumber,
    integer,
    jsonValue,
    nullable,
    object,
    optional,
    string,
    withDefault,
    type Validator,
} from './validate.ts';

/**
 * Payload schemas for every client message.
 *
 * Unknown fields are rejected by `object`, so an older server refuses a newer
 * client's extra field loudly instead of ignoring behaviour it does not
 * implement.
 */

/** 30 days: comfortably beyond any real title, far below unsafe integer range. */
const MAX_POSITION_MS = 30 * 24 * 60 * 60 * 1000;

const MIN_RATE = 0.25;
const MAX_RATE = 4;

/** Upper bound on how far ahead a host may schedule a transition. */
const MAX_LEAD_MS = 5000;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const idString = () => string({ min: 1, max: 64, pattern: ID_PATTERN });

const positionMs = () => integer({ min: 0, max: MAX_POSITION_MS });

const rate = () => finiteNumber({ min: MIN_RATE, max: MAX_RATE });

const capabilities = () =>
    object({
        scheduledActions: boolean(),
        observeBuffering: boolean(),
        setPlaybackRate: boolean(),
        navigateNext: boolean(),
        playerImplementation: string({ min: 1, max: 64 }),
    });

const media = () =>
    object({
        type: nullable(string({ min: 1, max: 64 })),
        metaId: nullable(string({ min: 1, max: 512 })),
        videoId: nullable(string({ min: 1, max: 512 })),
        title: nullable(string({ min: 1, max: 300 })),
        expectedDurationMs: nullable(positionMs()),
        live: boolean(),
    });

/**
 * The exact-source bundle.
 *
 * `stream` is opaque and bounded rather than typed, because add-ons define its
 * shape. `authKey` is accepted by design for this self-hosted deployment and is
 * redacted everywhere it could reach observability (plan sections 11.2 and 13).
 */
const source = () =>
    object({
        streamParam: string({ min: 1, max: 64 * 1024 }),
        stream: nullable(jsonValue({ maxDepth: 8, maxBytes: 64 * 1024 })),
        streamTransportUrl: nullable(string({ min: 1, max: 4096 })),
        metaTransportUrl: nullable(string({ min: 1, max: 4096 })),
        playerPath: nullable(string({ min: 1, max: 96 * 1024 })),
        kind: enumeration(SOURCE_KINDS),
        fingerprint: string({ min: 1, max: 256 }),
        authKey: nullable(string({ min: 1, max: 1024 })),
    });

const observation = () =>
    object({
        positionMs: positionMs(),
        paused: boolean(),
        rate: rate(),
        buffering: boolean(),
        durationMs: nullable(positionMs()),
        mediaRevision: integer({ min: 0, max: 1_000_000 }),
    });

const policy = () =>
    object({
        // Optional so a client may send a subset; the room fills in defaults.
        allowGuestPlayPause: optional(boolean()),
        requireAllReadyToStart: optional(boolean()),
        pauseOnGuestBuffering: optional(boolean()),
        pauseOnHostStall: optional(boolean()),
    });

export type ClientMessageSchemaOptions = {
    maxDisplayNameLength: number;
};

/**
 * Builds the schema table. It is a factory because a few bounds (display name
 * length) are operator-configurable.
 */
export const createClientMessageSchemas = (options: ClientMessageSchemaOptions) => {
    const name = () => displayName(options.maxDisplayNameLength);
    const deviceLabel = () => nullable(displayName(options.maxDisplayNameLength));

    return {
        'session.hello': object({
            protocolVersion: integer({ min: 0, max: 1_000_000 }),
            clientVersion: string({ min: 1, max: 64 }),
            capabilities: capabilities(),
            resume: optional(
                object({
                    sessionId: idString(),
                    resumeToken: string({ min: 16, max: 128 }),
                }),
            ),
        }),
        'clock.ping': object({
            nonce: string({ min: 1, max: 64, pattern: ID_PATTERN }),
            clientSentMs: integer({ min: 0 }),
        }),
        'room.create': object({
            displayName: name(),
            deviceLabel: withDefault(deviceLabel(), () => null),
            media: media(),
            source: source(),
            observation: observation(),
            policy: optional(policy()),
        }),
        'room.join': object({
            roomId: idString(),
            inviteSecret: string({ min: 16, max: 128 }),
            displayName: name(),
            deviceLabel: withDefault(deviceLabel(), () => null),
        }),
        'room.leave': object({}),
        'room.close': object({}),
        'room.reset': object({}),
        'room.policy.update': object({
            policy: policy(),
        }),
        'participant.ready': object({
            ready: boolean(),
            loaded: boolean(),
            buffering: boolean(),
            durationMs: nullable(positionMs()),
            mediaRevision: integer({ min: 0, max: 1_000_000 }),
            sourceFingerprint: nullable(string({ min: 1, max: 256 })),
        }),
        'playback.command': object({
            commandId: idString(),
            action: enumeration(PLAYBACK_ACTIONS),
            expectedRevision: integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
            mediaRevision: integer({ min: 0, max: 1_000_000 }),
            positionMs: optional(positionMs()),
            rate: optional(rate()),
            leadMs: optional(integer({ min: 0, max: MAX_LEAD_MS })),
        }),
        'playback.observation': observation(),
        'media.change': object({
            mediaChangeId: idString(),
            media: media(),
            source: source(),
        }),
        'source.refresh': object({
            source: source(),
        }),
    } satisfies Record<ClientMessageType, Validator<unknown>>;
};

export type ClientMessageSchemas = ReturnType<typeof createClientMessageSchemas>;

export type ClientMessagePayload<T extends ClientMessageType> = ReturnType<ClientMessageSchemas[T]>;

const CLIENT_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(CLIENT_MESSAGE_TYPES);

export const isClientMessageType = (type: string): type is ClientMessageType =>
    CLIENT_MESSAGE_TYPE_SET.has(type);

/**
 * Validates a payload for a known message type, or reports the type as unknown.
 * Callers get a discriminated result rather than an `any`.
 */
export const validateClientMessage = <T extends ClientMessageType>(
    schemas: ClientMessageSchemas,
    type: T,
    payload: unknown,
): ClientMessagePayload<T> => {
    const schema = schemas[type];
    if (schema === undefined) {
        throw new ProtocolError('UNKNOWN_MESSAGE_TYPE', `unknown message type ${JSON.stringify(type)}`);
    }
    return schema(payload, 'payload') as ClientMessagePayload<T>;
};

/** Exposed for tests that need to build valid capability lists. */
export const capabilitiesSchema = capabilities();
export const sourceSchema = source();
export const mediaSchema = media();
export const observationSchema = observation();
export const policySchema = policy();
export const idListSchema = arrayOf(idString(), { max: 64 });
