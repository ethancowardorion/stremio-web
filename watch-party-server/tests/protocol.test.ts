// Copyright (C) 2017-2026 Smart code 203358507

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvelope, serializeEnvelope } from '../src/protocol/envelopes.ts';
import { ProtocolError } from '../src/protocol/errors.ts';
import { createClientMessageSchemas, isClientMessageType, validateClientMessage } from '../src/protocol/schemas.ts';
import { PROTOCOL_VERSION } from '../src/protocol/types.ts';
import { jsonValue, object, string, integer, displayName } from '../src/protocol/validate.ts';
import { capabilities, sampleMedia, sampleObservation, sampleSource } from './helpers/harness.ts';

const MAX_BYTES = 4096;

const schemas = createClientMessageSchemas({ maxDisplayNameLength: 48 });

const expectCode = (fn: () => unknown, code: string): ProtocolError => {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof ProtocolError, `expected a ProtocolError, received ${String(error)}`);
        assert.equal(error.code, code);
        return error;
    }
    throw new assert.AssertionError({ message: `expected ${code} to be thrown` });
};

test('envelope: accepts a well-formed frame', () => {
    const raw = serializeEnvelope('clock.ping', { nonce: 'abc', clientSentMs: 5 }, { requestId: 'r1' });
    const envelope = parseEnvelope(raw, { maxBytes: MAX_BYTES });
    assert.equal(envelope.v, PROTOCOL_VERSION);
    assert.equal(envelope.type, 'clock.ping');
    assert.equal(envelope.requestId, 'r1');
    assert.deepEqual(envelope.payload, { nonce: 'abc', clientSentMs: 5 });
});

test('envelope: rejects frames larger than the configured cap', () => {
    const raw = serializeEnvelope('clock.ping', { nonce: 'x'.repeat(MAX_BYTES) });
    expectCode(() => parseEnvelope(raw, { maxBytes: MAX_BYTES }), 'MESSAGE_TOO_LARGE');
});

test('envelope: rejects malformed JSON, arrays and non-object payloads', () => {
    expectCode(() => parseEnvelope('{not json', { maxBytes: MAX_BYTES }), 'MALFORMED_MESSAGE');
    expectCode(() => parseEnvelope('[1,2,3]', { maxBytes: MAX_BYTES }), 'MALFORMED_MESSAGE');
    expectCode(() => parseEnvelope('"a string"', { maxBytes: MAX_BYTES }), 'MALFORMED_MESSAGE');
    expectCode(
        () => parseEnvelope(JSON.stringify({ v: 1, type: 'clock.ping', payload: [] }), { maxBytes: MAX_BYTES }),
        'MALFORMED_MESSAGE',
    );
});

test('envelope: rejects a missing or non-integer version before anything else', () => {
    expectCode(
        () => parseEnvelope(JSON.stringify({ type: 'clock.ping', payload: {} }), { maxBytes: MAX_BYTES }),
        'MALFORMED_MESSAGE',
    );
    expectCode(
        () => parseEnvelope(JSON.stringify({ v: '1', type: 'clock.ping', payload: {} }), { maxBytes: MAX_BYTES }),
        'MALFORMED_MESSAGE',
    );
});

test('envelope: reports unsupported versions with the supported range', () => {
    const error = expectCode(
        () => parseEnvelope(JSON.stringify({ v: 99, type: 'clock.ping', payload: {} }), { maxBytes: MAX_BYTES }),
        'UNSUPPORTED_PROTOCOL_VERSION',
    );
    assert.deepEqual(error.details, { min: 1, max: PROTOCOL_VERSION });
    assert.equal(typeof error.closeCode, 'number');
});

test('envelope: rejects unknown top-level fields', () => {
    expectCode(
        () => parseEnvelope(JSON.stringify({ v: 1, type: 'clock.ping', payload: {}, extra: true }), { maxBytes: MAX_BYTES }),
        'VALIDATION_FAILED',
    );
});

test('message types: only declared client types are recognised', () => {
    assert.equal(isClientMessageType('playback.command'), true);
    assert.equal(isClientMessageType('playback.state'), false);
    assert.equal(isClientMessageType('__proto__'), false);
});

test('schemas: a valid room.create passes and normalizes the display name', () => {
    const payload = validateClientMessage(schemas, 'room.create', {
        displayName: '   Ethan   on    laptop  ',
        deviceLabel: 'Laptop',
        media: sampleMedia(),
        source: sampleSource(),
        observation: sampleObservation(),
    });
    assert.equal(payload.displayName, 'Ethan on laptop');
    assert.equal(payload.media.type, 'series');
    assert.equal(payload.source.kind, 'torrent');
});

test('schemas: room.create defaults an omitted device label to null', () => {
    const payload = validateClientMessage(schemas, 'room.create', {
        displayName: 'Host',
        media: sampleMedia(),
        source: sampleSource(),
        observation: sampleObservation(),
    });
    assert.equal(payload.deviceLabel, null);
});

