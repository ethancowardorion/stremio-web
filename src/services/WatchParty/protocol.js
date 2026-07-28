// Copyright (C) 2017-2026 Smart code 203358507

// Wire protocol shared with the watch party room service. Pure and free of React
// and DOM references so it can be unit tested directly under Node.

const PROTOCOL_VERSION = 1;

const CLIENT_MESSAGE = {
    SESSION_HELLO: 'session.hello',
    CLOCK_PING: 'clock.ping',
    ROOM_CREATE: 'room.create',
    ROOM_JOIN: 'room.join',
    ROOM_LEAVE: 'room.leave',
    ROOM_CLOSE: 'room.close',
    PARTICIPANT_READY: 'participant.ready',
    PLAYBACK_COMMAND: 'playback.command',
    PLAYBACK_OBSERVATION: 'playback.observation',
    MEDIA_CHANGE: 'media.change',
    SOURCE_REFRESH: 'source.refresh',
};

const SERVER_MESSAGE = {
    SESSION_WELCOME: 'session.welcome',
    CLOCK_PONG: 'clock.pong',
    ROOM_CREATED: 'room.created',
    ROOM_SNAPSHOT: 'room.snapshot',
    ROOM_UPDATED: 'room.updated',
    PARTICIPANT_UPDATED: 'participant.updated',
    PARTICIPANT_LEFT: 'participant.left',
    PLAYBACK_STATE: 'playback.state',
    MEDIA_CHANGED: 'media.changed',
    SOURCE_UPDATED: 'source.updated',
    ROOM_CLOSED: 'room.closed',
    ERROR: 'error',
};

const SERVER_MESSAGE_TYPES = Object.values(SERVER_MESSAGE);

const PLAYBACK_ACTION = {
    PLAY: 'play',
    PAUSE: 'pause',
    SEEK: 'seek',
    RATE: 'rate',
};

// Capabilities the service requires before a client is treated as synchronized
// rather than as an observer.
const REQUIRED_CAPABILITIES = ['scheduledActions'];

const isPlainObject = (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const createEnvelope = (type, payload, options) => {
    const envelope = {
        v: PROTOCOL_VERSION,
        type,
        payload: payload === undefined ? {} : payload,
    };
    if (options && typeof options.requestId === 'string') {
        envelope.requestId = options.requestId;
    }
    if (options && typeof options.roomId === 'string') {
        envelope.roomId = options.roomId;
    }
    return envelope;
};

// Parses a frame from the service. Returns a result object rather than throwing,
// because a malformed frame is an expected network condition and must not be able
// to take down the provider.
const parseServerMessage = (raw) => {
    if (typeof raw !== 'string') {
        return { ok: false, reason: 'not-a-string' };
    }

    let decoded;
    try {
        decoded = JSON.parse(raw);
    } catch (_) {
        return { ok: false, reason: 'invalid-json' };
    }

    if (!isPlainObject(decoded)) {
        return { ok: false, reason: 'not-an-object' };
    }
    if (decoded.v !== PROTOCOL_VERSION) {
        return { ok: false, reason: 'unsupported-version', version: decoded.v };
    }
    if (typeof decoded.type !== 'string' || !SERVER_MESSAGE_TYPES.includes(decoded.type)) {
        return { ok: false, reason: 'unknown-type', messageType: decoded.type };
    }
    if (!isPlainObject(decoded.payload)) {
        return { ok: false, reason: 'invalid-payload' };
    }

    const envelope = {
        v: decoded.v,
        type: decoded.type,
        payload: decoded.payload,
    };
    if (typeof decoded.requestId === 'string') {
        envelope.requestId = decoded.requestId;
    }
    if (typeof decoded.roomId === 'string') {
        envelope.roomId = decoded.roomId;
    }
    return { ok: true, envelope };
};

// Derives the capability manifest from the active stremio-video implementation.
// Advertising rather than assuming keeps cast, shell and TV implementations from
// silently claiming synchronization they cannot deliver.
const playerCapabilities = (manifest) => {
    const props = Array.isArray(manifest && manifest.props) ? manifest.props : [];
    const commands = Array.isArray(manifest && manifest.commands) ? manifest.commands : [];
    return {
        // Scheduled actions need both an observable and a settable timeline.
        scheduledActions: props.includes('time') && props.includes('paused'),
        observeBuffering: props.includes('buffering'),
        setPlaybackRate: props.includes('playbackSpeed'),
        navigateNext: commands.includes('load'),
        playerImplementation: typeof (manifest && manifest.name) === 'string' ? manifest.name : 'unknown',
    };
};

const missingCapabilities = (capabilities) =>
    REQUIRED_CAPABILITIES.filter((name) => !capabilities || capabilities[name] !== true);

const isSupportedClient = (capabilities) => missingCapabilities(capabilities).length === 0;

module.exports = {
    PROTOCOL_VERSION,
    CLIENT_MESSAGE,
    SERVER_MESSAGE,
    SERVER_MESSAGE_TYPES,
    PLAYBACK_ACTION,
    REQUIRED_CAPABILITIES,
    createEnvelope,
    parseServerMessage,
    playerCapabilities,
    missingCapabilities,
    isSupportedClient,
};
