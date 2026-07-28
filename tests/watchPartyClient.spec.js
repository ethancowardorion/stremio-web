// Copyright (C) 2017-2023 Smart code 203358507

const {
    CLIENT_EVENT,
    STATUS,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
    CLOCK_BURST_SAMPLES,
    CLOCK_BURST_INTERVAL_MS,
    CLOCK_REFRESH_INTERVAL_MS,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
    computeBackoffMs,
    createWatchPartyClient,
} = require('../src/services/WatchParty/WatchPartyClient');
const { createStorage } = require('../src/services/WatchParty/storage');

const CAPABILITIES = {
    scheduledActions: true,
    observeBuffering: true,
    setPlaybackRate: true,
    navigateNext: true,
    playerImplementation: 'HTMLVideo',
};

class MemoryStorage {
    constructor() {
        this.map = new Map();
    }
    getItem(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }
    setItem(key, value) {
        this.map.set(key, String(value));
    }
    removeItem(key) {
        this.map.delete(key);
    }
}

class FakeSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        this.closeCalls = [];
        FakeSocket.instances.push(this);
    }
    send(raw) {
        this.sent.push(JSON.parse(raw));
    }
    close(code, reason) {
        this.closeCalls.push({ code, reason });
        this.readyState = 3;
    }
    // --- test drivers ---
    accept() {
        this.readyState = 1;
        if (this.onopen) {
            this.onopen();
        }
    }
    deliver(type, payload, requestId) {
        if (this.onmessage) {
            this.onmessage({
                data: JSON.stringify({ v: 1, type, payload, ...(requestId ? { requestId } : {}) }),
            });
        }
    }
    deliverRaw(raw) {
        if (this.onmessage) {
            this.onmessage({ data: raw });
        }
    }
    drop(code = 1006) {
        this.readyState = 3;
        if (this.onclose) {
            this.onclose({ code });
        }
    }
    sentOfType(type) {
        return this.sent.filter((envelope) => envelope.type === type);
    }
}
FakeSocket.instances = [];

const setUp = (options = {}) => {
    FakeSocket.instances = [];
    let monotonic = 1000;
    const storage = createStorage({
        sessionStorage: () => new MemoryStorage(),
        localStorage: () => new MemoryStorage(),
        now: () => 1_700_000_000_000,
        ...options.storageOptions,
    });
    if (options.storedSession) {
        storage.writeSession(options.storedSession);
    }
    const client = createWatchPartyClient({
        url: 'wss://example.test/v1/ws',
        clientVersion: '5.0.0-test',
        createSocket: (url) => new FakeSocket(url),
        monotonicNow: () => monotonic,
        random: options.random || (() => 0.5),
        storage,
        ...options.clientOptions,
    });
    return {
        client,
        storage,
        advanceMonotonic(ms) {
            monotonic += ms;
        },
        get monotonic() {
            return monotonic;
        },
        socket(index = 0) {
            return FakeSocket.instances[index];
        },
        get socketCount() {
            return FakeSocket.instances.length;
        },
    };
};

const welcomePayload = (overrides = {}) => ({
    sessionId: 's-1',
    resumeToken: 'resume-token-value-1234567890',
    resumed: false,
    protocolVersion: 1,
    minProtocolVersion: 1,
    serverTimeMs: 1_700_000_000_000,
    requiredCapabilities: ['scheduledActions'],
    missingCapabilities: [],
    supported: true,
    limits: {},
    ...overrides,
});

describe('watch party backoff', () => {
    it('grows exponentially from the base and stops at the ceiling', () => {
        const noJitter = () => 0.5;
        expect(computeBackoffMs(1, noJitter)).toBe(BACKOFF_BASE_MS);
        expect(computeBackoffMs(2, noJitter)).toBe(BACKOFF_BASE_MS * 2);
        expect(computeBackoffMs(3, noJitter)).toBe(BACKOFF_BASE_MS * 4);
        expect(computeBackoffMs(20, noJitter)).toBe(BACKOFF_MAX_MS);
    });

    it('applies symmetric jitter and never returns a negative delay', () => {
        expect(computeBackoffMs(3, () => 0)).toBe(1500);
        expect(computeBackoffMs(3, () => 1)).toBe(2500);
        expect(computeBackoffMs(1, () => 0)).toBeGreaterThanOrEqual(0);
        expect(computeBackoffMs(0, () => 0)).toBeGreaterThanOrEqual(0);
    });
});

