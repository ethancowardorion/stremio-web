// Copyright (C) 2017-2026 Smart code 203358507

// Maps machine-readable protocol error codes to interface copy.
//
// The service's `message` field is developer-facing and is never rendered:
// it can carry internal detail and is not translated.

const ERROR_TRANSLATION_KEYS = {
    ROOM_NOT_FOUND: 'WATCH_PARTY_ERROR_ROOM_NOT_FOUND',
    ROOM_FULL: 'WATCH_PARTY_ERROR_ROOM_FULL',
    ROOM_LIMIT_REACHED: 'WATCH_PARTY_ERROR_ROOM_NOT_FOUND',
    RATE_LIMITED: 'WATCH_PARTY_ERROR_RATE_LIMITED',
    UNSUPPORTED_PROTOCOL_VERSION: 'WATCH_PARTY_ERROR_UNSUPPORTED_VERSION',
    RESUME_REJECTED: 'WATCH_PARTY_ERROR_ROOM_NOT_FOUND',
    UNSUPPORTED_MEDIA: 'WATCH_PARTY_LIVE_BLOCKED',
    CAPABILITY_REQUIRED: 'WATCH_PARTY_UNSUPPORTED_PLAYER',
    NOT_CONNECTED: 'WATCH_PARTY_ERROR_CONNECTION',
    CONNECTION_FAILED: 'WATCH_PARTY_ERROR_CONNECTION',
    CONNECTION_LOST: 'WATCH_PARTY_ERROR_CONNECTION',
    REQUEST_TIMEOUT: 'WATCH_PARTY_ERROR_CONNECTION',
    NO_ENDPOINT: 'WATCH_PARTY_UNAVAILABLE',
};

const CLOSE_REASON_TRANSLATION_KEYS = {
    host_ended: 'WATCH_PARTY_ROOM_CLOSED_HOST_ENDED',
    host_left: 'WATCH_PARTY_ROOM_CLOSED_HOST_LEFT',
    expired: 'WATCH_PARTY_ROOM_CLOSED_EXPIRED',
    server_shutdown: 'WATCH_PARTY_ROOM_CLOSED_SERVER',
    left: 'WATCH_PARTY_ROOM_CLOSED_LEFT',
};

const errorTranslationKey = (error) => {
    if (!error || typeof error.code !== 'string') {
        return null;
    }
    return ERROR_TRANSLATION_KEYS[error.code] || 'WATCH_PARTY_ERROR_GENERIC';
};

const closeReasonTranslationKey = (reason) =>
    typeof reason === 'string' && CLOSE_REASON_TRANSLATION_KEYS[reason]
        ? CLOSE_REASON_TRANSLATION_KEYS[reason]
        : null;

module.exports = {
    ERROR_TRANSLATION_KEYS,
    CLOSE_REASON_TRANSLATION_KEYS,
    errorTranslationKey,
    closeReasonTranslationKey,
};