test('schemas: unknown payload fields are rejected rather than stripped', () => {
    const error = expectCode(
        () =>
            validateClientMessage(schemas, 'room.create', {
                displayName: 'Host',
                media: sampleMedia(),
                source: sampleSource(),
                observation: sampleObservation(),
                surpriseFeature: true,
            }),
        'VALIDATION_FAILED',
    );
    assert.equal(error.details?.path, 'payload.surpriseFeature');
});

test('schemas: blank and control-character-only display names are rejected', () => {
    expectCode(() => displayName(48)('   ', 'payload.displayName'), 'VALIDATION_FAILED');
    expectCode(() => displayName(48)('\n\t\r', 'payload.displayName'), 'VALIDATION_FAILED');
    assert.equal(displayName(48)('a\nb', 'payload.displayName'), 'a b');
});

test('schemas: display names are truncated to the configured maximum', () => {
    assert.equal(displayName(5)('abcdefghij', 'payload.displayName'), 'abcde');
});

test('schemas: playback.command rejects out-of-range rates and negative positions', () => {
    expectCode(
        () =>
            validateClientMessage(schemas, 'playback.command', {
                commandId: 'c1',
                action: 'rate',
                expectedRevision: 1,
                mediaRevision: 1,
                rate: 12,
            }),
        'VALIDATION_FAILED',
    );
    expectCode(
        () =>
            validateClientMessage(schemas, 'playback.command', {
                commandId: 'c1',
                action: 'seek',
                expectedRevision: 1,
                mediaRevision: 1,
                positionMs: -1,
            }),
        'VALIDATION_FAILED',
    );
});

test('schemas: playback.command rejects an unknown action', () => {
    expectCode(
        () =>
            validateClientMessage(schemas, 'playback.command', {
                commandId: 'c1',
                action: 'fastforward',
                expectedRevision: 1,
                mediaRevision: 1,
            }),
        'VALIDATION_FAILED',
    );
});

test('schemas: identifiers must be url-safe and bounded', () => {
    expectCode(
        () =>
            validateClientMessage(schemas, 'playback.command', {
                commandId: 'has spaces',
                action: 'pause',
                expectedRevision: 1,
                mediaRevision: 1,
            }),
        'VALIDATION_FAILED',
    );
});

test('schemas: session.hello requires the full capability manifest', () => {
    expectCode(
        () =>
            validateClientMessage(schemas, 'session.hello', {
                protocolVersion: 1,
                clientVersion: 'test',
                capabilities: { scheduledActions: true },
            }),
        'VALIDATION_FAILED',
    );
    const payload = validateClientMessage(schemas, 'session.hello', {
        protocolVersion: 1,
        clientVersion: 'test',
        capabilities: capabilities({ setPlaybackRate: false }),
    });
    assert.equal(payload.capabilities.setPlaybackRate, false);
});

test('schemas: an invite secret shorter than the minimum is refused', () => {
    expectCode(
        () => validateClientMessage(schemas, 'room.join', { roomId: 'abc', inviteSecret: 'short', displayName: 'Guest' }),
        'VALIDATION_FAILED',
    );
});

test('validate: optional rejects an explicit null, nullable accepts it', () => {
    const schema = object({ a: string(), b: integer({ min: 0 }) });
    expectCode(() => schema({ a: null, b: 1 }, ''), 'VALIDATION_FAILED');
    const source = validateClientMessage(schemas, 'source.refresh', { source: sampleSource({ authKey: null }) });
    assert.equal(source.source.authKey, null);
});

test('validate: jsonValue bounds depth, breadth and serialized size', () => {
    const schema = jsonValue({ maxDepth: 2, maxBytes: 64, maxKeys: 3 });
    assert.deepEqual(schema({ a: { b: 1 } }, 'x'), { a: { b: 1 } });
    expectCode(() => schema({ a: { b: { c: { d: 1 } } } }, 'x'), 'VALIDATION_FAILED');
    expectCode(() => schema({ a: 1, b: 2, c: 3, d: 4 }, 'x'), 'VALIDATION_FAILED');
    expectCode(() => schema({ a: 'x'.repeat(200) }, 'x'), 'VALIDATION_FAILED');
});

test('validate: jsonValue refuses non-JSON values and non-finite numbers', () => {
    const schema = jsonValue();
    expectCode(() => schema({ a: () => 1 }, 'x'), 'VALIDATION_FAILED');
    expectCode(() => schema({ a: Number.POSITIVE_INFINITY }, 'x'), 'VALIDATION_FAILED');
    expectCode(() => schema({ a: Number.NaN }, 'x'), 'VALIDATION_FAILED');
});

test('validate: an unknown message type is reported as such', () => {
    expectCode(
        // A deliberately invalid type, cast to reach the runtime guard.
        () => validateClientMessage(schemas, 'nope.nope' as 'room.leave', {}),
        'UNKNOWN_MESSAGE_TYPE',
    );
});