describe('watch party client handshake', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('opens a socket and sends the handshake with its capabilities', () => {
        const harness = setUp();
        const statuses = [];
        harness.client.events.on(CLIENT_EVENT.STATUS, (status) => statuses.push(status));

        harness.client.connect(CAPABILITIES);
        expect(harness.socketCount).toBe(1);
        expect(harness.client.status).toBe(STATUS.CONNECTING);
        expect(harness.socket().sent).toHaveLength(0);

        harness.socket().accept();
        const hello = harness.socket().sentOfType('session.hello');
        expect(hello).toHaveLength(1);
        expect(hello[0].v).toBe(1);
        expect(hello[0].payload.capabilities).toEqual(CAPABILITIES);
        expect(hello[0].payload.clientVersion).toBe('5.0.0-test');
        expect(hello[0].payload.resume).toBeUndefined();
        expect(statuses).toEqual([STATUS.CONNECTING, STATUS.OPEN]);
    });

    it('is not connected until the welcome arrives', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        expect(harness.client.isConnected).toBe(false);

        harness.socket().deliver('session.welcome', welcomePayload());
        expect(harness.client.isConnected).toBe(true);
    });

    it('stores the issued resume token and offers it on the next connection', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());

        expect(harness.storage.readSession()).toEqual({
            sessionId: 's-1',
            resumeToken: 'resume-token-value-1234567890',
            roomId: null,
        });

        harness.socket().drop();
        jest.advanceTimersByTime(BACKOFF_MAX_MS);
        harness.socket(1).accept();
        expect(harness.socket(1).sentOfType('session.hello')[0].payload.resume).toEqual({
            sessionId: 's-1',
            resumeToken: 'resume-token-value-1234567890',
        });
    });

    it('keeps the existing token when the service resumes without issuing one', () => {
        const harness = setUp({
            storedSession: { sessionId: 's-9', resumeToken: 'existing-token-1234567890' },
        });
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload({ sessionId: 's-9', resumeToken: null, resumed: true }));

        expect(harness.storage.readSession().resumeToken).toBe('existing-token-1234567890');
    });

    it('discards a stored session when the handshake never completes', () => {
        const harness = setUp({
            storedSession: { sessionId: 's-dead', resumeToken: 'dead-token-1234567890' },
        });
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().drop(4002);

        expect(harness.storage.readSession()).toBeNull();
    });

    it('retries a rejected resume once as a fresh handshake on the same socket', () => {
        const harness = setUp({
            storedSession: { sessionId: 's-dead', resumeToken: 'dead-token-1234567890', roomId: 'room-old' },
        });
        const ready = jest.fn();
        harness.client.events.on(CLIENT_EVENT.READY, ready);

        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        expect(harness.socket().sentOfType('session.hello')[0].payload.resume).toEqual({
            sessionId: 's-dead',
            resumeToken: 'dead-token-1234567890',
        });

        harness.socket().deliver('error', { code: 'RESUME_REJECTED', message: 'expired' });

        const hellos = harness.socket().sentOfType('session.hello');
        expect(hellos).toHaveLength(2);
        expect(hellos[1].payload.resume).toBeUndefined();
        expect(harness.storage.readSession()).toBeNull();

        harness.socket().deliver('session.welcome', welcomePayload());
        expect(harness.client.isConnected).toBe(true);
        expect(ready).toHaveBeenCalledTimes(1);
    });

    it('does not loop if a credential-free handshake is also rejected', () => {
        const harness = setUp({
            storedSession: { sessionId: 's-dead', resumeToken: 'dead-token-1234567890' },
        });
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('error', { code: 'RESUME_REJECTED', message: 'expired' });
        harness.socket().deliver('error', { code: 'RESUME_REJECTED', message: 'still rejected' });

        expect(harness.socket().sentOfType('session.hello')).toHaveLength(2);
        expect(harness.client.isConnected).toBe(false);
    });

    it('times out an open socket that never completes its handshake', () => {
        const harness = setUp({
            storedSession: { sessionId: 's-dead', resumeToken: 'dead-token-1234567890' },
        });
        const errors = [];
        harness.client.events.on(CLIENT_EVENT.ERROR, (error) => errors.push(error));

        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        jest.advanceTimersByTime(DEFAULT_HANDSHAKE_TIMEOUT_MS);

        expect(harness.socket().closeCalls).toEqual([{ code: 4000, reason: 'handshake timeout' }]);
        expect(harness.storage.readSession()).toBeNull();
        expect(harness.client.status).toBe(STATUS.CLOSED);
        expect(errors).toContainEqual(expect.objectContaining({ code: 'HANDSHAKE_TIMEOUT' }));
    });

    it('waits for the old socket to close before reconnecting with new capabilities', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());
        const changed = { ...CAPABILITIES, playerImplementation: 'MPV' };

        harness.client.reconnect(changed);
        expect(harness.socketCount).toBe(1);
        expect(harness.socket().closeCalls).toEqual([{ code: 1000, reason: 'client reconnect' }]);

        harness.socket().drop(1000);
        expect(harness.socketCount).toBe(2);
        harness.socket(1).accept();
        expect(harness.socket(1).sentOfType('session.hello')[0].payload.capabilities).toEqual(changed);
    });

    it('records the room id alongside the session so a reload resumes in place', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());
        harness.client.rememberRoom('room-42');

        expect(harness.storage.readSession().roomId).toBe('room-42');
    });
});

