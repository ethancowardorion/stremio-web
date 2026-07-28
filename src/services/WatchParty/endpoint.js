// Copyright (C) 2017-2026 Smart code 203358507

// Resolves the room service endpoint.
//
// Deployment puts the service behind the same TLS origin as the web build
// (plan section 15.2), so the default is derived from the current origin rather
// than configured. An explicit `WATCH_PARTY_WS_URL` overrides it for development
// and for split deployments.

const DEFAULT_PATH = '/watch-party/ws';

// A page served over HTTPS may only open a WSS socket; mixing the two is blocked
// by the browser and produces a confusing "connection failed" with no detail.
const schemeForLocation = (location) => (location && location.protocol === 'https:' ? 'wss:' : 'ws:');

const resolveWatchPartyUrl = (options) => {
    const configured = options && options.configuredUrl;
    if (typeof configured === 'string' && configured.length > 0) {
        return configured;
    }
    const location = options && options.location;
    if (!location || typeof location.host !== 'string' || location.host.length === 0) {
        return null;
    }
    const path = (options && options.path) || DEFAULT_PATH;
    return `${schemeForLocation(location)}//${location.host}${path}`;
};

// The invitation a host copies. It is a normal hash route so the desktop shell
// and the PWA both open it without a deep-link handler change.
const buildInvitationUrl = (options) => {
    const roomId = options && options.roomId;
    const inviteSecret = options && options.inviteSecret;
    if (typeof roomId !== 'string' || typeof inviteSecret !== 'string') {
        return null;
    }
    const origin = (options && options.origin) || '';
    return `${origin}/#/watch-party/${encodeURIComponent(roomId)}?invite=${encodeURIComponent(inviteSecret)}`;
};

module.exports = {
    DEFAULT_PATH,
    resolveWatchPartyUrl,
    buildInvitationUrl,
};
