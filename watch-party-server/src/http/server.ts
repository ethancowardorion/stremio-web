// Copyright (C) 2017-2026 Smart code 203358507

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from '../config.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import { createConnection } from '../ws/connection.ts';
import { WatchPartyService } from '../ws/handlers.ts';
import { KeyedRateLimiter } from '../ws/rateLimit.ts';
import { WS_PATH, clientAddress, evaluateUpgrade, requestPath } from '../ws/upgrade.ts';

/**
 * HTTP surface and WebSocket upgrade.
 *
 * The public listener exposes only `/healthz`, `/readyz` and the WebSocket path.
 * Metrics live on a separate internal listener so `/metrics` is not reachable
 * from the internet by default (plan section 8.1).
 */

export type WatchPartyServer = {
    readonly service: WatchPartyService;
    readonly publicPort: number;
    readonly metricsPort: number | null;
    listen(): Promise<void>;
    close(): Promise<void>;
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
    });
    response.end(payload);
};

const sendText = (response: ServerResponse, status: number, body: string, contentType: string): void => {
    response.writeHead(status, {
        'content-type': contentType,
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    response.end(body);
};

export const createWatchPartyServer = (dependencies: {
    config: Config;
    logger: Logger;
    metrics: Metrics;
    now?: () => number;
}): WatchPartyServer => {
    const { config, logger, metrics } = dependencies;
    const now = dependencies.now ?? Date.now;
    const service = new WatchPartyService({ config, logger, metrics, now });

    const connectionLimiter = new KeyedRateLimiter({
        ratePerSec: config.rateLimits.connectPerMinutePerIp / 60,
        burst: config.rateLimits.connectPerMinutePerIp,
    });

    let ready = false;
    let shuttingDown = false;

    const publicServer: Server = createServer((request, response) => {
        const path = requestPath(request);
        if (path === '/healthz') {
            sendJson(response, 200, { status: 'ok' });
            return;
        }
        if (path === '/readyz') {
            const healthy = ready && !shuttingDown;
            sendJson(response, healthy ? 200 : 503, { status: healthy ? 'ready' : 'unavailable' });
            return;
        }
        sendJson(response, 404, { error: 'not_found' });
    });

    // `noServer` keeps upgrade admission in our hands: origin and per-IP checks
    // run before a socket is ever created.
    // The frame cap is slightly above the protocol cap so that a marginally
    // oversized message produces a `MESSAGE_TOO_LARGE` error the client can act
    // on, rather than an unexplained transport-level close.
    const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes + 4096 });

    publicServer.on('upgrade', (request: IncomingMessage, socket, head) => {
        const decision = evaluateUpgrade(request, {
            allowedOrigins: config.allowedOrigins,
            trustProxy: config.trustProxy,
            allowConnection: (address) => connectionLimiter.tryConsume(address, now()),
        });

        if (!decision.allowed || shuttingDown) {
            const reason = shuttingDown ? 'shutting_down' : decision.allowed ? 'unknown' : decision.reason;
            metrics.connectionsRejectedTotal.inc({ reason });
            logger.warn('upgrade_rejected', { reason, path: requestPath(request) });
            const status = reason === 'bad_path' ? '404 Not Found' : reason === 'rate_limited' ? '429 Too Many Requests' : '403 Forbidden';
            socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (socket_) => {
            wss.emit('connection', socket_, request);
        });
    });

    wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
        const connection = createConnection(socket, {
            config,
            remoteAddress: clientAddress(request, config.trustProxy),
            nowMs: now(),
        });
        service.handleOpen(connection);

        // Liveness: a peer that stops answering pings is dropped rather than
        // held open, otherwise a half-open socket leaks a participant slot.
        let alive = true;
        socket.on('pong', () => {
            alive = true;
        });
        const heartbeat = setInterval(() => {
            if (!alive) {
                socket.terminate();
                return;
            }
            alive = false;
            try {
                socket.ping();
            } catch {
                socket.terminate();
            }
        }, config.heartbeatIntervalMs);

        socket.on('message', (data, isBinary) => {
            if (isBinary) {
                connection.sendError('MALFORMED_MESSAGE', 'binary frames are not supported');
                return;
            }
            service.handleMessage(connection, data.toString());
        });

        socket.on('error', (error) => {
            logger.warn('socket_error', { connectionId: connection.connectionId, error });
        });

        socket.on('close', () => {
            clearInterval(heartbeat);
            service.handleClose(connection);
        });
    });

    const metricsServer: Server | null = config.metricsPort < 0
        ? null
        : createServer((request, response) => {
            if (requestPath(request) !== '/metrics') {
                sendJson(response, 404, { error: 'not_found' });
                return;
            }
            sendText(response, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
        });

    let sweepTimer: NodeJS.Timeout | null = null;

    const listenOn = (server: Server, port: number, host: string): Promise<void> =>
        new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.removeListener('error', reject);
                resolve();
            });
        });

    const closeServer = (server: Server | null): Promise<void> =>
        new Promise((resolve) => {
            if (server === null || !server.listening) {
                resolve();
                return;
            }
            server.close(() => resolve());
        });

    return {
        service,
        get publicPort() {
            const address = publicServer.address();
            return typeof address === 'object' && address !== null ? address.port : config.port;
        },
        get metricsPort() {
            const address = metricsServer?.address();
            return typeof address === 'object' && address !== null ? address.port : null;
        },
        async listen() {
            await listenOn(publicServer, config.port, config.host);
            if (metricsServer !== null) {
                await listenOn(metricsServer, config.metricsPort, config.metricsHost);
            }
            sweepTimer = setInterval(() => {
                try {
                    service.sweep();
                    connectionLimiter.sweep(now());
                } catch (error) {
                    logger.error('sweep_failed', { error: error instanceof Error ? error : String(error) });
                }
            }, config.sweepIntervalMs);
            sweepTimer.unref();
            ready = true;
            logger.info('listening', {
                port: this.publicPort,
                metricsPort: this.metricsPort,
                wsPath: WS_PATH,
                originAllowlistSize: config.allowedOrigins.length,
            });
        },
        async close() {
            shuttingDown = true;
            ready = false;
            if (sweepTimer !== null) {
                clearInterval(sweepTimer);
                sweepTimer = null;
            }
            service.shutdown();
            for (const socket of wss.clients) {
                socket.close(1001, 'server shutting down');
            }
            await new Promise<void>((resolve) => {
                wss.close(() => resolve());
            });
            for (const socket of wss.clients) {
                socket.terminate();
            }
            await Promise.all([closeServer(publicServer), closeServer(metricsServer)]);
        },
    };
};
