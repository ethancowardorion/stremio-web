// Copyright (C) 2017-2026 Smart code 203358507

import { WebSocket } from 'ws';
import { loadConfig, type Config, type LogLevel } from '../../src/config.ts';
import { createWatchPartyServer, type WatchPartyServer } from '../../src/http/server.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { createMetrics, type Metrics } from '../../src/observability/metrics.ts';
import { PROTOCOL_VERSION, type PlayerCapabilities } from '../../src/protocol/types.ts';
import { WS_PATH } from '../../src/ws/upgrade.ts';

/**
 * Test harness.
 *
 * Time is injected everywhere, so no synchronization test sleeps on a real
 * clock (plan section 17.1). The server binds to port 0 and the sweep loop is
 * driven manually, which makes TTL and grace-period behaviour deterministic.
 */

export class TestClock {
    private currentMs: number;

    constructor(startMs = 1_700_000_000_000) {
        this.currentMs = startMs;
    }

    now = (): number => this.currentMs;

    advance(ms: number): void {
        this.currentMs += ms;
    }

    set(ms: number): void {
        this.currentMs = ms;
    }
}

export type Envelope = { v: number; type: string; requestId?: string; roomId?: string; payload: Record<string, unknown> };

const CAPABILITIES: PlayerCapabilities = {
    scheduledActions: true,
    observeBuffering: true,
    setPlaybackRate: true,
    navigateNext: true,
    playerImplementation: 'HTMLVideo',
};

export const capabilities = (overrides: Partial<PlayerCapabilities> = {}): PlayerCapabilities => ({
    ...CAPABILITIES,
    ...overrides,
});

export const sampleMedia = (overrides: Record<string, unknown> = {}) => ({
    type: 'series',
    metaId: 'tt0903747',
    videoId: 'tt0903747:1:1',
    title: 'Pilot',
    expectedDurationMs: 3_480_000,
    live: false,
    ...overrides,
});

export const sampleSource = (overrides: Record<string, unknown> = {}) => ({
    streamParam: 'eyJpbmZvSGFzaCI6ImFiYyIsImZpbGVJZHgiOjB9',
    stream: { infoHash: 'abc', fileIdx: 0 },
    streamTransportUrl: 'https://addon.example/manifest.json',
    metaTransportUrl: 'https://meta.example/manifest.json',
    playerPath: '/player/eyJ0ZXN0Ijp0cnVlfQ',
    kind: 'torrent',
    fingerprint: 'torrent:abc:0',
    authKey: null,
    ...overrides,
});

export const sampleObservation = (overrides: Record<string, unknown> = {}) => ({
    positionMs: 0,
    paused: true,
    rate: 1,
    buffering: false,
    durationMs: 3_480_000,
    mediaRevision: 1,
    ...overrides,
});

export type Harness = {
    server: WatchPartyServer;
    url: string;
    clock: TestClock;
    metrics: Metrics;
    config: Config;
    logLines: string[];
    connect(): Promise<TestClient>;
    stop(): Promise<void>;
};

export const startHarness = async (
    envOverrides: Record<string, string> = {},
    options: { logLevel?: LogLevel } = {},
): Promise<Harness> => {
    const clock = new TestClock();
    const config = loadConfig({
        WATCH_PARTY_PORT: '0',
        WATCH_PARTY_HOST: '127.0.0.1',
        WATCH_PARTY_METRICS_PORT: '0',
        WATCH_PARTY_METRICS_HOST: '127.0.0.1',
        WATCH_PARTY_ALLOWED_ORIGINS: 'https://app.example',
        ...envOverrides,
    } as NodeJS.ProcessEnv);
    const logLines: string[] = [];
    const logger = createLogger(options.logLevel ?? 'error', (line) => logLines.push(line), {}, clock.now);
    const metrics = createMetrics();
    const server = createWatchPartyServer({ config, logger, metrics, now: clock.now });
    await server.listen();

    const clients: TestClient[] = [];
    const url = `ws://127.0.0.1:${server.publicPort}${WS_PATH}`;

    return {
        server,
        url,
        clock,
        metrics,
        config,
        logLines,
        async connect() {
            const client = await TestClient.connect(url);
            clients.push(client);
            return client;
        },
        async stop() {
            await Promise.all(clients.map((client) => client.close()));
            await server.close();
        },
    };
};

