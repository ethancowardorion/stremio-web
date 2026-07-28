// Copyright (C) 2017-2026 Smart code 203358507

// Fork-local interface strings.
//
// These are merged over `stremio-translations` at startup so the watch party can
// ship without waiting on the upstream translation project. If the feature is
// ever proposed upstream these keys move there and this file disappears.

const WATCH_PARTY_TRANSLATIONS = {
    'en-US': {
        WATCH_PARTY: 'Watch party',
        WATCH_PARTY_JOIN_TITLE: 'Join watch party',
        WATCH_PARTY_UNAVAILABLE: 'Watch parties are not configured for this deployment.',

        WATCH_PARTY_CONNECTING: 'Connecting to the watch party service',
        WATCH_PARTY_RECONNECTING: 'Reconnecting',
        WATCH_PARTY_DISCONNECTED: 'Disconnected',
        WATCH_PARTY_CONNECTED: 'Connected',

        WATCH_PARTY_DISPLAY_NAME: 'Your name',
        WATCH_PARTY_DISPLAY_NAME_PLACEHOLDER: 'Name shown to the party',
        WATCH_PARTY_DEVICE_LABEL: 'This device',
        WATCH_PARTY_DEVICE_LABEL_PLACEHOLDER: 'Laptop, TV, phone',

        WATCH_PARTY_CREATE: 'Start watch party',
        WATCH_PARTY_CREATING: 'Creating room',
        WATCH_PARTY_JOIN: 'Join',
        WATCH_PARTY_JOINING: 'Joining',
        WATCH_PARTY_LEAVE: 'Leave party',
        WATCH_PARTY_END: 'End party for everyone',
        WATCH_PARTY_RETRY: 'Try again',
        WATCH_PARTY_OPEN_PLAYER: 'Open player',
        WATCH_PARTY_COPY_INVITATION: 'Copy invitation',
        WATCH_PARTY_COPIED: 'Invitation copied',

        WATCH_PARTY_PARTICIPANTS: 'Participants',
        WATCH_PARTY_HOST: 'Host',
        WATCH_PARTY_GUEST: 'Guest',
        WATCH_PARTY_YOU: 'You',
        WATCH_PARTY_NOW_PLAYING: 'Now playing',

        WATCH_PARTY_STATUS_READY: 'Ready',
        WATCH_PARTY_STATUS_LOADING: 'Loading',
        WATCH_PARTY_STATUS_BUFFERING: 'Buffering',
        WATCH_PARTY_STATUS_OFFLINE: 'Offline',
        WATCH_PARTY_STATUS_UNSUPPORTED: 'Unsupported player',

        WATCH_PARTY_WAITING_FOR_HOST: 'Waiting for the host to start',
        WATCH_PARTY_WAITING_FOR_PARTICIPANTS: 'Waiting for everyone to be ready',
        WATCH_PARTY_CONTROLS_LOCKED: 'The host controls playback',
        WATCH_PARTY_REQUIRE_ALL_READY: 'Wait for everyone before starting',

        WATCH_PARTY_ACTIVATION_REQUIRED: 'Your browser blocked playback. Click to start watching together.',
        WATCH_PARTY_ACTIVATE: 'Start synchronized playback',

        WATCH_PARTY_SOURCE_MISMATCH: 'This device loaded a different source than the rest of the party.',
        WATCH_PARTY_DURATION_MISMATCH: 'This copy has a different length than the host\'s, so playback cannot be synchronized.',
        WATCH_PARTY_SOURCE_FAILED: 'The shared source could not be loaded on this device.',
        WATCH_PARTY_REFRESH_SOURCE: 'Reshare current source',

        WATCH_PARTY_UNSUPPORTED_PLAYER: 'This player cannot be synchronized, so you can only watch along.',
        WATCH_PARTY_CASTING_BLOCKED: 'Stop casting before starting or joining a watch party.',
        WATCH_PARTY_LIVE_BLOCKED: 'Live streams cannot be synchronized.',

        WATCH_PARTY_ROOM_CLOSED_HOST_ENDED: 'The host ended the watch party.',
        WATCH_PARTY_ROOM_CLOSED_HOST_LEFT: 'The host disconnected and did not come back.',
        WATCH_PARTY_ROOM_CLOSED_EXPIRED: 'This watch party is no longer available.',
        WATCH_PARTY_ROOM_CLOSED_SERVER: 'The watch party service restarted. Start a new party to continue.',
        WATCH_PARTY_ROOM_CLOSED_LEFT: 'You left the watch party.',

        WATCH_PARTY_ERROR_INVALID_INVITATION: 'This invitation is missing or incomplete.',
        WATCH_PARTY_ERROR_ROOM_NOT_FOUND: 'This watch party is no longer available.',
        WATCH_PARTY_ERROR_ROOM_FULL: 'This watch party is full.',
        WATCH_PARTY_ERROR_RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
        WATCH_PARTY_ERROR_UNSUPPORTED_VERSION: 'This app is not compatible with the watch party service. Reload to update.',
        WATCH_PARTY_ERROR_CONNECTION: 'Could not reach the watch party service.',
        WATCH_PARTY_ERROR_GENERIC: 'Something went wrong with the watch party.',
    },
};

// Shallow merge over the upstream bundle. Only locales that already exist gain
// the keys; the fallback locale covers the rest.
const withWatchPartyTranslations = (translations) => {
    const merged = { ...translations };
    Object.keys(WATCH_PARTY_TRANSLATIONS).forEach((locale) => {
        merged[locale] = { ...(merged[locale] || {}), ...WATCH_PARTY_TRANSLATIONS[locale] };
    });
    return merged;
};

module.exports = {
    WATCH_PARTY_TRANSLATIONS,
    withWatchPartyTranslations,
};
