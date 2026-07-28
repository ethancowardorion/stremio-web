// Copyright (C) 2017-2023 Smart code 203358507

const {
    PROTOCOL_VERSION,
    CLIENT_MESSAGE,
    SERVER_MESSAGE,
    createEnvelope,
    parseServerMessage,
    playerCapabilities,
    missingCapabilities,
    isSupportedClient,
} = require('../src/services/WatchParty/protocol');

describe('watch party protocol envelopes', () => {
    it('stamps the protocol version and defaults an omitted payload', () => {
        const envelope = createEnvelope(CLIENT_MESSAGE.ROOM_LEAVE);
        expect(envelope).toEqual({ v: PROTOCOL_VERSION, type: 'room.leave', payload: {} });
    });

    it('carries a request id and room id only when they are strings', () => {
        const withIds = createEnvelope(CLIENT_MESSAGE.CLOCK_PING, { nonce: 'a' }, { requestId: 'r1', roomId: 'room1' });
        expect(withIds.requestId).toBe('r1');
        expect(withIds.roomId).toBe('room1');

        const withoutIds = createEnvelope(CLIENT_MESSAGE.CLOCK_PING, { nonce: 'a' }, { requestId: 5, roomId: null });
        expect(withoutIds).not.toHaveProperty('requestId');
        expect(withoutIds).not.toHaveProperty('roomId');
    });

    it('accepts a well-formed server frame', () => {
        const raw = JSON.stringify({
            v: PROTOCOL_VERSION,
            type: SERVER_MESSAGE.PLAYBACK_STATE,
            requestId: 'r1',
            payload: { playback: { revision: 2 } },
        });
        const result = parseServerMessage(raw);
        expect(result.ok).toBe(true);
        expect(result.envelope.type).toBe('playback.state');
        expect(result.envelope.requestId).toBe('r1');
        expect(result.envelope.payload).toEqual({ playback: { revision: 2 } });
    });

    it('reports rather than throws for every malformed frame', () => {
        expect(parseServerMessage(null).ok).toBe(false);
        expect(parseServerMessage('{oops').reason).toBe('invalid-json');
        expect(parseServerMessage('[]').reason).toBe('not-an-object');
        expect(parseServerMessage('"text"').reason).toBe('not-an-object');
    });

    it('rejects an unsupported protocol version and reports what it saw', () => {
        const result = parseServerMessage(JSON.stringify({ v: 99, type: 'error', payload: {} }));
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unsupported-version');
        expect(result.version).toBe(99);
    });

    it('rejects unknown message types, including client-only ones', () => {
        expect(parseServerMessage(JSON.stringify({ v: 1, type: 'nope.nope', payload: {} })).reason).toBe('unknown-type');
        expect(parseServerMessage(JSON.stringify({ v: 1, type: 'playback.command', payload: {} })).reason).toBe('unknown-type');
    });

    it('rejects a non-object payload', () => {
        expect(parseServerMessage(JSON.stringify({ v: 1, type: 'error', payload: 'boom' })).reason).toBe('invalid-payload');
        expect(parseServerMessage(JSON.stringify({ v: 1, type: 'error', payload: [] })).reason).toBe('invalid-payload');
    });
});

describe('watch party capability detection', () => {
    it('derives a full manifest from an HTML video implementation', () => {
        const capabilities = playerCapabilities({
            name: 'HTMLVideo',
            props: ['time', 'paused', 'buffering', 'playbackSpeed', 'duration'],
            commands: ['load', 'unload'],
        });
        expect(capabilities).toEqual({
            scheduledActions: true,
            observeBuffering: true,
            setPlaybackRate: true,
            navigateNext: true,
            playerImplementation: 'HTMLVideo',
        });
        expect(isSupportedClient(capabilities)).toBe(true);
    });

    it('marks an implementation without an observable timeline as unsupported', () => {
        const capabilities = playerCapabilities({ name: 'ChromecastSender', props: ['paused'], commands: [] });
        expect(capabilities.scheduledActions).toBe(false);
        expect(missingCapabilities(capabilities)).toEqual(['scheduledActions']);
        expect(isSupportedClient(capabilities)).toBe(false);
    });

    it('tolerates a missing or malformed manifest', () => {
        const capabilities = playerCapabilities(null);
        expect(capabilities.playerImplementation).toBe('unknown');
        expect(isSupportedClient(capabilities)).toBe(false);
        expect(missingCapabilities(undefined)).toEqual(['scheduledActions']);
    });
});
