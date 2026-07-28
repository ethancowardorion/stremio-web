// Copyright (C) 2017-2026 Smart code 203358507

// Resumable WebSocket client for the watch party room service.
//
// Owns the socket, the handshake, clock sampling and reconnection. It holds no
// room state of its own: everything it receives is emitted for the reducer, so
// state and transport can be tested separately.

const EventEmitter = require('eventemitter3');
const { CLIENT_MESSAGE, SERVER_MESSAGE, createEnvelope, parseServerMessage } = require('./protocol');
const { createClock } = require('./clock');
const { createStorage } = require('./storage');

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// Backoff bounds. The first retry is fast because most disconnects are a blip;
// the ceiling keeps a long outage from hammering the service.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
const BACKOFF_JITTER_RATIO = 0.25;

// Five samples at connect gives the estimator a decent chance of catching one
// low-latency round trip (plan section 9.1).
const CLOCK_BURST_SAMPLES = 5;
const CLOCK_BURST_INTERVAL_MS = 150;
const CLOCK_REFRESH_INTERVAL_MS = 30_000;

const CLIENT_EVENT = {
    STATUS: 'status',
    MESSAGE: 'message',
    READY: 'ready',
    CLOCK: 'clock',
    ERROR: 'error',
};

const STATUS = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    OPEN: 'open',
    CLOSED: 'closed',
};

// Exponential backoff with symmetric jitter, so a group of clients dropped by one
// restart does not come back in lockstep.
const computeBackoffMs = (attempt, random) => {
    const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
    const roll = typeof random === 'function' ? random() : Math.random();
    const jitter = exponential * BACKOFF_JITTER_RATIO * (roll * 2 - 1);
    return Math.max(0, Math.round(exponential + jitter));
};

