// Copyright (C) 2017-2026 Smart code 203358507

/**
 * All tunables come from the environment so the container image stays immutable.
 *
 * Limits deliberately start conservative (plan section 13) and are meant to be
 * widened from metrics rather than guessed upward.
 */

export type Config = {
    host: string;
    port: number;
    metricsHost: string;
    /** Negative disables the internal metrics listener. */
    metricsPort: number;
    /** Empty array means "reject every browser origin"; `['*']` disables the check. */
    allowedOrigins: string[];
    trustProxy: boolean;
    logLevel: LogLevel;
    maxMessageBytes: number;
    maxRooms: number;
    maxParticipantsPerRoom: number;
    maxDisplayNameLength: number;
    /** Absolute room lifetime, regardless of activity. */
    roomTtlMs: number;
    /** Room lifetime after the last participant activity. */
    roomIdleTtlMs: number;
    /** How long a disconnected participant may resume its session. */
    resumeGraceMs: number;
    /** How long the room keeps running after the host drops before it force-pauses. */
    hostGraceMs: number;
    /** Interval for sweeping expired rooms and sessions. */
    sweepIntervalMs: number;
    /** Ping/pong liveness interval for open sockets. */
    heartbeatIntervalMs: number;
    /** Idempotency window for applied command ids. */
    commandHistorySize: number;
    /** Scheduled lead time for transitions that start playback (plan section 9.2). */
    defaultLeadMs: number;
    /** Host observations closer than this to canonical state are not rebroadcast. */
    hostObservationToleranceMs: number;
    /** How long the host must fail to make progress before the room pauses. */
    hostStallGraceMs: number;
    rateLimits: {
        clockPingPerSec: number;
        clockPingBurst: number;
        statusPerSec: number;
        statusBurst: number;
        commandPerSec: number;
        commandBurst: number;
        connectPerMinutePerIp: number;
    };
    /** Repeated protocol violations from one socket close the connection. */
    maxInvalidMessages: number;
};

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const readString = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
    const raw = env[name];
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback;
};

const readInt = (env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return fallback;
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be an integer, received ${JSON.stringify(raw)}`);
    }
    if (parsed < min || parsed > max) {
        throw new Error(`${name} must be between ${min} and ${max}, received ${parsed}`);
    }
    return parsed;
};

const readBool = (env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
    const raw = env[name];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
    }
    throw new Error(`${name} must be a boolean, received ${JSON.stringify(raw)}`);
};

const readLogLevel = (env: NodeJS.ProcessEnv, name: string, fallback: LogLevel): LogLevel => {
    const raw = readString(env, name, fallback);
    const match = LOG_LEVELS.find((level) => level === raw);
    if (match === undefined) {
        throw new Error(`${name} must be one of ${LOG_LEVELS.join(', ')}, received ${JSON.stringify(raw)}`);
    }
    return match;
};

const readOrigins = (env: NodeJS.ProcessEnv, name: string): string[] => {
    const raw = readString(env, name, '');
    if (raw.length === 0) {
        return [];
    }
    return raw
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => ({
    host: readString(env, 'WATCH_PARTY_HOST', '0.0.0.0'),
    // Port 0 is allowed: it asks the OS for an ephemeral port, which tests and
    // some container schedulers rely on.
    port: readInt(env, 'WATCH_PARTY_PORT', 8787, 0, 65535),
    metricsHost: readString(env, 'WATCH_PARTY_METRICS_HOST', '127.0.0.1'),
    // -1 disables the metrics listener entirely; 0 asks for an ephemeral port.
    metricsPort: readInt(env, 'WATCH_PARTY_METRICS_PORT', 9091, -1, 65535),
    allowedOrigins: readOrigins(env, 'WATCH_PARTY_ALLOWED_ORIGINS'),
    trustProxy: readBool(env, 'WATCH_PARTY_TRUST_PROXY', false),
    logLevel: readLogLevel(env, 'WATCH_PARTY_LOG_LEVEL', 'info'),
    maxMessageBytes: readInt(env, 'WATCH_PARTY_MAX_MESSAGE_BYTES', 256 * 1024, 1024, 4 * 1024 * 1024),
    maxRooms: readInt(env, 'WATCH_PARTY_MAX_ROOMS', 200, 1, 100_000),
    maxParticipantsPerRoom: readInt(env, 'WATCH_PARTY_MAX_PARTICIPANTS', 20, 2, 1000),
    maxDisplayNameLength: readInt(env, 'WATCH_PARTY_MAX_DISPLAY_NAME_LENGTH', 48, 1, 256),
    roomTtlMs: readInt(env, 'WATCH_PARTY_ROOM_TTL_MS', 12 * HOUR, MINUTE, 7 * 24 * HOUR),
    roomIdleTtlMs: readInt(env, 'WATCH_PARTY_ROOM_IDLE_TTL_MS', 30 * MINUTE, MINUTE, 24 * HOUR),
    resumeGraceMs: readInt(env, 'WATCH_PARTY_RESUME_GRACE_MS', 2 * MINUTE, 1000, HOUR),
    hostGraceMs: readInt(env, 'WATCH_PARTY_HOST_GRACE_MS', 20_000, 0, 10 * MINUTE),
    sweepIntervalMs: readInt(env, 'WATCH_PARTY_SWEEP_INTERVAL_MS', 15_000, 1000, 10 * MINUTE),
    heartbeatIntervalMs: readInt(env, 'WATCH_PARTY_HEARTBEAT_INTERVAL_MS', 30_000, 1000, 10 * MINUTE),
    commandHistorySize: readInt(env, 'WATCH_PARTY_COMMAND_HISTORY_SIZE', 256, 8, 8192),
    defaultLeadMs: readInt(env, 'WATCH_PARTY_DEFAULT_LEAD_MS', 750, 0, 5000),
    hostObservationToleranceMs: readInt(env, 'WATCH_PARTY_HOST_OBSERVATION_TOLERANCE_MS', 250, 0, 10_000),
    hostStallGraceMs: readInt(env, 'WATCH_PARTY_HOST_STALL_GRACE_MS', 3000, 0, 60_000),
    rateLimits: {
        clockPingPerSec: readInt(env, 'WATCH_PARTY_RATE_CLOCK_PER_SEC', 1, 1, 100),
        clockPingBurst: readInt(env, 'WATCH_PARTY_RATE_CLOCK_BURST', 8, 1, 100),
        statusPerSec: readInt(env, 'WATCH_PARTY_RATE_STATUS_PER_SEC', 2, 1, 100),
        statusBurst: readInt(env, 'WATCH_PARTY_RATE_STATUS_BURST', 5, 1, 100),
        commandPerSec: readInt(env, 'WATCH_PARTY_RATE_COMMAND_PER_SEC', 2, 1, 100),
        commandBurst: readInt(env, 'WATCH_PARTY_RATE_COMMAND_BURST', 10, 1, 100),
        connectPerMinutePerIp: readInt(env, 'WATCH_PARTY_RATE_CONNECT_PER_MINUTE', 60, 1, 10_000),
    },
    maxInvalidMessages: readInt(env, 'WATCH_PARTY_MAX_INVALID_MESSAGES', 5, 1, 1000),
});
