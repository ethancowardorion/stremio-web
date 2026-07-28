// Copyright (C) 2017-2026 Smart code 203358507

import { loadConfig } from './config.ts';
import { createWatchPartyServer } from './http/server.ts';
import { createLogger } from './observability/logger.ts';
import { createMetrics } from './observability/metrics.ts';

/**
 * Service entrypoint.
 *
 * Configuration errors fail fast and loudly: starting with a silently defaulted
 * origin allowlist would be worse than not starting at all.
 */
const main = async (): Promise<void> => {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const metrics = createMetrics();

    if (config.allowedOrigins.length === 0) {
        logger.warn('origin_allowlist_empty', {
            hint: 'set WATCH_PARTY_ALLOWED_ORIGINS; browser clients will be rejected',
        });
    }

    const server = createWatchPartyServer({ config, logger, metrics });
    await server.listen();

    let closing = false;
    const shutdown = (signal: string): void => {
        if (closing) {
            return;
        }
        closing = true;
        logger.info('shutdown_started', { signal });
        server
            .close()
            .then(() => {
                logger.info('shutdown_complete', { signal });
                process.exit(0);
            })
            .catch((error: unknown) => {
                logger.error('shutdown_failed', { error: error instanceof Error ? error : String(error) });
                process.exit(1);
            });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger.error('unhandled_rejection', { error: reason instanceof Error ? reason : String(reason) });
    });
    process.on('uncaughtException', (error) => {
        logger.error('uncaught_exception', { error });
        shutdown('uncaughtException');
    });
};

main().catch((error: unknown) => {
    // The logger may not exist yet, so this is the one place plain stderr is used.
    process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'startup_failed', error: String(error) })}\n`);
    process.exit(1);
});