describe('watch party client requests', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const connected = () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());
        return harness;
    };

    it('resolves a request with the frame carrying the same request id', async () => {
        const harness = connected();
        const pending = harness.client.request('room.join', { roomId: 'r1' });
        const requestId = harness.socket().sentOfType('room.join')[0].requestId;

        harness.socket().deliver('room.snapshot', { room: { roomId: 'r1' } }, requestId);
        await expect(pending).resolves.toMatchObject({ type: 'room.snapshot' });
    });

    it('rejects a request when the service answers with an error frame', async () => {
        const harness = connected();
        const pending = harness.client.request('room.join', { roomId: 'r1' });
        const requestId = harness.socket().sentOfType('room.join')[0].requestId;

        harness.socket().deliver('error', { code: 'ROOM_NOT_FOUND', message: 'gone' }, requestId);
        await expect(pending).rejects.toMatchObject({ code: 'ROOM_NOT_FOUND' });
    });

    it('rejects a request that is never answered', async () => {
        const harness = connected();
        const pending = harness.client.request('room.join', { roomId: 'r1' });
        const assertion = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
        jest.advanceTimersByTime(30_000);
        await assertion;
    });

    it('rejects immediately when the socket is not open', async () => {
        const harness = setUp();
        await expect(harness.client.request('room.leave', {})).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
        expect(harness.client.send('room.leave', {})).toBeNull();
    });

    it('rejects every in-flight request when the connection drops', async () => {
        const harness = connected();
        const pending = harness.client.request('room.join', { roomId: 'r1' });
        const assertion = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' });
        harness.socket().drop();
        await assertion;
    });

    it('emits every frame for the reducer, including ones that settled a request', async () => {
        const harness = connected();
        const seen = [];
        harness.client.events.on(CLIENT_EVENT.MESSAGE, (envelope) => seen.push(envelope.type));

        const pending = harness.client.request('room.join', { roomId: 'r1' });
        const requestId = harness.socket().sentOfType('room.join')[0].requestId;
        harness.socket().deliver('room.snapshot', { room: {} }, requestId);
        harness.socket().deliver('playback.state', { playback: {} });
        await pending;

        expect(seen).toEqual(['room.snapshot', 'playback.state']);
    });

    it('reports a malformed frame without emitting it as room state', () => {
        const harness = connected();
        const errors = [];
        const messages = [];
        harness.client.events.on(CLIENT_EVENT.ERROR, (error) => errors.push(error));
        harness.client.events.on(CLIENT_EVENT.MESSAGE, (envelope) => messages.push(envelope));

        harness.socket().deliverRaw('{not json');
        expect(messages).toHaveLength(0);
        expect(errors[0].code).toBe('MALFORMED_SERVER_MESSAGE');
    });
});

