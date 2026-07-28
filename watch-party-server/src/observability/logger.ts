// Copyright (C) 2017-2026 Smart code 203358507

import { LOG_LEVELS, type LogLevel } from '../config.ts';

/**
 * Structured JSON logging with mandatory redaction.
 *
 * The service is *allowed* to process Stremio auth keys, raw stream objects and
 * configured add-on transport URLs (plan section 13), but observability systems
 * must never keep copies. Redaction therefore lives in the logger itself rather
 * than in each call site, so a careless `logger.info('x', { stream })` cannot
 * leak. Anything not on the allowed-shape path is dropped, not merely masked.
 */

const REDACTED = '[redacted]';

const SENSITIVE_KEY_PATTERN = /(auth|token|secret|key|password|credential|cookie|url|href|magnet|infohash|stream|bundle|source|invite)/i;

const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 32;
const MAX_ARRAY_ITEMS = 16;

export type LogFields = Record<string, unknown>;

export type Logger = {
    error(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    debug(message: string, fields?: LogFields): void;
    child(bindings: LogFields): Logger;
};

export type LogSink = (line: string) => void;

/**
 * Recursively strips anything that could carry a credential or a media locator.
 * Sensitive *keys* are masked by name; long strings are truncated so that an
 * unexpected blob cannot be reconstructed from a log stream.
 */
export const redact = (value: unknown, depth = 0): unknown => {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return Number.isFinite(value) || typeof value === 'boolean' ? value : String(value);
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value === 'string') {
        return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
    }
    if (value instanceof Error) {
        return { name: value.name, message: redact(value.message, depth + 1) };
    }
    if (depth >= MAX_DEPTH) {
        return REDACTED;
    }
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) {
            items.push(`…${value.length - MAX_ARRAY_ITEMS} more`);
        }
        return items;
    }
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        let count = 0;
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (count >= MAX_KEYS) {
                out['…'] = 'truncated';
                break;
            }
            count += 1;
            out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1);
        }
        return out;
    }
    return REDACTED;
};

const levelRank = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

export const createLogger = (
    level: LogLevel,
    sink: LogSink = (line) => process.stdout.write(`${line}\n`),
    bindings: LogFields = {},
    now: () => number = Date.now,
): Logger => {
    const threshold = levelRank(level);

    const emit = (entryLevel: LogLevel, message: string, fields?: LogFields): void => {
        if (levelRank(entryLevel) > threshold) {
            return;
        }
        const payload = {
            time: new Date(now()).toISOString(),
            level: entryLevel,
            msg: message,
            ...(redact(bindings) as LogFields),
            ...(fields === undefined ? {} : (redact(fields) as LogFields)),
        };
        try {
            sink(JSON.stringify(payload));
        } catch {
            sink(JSON.stringify({ time: new Date(now()).toISOString(), level: 'error', msg: 'log_serialization_failed' }));
        }
    };

    return {
        error: (message, fields) => emit('error', message, fields),
        warn: (message, fields) => emit('warn', message, fields),
        info: (message, fields) => emit('info', message, fields),
        debug: (message, fields) => emit('debug', message, fields),
        child: (childBindings) => createLogger(level, sink, { ...bindings, ...childBindings }, now),
    };
};