type Waiter = { predicate: (envelope: Envelope) => boolean; resolve: (envelope: Envelope) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const DEFAULT_WAIT_MS = 2000;

export class TestClient {
    readonly socket: WebSocket;
    readonly received: Envelope[] = [];
    sessionId: string | null = null;
    resumeToken: string | null = null;
    participantId: string | null = null;
    roomId: string | null = null;
    inviteSecret: string | null = null;

    private readonly buffer: Envelope[] = [];
    private readonly waiters: Waiter[] = [];
    private requestCounter = 0;
    private closed = false;

    private constructor(socket: WebSocket) {
        this.socket = socket;
        socket.on('message', (data) => {
            const envelope = JSON.parse(data.toString()) as Envelope;
            this.received.push(envelope);
            const index = this.waiters.findIndex((waiter) => waiter.predicate(envelope));
            if (index === -1) {
                this.buffer.push(envelope);
                return;
            }
            const [waiter] = this.waiters.splice(index, 1);
            if (waiter !== undefined) {
                clearTimeout(waiter.timer);
                waiter.resolve(envelope);
            }
        });
        socket.on('close', () => {
            this.closed = true;
            for (const waiter of this.waiters.splice(0)) {
                clearTimeout(waiter.timer);
                waiter.reject(new Error('socket closed while waiting for a message'));
            }
        });
    }

    static connect(url: string, headers: Record<string, string> = { origin: 'https://app.example' }): Promise<TestClient> {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url, { headers });
            const client = new TestClient(socket);
            socket.once('open', () => resolve(client));
            socket.once('error', reject);
        });
    }

    get isClosed(): boolean {
        return this.closed;
    }

    nextRequestId(): string {
        this.requestCounter += 1;
        return `r${this.requestCounter}`;
    }

    /** Sends a raw string, for malformed-input tests. */
    sendRaw(raw: string): void {
        this.socket.send(raw);
    }

    send(type: string, payload: unknown, options: { requestId?: string; v?: number } = {}): string {
        const requestId = options.requestId ?? this.nextRequestId();
        this.socket.send(JSON.stringify({ v: options.v ?? PROTOCOL_VERSION, type, requestId, payload }));
        return requestId;
    }

    /** Waits for the reply to a request, resolving on either the reply or an error frame. */
    async request(type: string, payload: unknown, expectedType?: string): Promise<Envelope> {
        const requestId = this.send(type, payload);
        return this.waitFor(
            (envelope) =>
                envelope.requestId === requestId &&
                (expectedType === undefined || envelope.type === expectedType || envelope.type === 'error'),
        );
    }

    waitFor(predicate: string | ((envelope: Envelope) => boolean), timeoutMs = DEFAULT_WAIT_MS): Promise<Envelope> {
        const matches = typeof predicate === 'string' ? (envelope: Envelope) => envelope.type === predicate : predicate;
        const index = this.buffer.findIndex(matches);
        if (index !== -1) {
            const [envelope] = this.buffer.splice(index, 1);
            return Promise.resolve(envelope as Envelope);
        }
        if (this.closed) {
            return Promise.reject(new Error('socket is closed'));
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const position = this.waiters.findIndex((waiter) => waiter.timer === timer);
                if (position !== -1) {
                    this.waiters.splice(position, 1);
                }
                reject(new Error(`timed out waiting for a message; received: ${this.received.map((e) => e.type).join(', ')}`));
            }, timeoutMs);
            this.waiters.push({ predicate: matches, resolve, reject, timer });
        });
    }

    /** Performs the handshake and records the session identity. */
    async hello(overrides: Record<string, unknown> = {}): Promise<Envelope> {
        const welcome = await this.request(
            'session.hello',
            {
                protocolVersion: PROTOCOL_VERSION,
                clientVersion: 'test',
                capabilities: capabilities(),
                ...overrides,
            },
            'session.welcome',
        );
        if (welcome.type === 'session.welcome') {
            this.sessionId = welcome.payload.sessionId as string;
            this.resumeToken = (welcome.payload.resumeToken as string | null) ?? this.resumeToken;
        }
        return welcome;
    }

    async createRoom(overrides: Record<string, unknown> = {}): Promise<Envelope> {
        const created = await this.request(
            'room.create',
            {
                displayName: 'Host',
                deviceLabel: 'Laptop',
                media: sampleMedia(),
                source: sampleSource(),
                observation: sampleObservation(),
                ...overrides,
            },
            'room.created',
        );
        if (created.type === 'room.created') {
            this.roomId = created.payload.roomId as string;
            this.inviteSecret = created.payload.inviteSecret as string;
            this.participantId = created.payload.selfParticipantId as string;
        }
        return created;
    }

    async joinRoom(roomId: string, inviteSecret: string, overrides: Record<string, unknown> = {}): Promise<Envelope> {
        const snapshot = await this.request(
            'room.join',
            { roomId, inviteSecret, displayName: 'Guest', deviceLabel: 'TV', ...overrides },
            'room.snapshot',
        );
        if (snapshot.type === 'room.snapshot') {
            this.roomId = roomId;
            this.participantId = snapshot.payload.selfParticipantId as string;
        }
        return snapshot;
    }

    /** Marks this client ready for the given media revision. */
    async ready(mediaRevision = 1, overrides: Record<string, unknown> = {}): Promise<void> {
        this.send('participant.ready', {
            ready: true,
            loaded: true,
            buffering: false,
            durationMs: 3_480_000,
            mediaRevision,
            sourceFingerprint: 'torrent:abc:0',
            ...overrides,
        });
        await this.waitFor(
            (envelope) =>
                envelope.type === 'participant.updated' &&
                (envelope.payload.participant as { participantId: string }).participantId === this.participantId,
        );
    }

    close(): Promise<void> {
        return new Promise((resolve) => {
            if (this.socket.readyState === this.socket.CLOSED) {
                resolve();
                return;
            }
            this.socket.once('close', () => resolve());
            this.socket.close();
        });
    }
}