describe('watch party client clock sampling', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('bursts samples at connect, then settles into a slower refresh', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());
        expect(harness.socket().sentOfType('clock.ping')).toHaveLength(1);

        jest.advanceTimersByTime(CLOCK_BURST_INTERVAL_MS * CLOCK_BURST_SAMPLES);
        expect(harness.socket().sentOfType('clock.ping')).toHaveLength(CLOCK_BURST_SAMPLES + 1);

        // The burst is over, so a further burst interval must not produce more.
        jest.advanceTimersByTime(CLOCK_BURST_INTERVAL_MS * 4);
        expect(harness.socket().sentOfType('clock.ping')).toHaveLength(CLOCK_BURST_SAMPLES + 1);

        jest.advanceTimersByTime(CLOCK_REFRESH_INTERVAL_MS);
        expect(harness.socket().sentOfType('clock.ping')).toHaveLength(CLOCK_BURST_SAMPLES + 2);
    });

    it('feeds matching pongs into the estimator and ignores unknown nonces', () => {
        const harness = setUp();
        const samples = [];
        harness.client.events.on(CLIENT_EVENT.CLOCK, (sample) => samples.push(sample));
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());

        const nonce = harness.socket().sentOfType('clock.ping')[0].payload.nonce;
        harness.advanceMonotonic(40);
        harness.socket().deliver('clock.pong', {
            nonce,
            clientSentMs: 1000,
            serverRecvMs: 1_000_000 + 1020,
            serverSendMs: 1_000_000 + 1020,
        });

        expect(samples).toHaveLength(1);
        expect(harness.client.clock.offsetMs).toBe(1_000_000);
        expect(harness.client.clock.roundTripMs).toBe(40);

        harness.socket().deliver('clock.pong', { nonce: 'unknown', clientSentMs: 0, serverRecvMs: 0, serverSendMs: 0 });
        expect(samples).toHaveLength(1);
    });

    it('throws away the previous estimate on reconnect', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());
        const nonce = harness.socket().sentOfType('clock.ping')[0].payload.nonce;
        harness.advanceMonotonic(20);
        harness.socket().deliver('clock.pong', { nonce, clientSentMs: 1000, serverRecvMs: 501_010, serverSendMs: 501_010 });
        expect(harness.client.clock.hasEstimate).toBe(true);

        harness.socket().drop();
        jest.advanceTimersByTime(BACKOFF_MAX_MS);
        harness.socket(1).accept();
        harness.socket(1).deliver('session.welcome', welcomePayload({ resumeToken: null, resumed: true }));
        // A reconnect may have taken a different network path, so the old offset
        // must not survive it.
        expect(harness.client.clock.hasEstimate).toBe(false);
    });
});

describe('watch party client reconnection', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('reconnects with growing backoff after an unexpected close', () => {
        const harness = setUp({ random: () => 0.5 });
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());

        harness.socket().drop();
        expect(harness.socketCount).toBe(1);
        jest.advanceTimersByTime(BACKOFF_BASE_MS - 1);
        expect(harness.socketCount).toBe(1);
        jest.advanceTimersByTime(1);
        expect(harness.socketCount).toBe(2);

        // The second attempt also fails, so the delay must have grown.
        harness.socket(1).drop();
        jest.advanceTimersByTime(BACKOFF_BASE_MS);
        expect(harness.socketCount).toBe(2);
        jest.advanceTimersByTime(BACKOFF_BASE_MS);
        expect(harness.socketCount).toBe(3);
    });

    it('resets the attempt counter once a handshake succeeds', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());
        harness.socket().drop();
        jest.advanceTimersByTime(BACKOFF_MAX_MS);
        expect(harness.client.reconnectAttempt).toBe(1);

        harness.socket(1).accept();
        harness.socket(1).deliver('session.welcome', welcomePayload({ resumed: true, resumeToken: null }));
        expect(harness.client.reconnectAttempt).toBe(0);
    });

    it('does not reconnect after an intentional disconnect', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());

        harness.client.disconnect();
        expect(harness.socket().closeCalls).toHaveLength(1);
        jest.advanceTimersByTime(BACKOFF_MAX_MS * 4);
        expect(harness.socketCount).toBe(1);
        expect(harness.client.status).toBe(STATUS.CLOSED);
    });

    it('forgets the session when asked to, so the next connect starts fresh', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());

        harness.client.disconnect({ forget: true });
        expect(harness.storage.readSession()).toBeNull();
    });

    it('stops every timer on disconnect, leaving nothing pending', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());
        const pingsBefore = harness.socket().sentOfType('clock.ping').length;

        harness.client.disconnect();
        jest.advanceTimersByTime(CLOCK_REFRESH_INTERVAL_MS * 4);
        expect(harness.socket().sentOfType('clock.ping')).toHaveLength(pingsBefore);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('can retry immediately instead of waiting out the backoff', () => {
        const harness = setUp();
        harness.client.connect(CAPABILITIES);
        harness.socket().accept();
        harness.socket().deliver('session.welcome', welcomePayload());
        harness.socket().drop();

        harness.client.reconnectNow();
        expect(harness.socketCount).toBe(2);
        // The scheduled attempt must have been cancelled, not merely superseded.
        jest.advanceTimersByTime(BACKOFF_MAX_MS * 2);
        expect(harness.socketCount).toBe(2);
    });
});