const createWatchPartyClient = (options) => {
    const config = options || {};
    const url = config.url;
    const clientVersion = config.clientVersion || 'unknown';
    const createSocket = config.createSocket || ((target) => new WebSocket(target));
    const monotonicNow = config.monotonicNow ||
        (() => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()));
    const setTimeoutFn = config.setTimeout || setTimeout;
    const clearTimeoutFn = config.clearTimeout || clearTimeout;
    const random = config.random || Math.random;
    const requestTimeoutMs = config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    const storage = config.storage || createStorage();

    const emitter = new EventEmitter();
    const clock = createClock({ monotonicNow });

    let socket = null;
    let status = STATUS.IDLE;
    let capabilities = null;
    let intentionalClose = false;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let clockTimer = null;
    let clockBurstRemaining = 0;
    let requestCounter = 0;
    let handshakeCompleted = false;
    const pendingRequests = new Map();
    const pendingPings = new Map();

    const setStatus = (next) => {
        if (status === next) {
            return;
        }
        status = next;
        emitter.emit(CLIENT_EVENT.STATUS, status);
    };

    const nextRequestId = () => {
        requestCounter += 1;
        return `q${requestCounter.toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
    };

    const clearTimers = () => {
        if (reconnectTimer !== null) {
            clearTimeoutFn(reconnectTimer);
            reconnectTimer = null;
        }
        if (clockTimer !== null) {
            clearTimeoutFn(clockTimer);
            clockTimer = null;
        }
    };

    const rejectPending = (reason) => {
        for (const pending of pendingRequests.values()) {
            clearTimeoutFn(pending.timer);
            pending.reject(reason);
        }
        pendingRequests.clear();
        pendingPings.clear();
    };

    const isOpen = () => socket !== null && socket.readyState === 1;

    const writeEnvelope = (envelope) => {
        if (!isOpen()) {
            return false;
        }
        try {
            socket.send(JSON.stringify(envelope));
            return true;
        } catch (error) {
            emitter.emit(CLIENT_EVENT.ERROR, { code: 'SEND_FAILED', message: String(error) });
            return false;
        }
    };

    // Fire and forget. Returns the request id so a caller can correlate a later
    // error frame; returns null when the socket is not writable.
    const send = (type, payload, sendOptions) => {
        const requestId = (sendOptions && sendOptions.requestId) || nextRequestId();
        const envelope = createEnvelope(type, payload, { requestId, roomId: sendOptions && sendOptions.roomId });
        return writeEnvelope(envelope) ? requestId : null;
    };

    // Awaits the reply carrying the same request id. An `error` frame rejects.
    const request = (type, payload, requestOptions) =>
        new Promise((resolve, reject) => {
            const requestId = nextRequestId();
            if (!isOpen()) {
                reject({ code: 'NOT_CONNECTED', message: 'watch party connection is not open' });
                return;
            }
            const timer = setTimeoutFn(() => {
                pendingRequests.delete(requestId);
                reject({ code: 'REQUEST_TIMEOUT', message: `no reply to ${type}` });
            }, requestTimeoutMs);
            pendingRequests.set(requestId, { resolve, reject, timer });

            const envelope = createEnvelope(type, payload, {
                requestId,
                roomId: requestOptions && requestOptions.roomId,
            });
            if (!writeEnvelope(envelope)) {
                clearTimeoutFn(timer);
                pendingRequests.delete(requestId);
                reject({ code: 'NOT_CONNECTED', message: 'watch party connection is not open' });
            }
        });

    const sendClockPing = () => {
        if (!isOpen()) {
            return;
        }
        const nonce = `p${requestCounter.toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
        requestCounter += 1;
        pendingPings.set(nonce, monotonicNow());
        send(CLIENT_MESSAGE.CLOCK_PING, { nonce, clientSentMs: Math.round(monotonicNow()) });
    };

    const scheduleClockSample = () => {
        if (clockTimer !== null) {
            clearTimeoutFn(clockTimer);
        }
        const delay = clockBurstRemaining > 0 ? CLOCK_BURST_INTERVAL_MS : CLOCK_REFRESH_INTERVAL_MS;
        clockTimer = setTimeoutFn(() => {
            clockTimer = null;
            if (clockBurstRemaining > 0) {
                clockBurstRemaining -= 1;
            }
            sendClockPing();
            scheduleClockSample();
        }, delay);
    };

    const startClockSampling = () => {
        // A reconnect may have crossed a different network path, so the previous
        // offset estimate is discarded rather than blended.
        clock.reset();
        clockBurstRemaining = CLOCK_BURST_SAMPLES;
        sendClockPing();
        scheduleClockSample();
    };

    const handleClockPong = (payload) => {
        const sentAt = pendingPings.get(payload.nonce);
        if (sentAt === undefined) {
            return;
        }
        pendingPings.delete(payload.nonce);
        const sample = clock.addSample({
            clientSentMonotonicMs: sentAt,
            clientRecvMonotonicMs: monotonicNow(),
            serverRecvMs: payload.serverRecvMs,
            serverSendMs: payload.serverSendMs,
        });
        if (sample !== null) {
            emitter.emit(CLIENT_EVENT.CLOCK, {
                offsetMs: clock.offsetMs,
                uncertaintyMs: clock.uncertaintyMs,
                roundTripMs: clock.roundTripMs,
                isConfident: clock.isConfident,
            });
        }
    };

    const sendHello = () => {
        const stored = storage.readSession();
        const payload = {
            protocolVersion: 1,
            clientVersion,
            capabilities,
        };
        if (stored !== null) {
            payload.resume = { sessionId: stored.sessionId, resumeToken: stored.resumeToken };
        }
        send(CLIENT_MESSAGE.SESSION_HELLO, payload);
    };

    const handleWelcome = (payload) => {
        handshakeCompleted = true;
        reconnectAttempt = 0;
        // A resume keeps the original token; only a fresh session issues one.
        if (typeof payload.resumeToken === 'string') {
            storage.writeSession({ sessionId: payload.sessionId, resumeToken: payload.resumeToken });
        }
        startClockSampling();
        emitter.emit(CLIENT_EVENT.READY, payload);
    };

    const handleMessage = (raw) => {
        const result = parseServerMessage(raw);
        if (!result.ok) {
            emitter.emit(CLIENT_EVENT.ERROR, { code: 'MALFORMED_SERVER_MESSAGE', message: result.reason });
            return;
        }
        const envelope = result.envelope;

        if (envelope.type === SERVER_MESSAGE.CLOCK_PONG) {
            handleClockPong(envelope.payload);
            return;
        }

        if (typeof envelope.requestId === 'string' && pendingRequests.has(envelope.requestId)) {
            const pending = pendingRequests.get(envelope.requestId);
            pendingRequests.delete(envelope.requestId);
            clearTimeoutFn(pending.timer);
            if (envelope.type === SERVER_MESSAGE.ERROR) {
                pending.reject(envelope.payload);
            } else {
                pending.resolve(envelope);
            }
        }

        if (envelope.type === SERVER_MESSAGE.SESSION_WELCOME) {
            handleWelcome(envelope.payload);
        }

        // Every frame, including one that settled a request, is still emitted so
        // the reducer sees a complete and ordered view of room state.
        emitter.emit(CLIENT_EVENT.MESSAGE, envelope);
    };

    const scheduleReconnect = () => {
        if (intentionalClose) {
            return;
        }
        reconnectAttempt += 1;
        const delayMs = computeBackoffMs(reconnectAttempt, random);
        reconnectTimer = setTimeoutFn(() => {
            reconnectTimer = null;
            openSocket();
        }, delayMs);
        emitter.emit(CLIENT_EVENT.STATUS, STATUS.CONNECTING);
        return delayMs;
    };

    const detachSocket = () => {
        if (socket === null) {
            return;
        }
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket = null;
    };

    const openSocket = () => {
        if (socket !== null) {
            return;
        }
        setStatus(STATUS.CONNECTING);
        handshakeCompleted = false;
        try {
            socket = createSocket(url);
        } catch (error) {
            socket = null;
            emitter.emit(CLIENT_EVENT.ERROR, { code: 'CONNECT_FAILED', message: String(error) });
            scheduleReconnect();
            return;
        }

        socket.onopen = () => {
            setStatus(STATUS.OPEN);
            sendHello();
        };
        socket.onmessage = (event) => {
            handleMessage(typeof event === 'string' ? event : event && event.data);
        };
        socket.onerror = () => {
            emitter.emit(CLIENT_EVENT.ERROR, { code: 'SOCKET_ERROR', message: 'watch party socket error' });
        };
        socket.onclose = (event) => {
            detachSocket();
            clearTimers();
            rejectPending({ code: 'DISCONNECTED', message: 'watch party connection closed' });
            // A handshake that never completed usually means the stored session is
            // unusable; dropping it lets the next attempt start clean instead of
            // failing the same way forever.
            if (!handshakeCompleted) {
                storage.clearSession();
            }
            if (intentionalClose) {
                setStatus(STATUS.CLOSED);
                return;
            }
            setStatus(STATUS.CLOSED);
            emitter.emit(CLIENT_EVENT.ERROR, {
                code: 'CONNECTION_LOST',
                message: 'watch party connection closed',
                closeCode: event && event.code,
            });
            scheduleReconnect();
        };
    };

    return {
        events: emitter,
        clock,
        storage,
        get status() {
            return status;
        },
        get isConnected() {
            return isOpen() && handshakeCompleted;
        },
        get reconnectAttempt() {
            return reconnectAttempt;
        },
        connect(clientCapabilities) {
            capabilities = clientCapabilities;
            intentionalClose = false;
            reconnectAttempt = 0;
            openSocket();
        },
        // Records the identity the service assigned, so a reload can resume into
        // the same participant rather than joining as a second one.
        rememberRoom(roomId) {
            const stored = storage.readSession();
            if (stored !== null) {
                storage.writeSession({ ...stored, roomId });
            }
        },
        disconnect(options) {
            intentionalClose = true;
            clearTimers();
            rejectPending({ code: 'DISCONNECTED', message: 'watch party client disconnected' });
            if (options && options.forget) {
                storage.clearSession();
            }
            if (socket !== null) {
                const current = socket;
                detachSocket();
                try {
                    current.close(1000, 'client disconnect');
                } catch (_) {
                    // Already closing; nothing further to do.
                }
            }
            setStatus(STATUS.CLOSED);
        },
        send,
        request,
        // Exposed so a UI can offer an immediate retry instead of waiting out the
        // remaining backoff.
        reconnectNow() {
            if (isOpen()) {
                return;
            }
            clearTimers();
            intentionalClose = false;
            openSocket();
        },
    };
};

module.exports = {
    CLIENT_EVENT,
    STATUS,
    BACKOFF_BASE_MS,
    BACKOFF_MAX_MS,
    BACKOFF_JITTER_RATIO,
    CLOCK_BURST_SAMPLES,
    CLOCK_BURST_INTERVAL_MS,
    CLOCK_REFRESH_INTERVAL_MS,
    computeBackoffMs,
    createWatchPartyClient,
};
