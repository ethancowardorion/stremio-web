// Copyright (C) 2017-2026 Smart code 203358507

// Small, defensive wrapper around web storage.
//
// Session material is kept in `sessionStorage`: a resume token identifies one
// device connection, so it must not outlive the tab or be shared between tabs.
// The only value kept in `localStorage` is the display name, which is a
// preference rather than a credential.

const SESSION_KEY = 'stremio-watch-party-session';
const INVITE_KEY_PREFIX = 'stremio-watch-party-invite:';
const DISPLAY_NAME_KEY = 'stremio-watch-party-display-name';

// A resume window is minutes, not days; anything older is certainly dead and
// should not be presented to the service.
const SESSION_MAX_AGE_MS = 10 * 60 * 1000;

// Storage throws in private-browsing modes and is absent outside the browser, so
// every access is guarded and failure is always non-fatal.
const safeStorage = (factory) => {
    let storage = null;
    try {
        storage = factory();
        if (storage === null || storage === undefined) {
            return null;
        }
        const probe = '__stremio_watch_party_probe__';
        storage.setItem(probe, '1');
        storage.removeItem(probe);
        return storage;
    } catch (_) {
        return null;
    }
};

const defaultSessionStorage = () => (typeof window === 'undefined' ? null : window.sessionStorage);
const defaultLocalStorage = () => (typeof window === 'undefined' ? null : window.localStorage);

const createStorage = (options) => {
    const session = safeStorage((options && options.sessionStorage) || defaultSessionStorage);
    const local = safeStorage((options && options.localStorage) || defaultLocalStorage);
    const now = (options && options.now) || (() => Date.now());

    const readJson = (storage, key) => {
        if (storage === null) {
            return null;
        }
        try {
            const raw = storage.getItem(key);
            if (typeof raw !== 'string') {
                return null;
            }
            const parsed = JSON.parse(raw);
            return parsed !== null && typeof parsed === 'object' ? parsed : null;
        } catch (_) {
            return null;
        }
    };

    const writeJson = (storage, key, value) => {
        if (storage === null) {
            return false;
        }
        try {
            storage.setItem(key, JSON.stringify(value));
            return true;
        } catch (_) {
            return false;
        }
    };

    const remove = (storage, key) => {
        if (storage === null) {
            return;
        }
        try {
            storage.removeItem(key);
        } catch (_) {
            // Nothing useful to do; a stale entry is harmless because reads are
            // validated and aged out.
        }
    };

    return {
        readSession() {
            const stored = readJson(session, SESSION_KEY);
            if (stored === null || typeof stored.sessionId !== 'string' || typeof stored.resumeToken !== 'string') {
                return null;
            }
            if (typeof stored.savedAtMs !== 'number' || now() - stored.savedAtMs > SESSION_MAX_AGE_MS) {
                remove(session, SESSION_KEY);
                return null;
            }
            return {
                sessionId: stored.sessionId,
                resumeToken: stored.resumeToken,
                roomId: typeof stored.roomId === 'string' ? stored.roomId : null,
            };
        },
        writeSession(value) {
            if (!value || typeof value.sessionId !== 'string' || typeof value.resumeToken !== 'string') {
                return false;
            }
            return writeJson(session, SESSION_KEY, {
                sessionId: value.sessionId,
                resumeToken: value.resumeToken,
                roomId: typeof value.roomId === 'string' ? value.roomId : null,
                savedAtMs: now(),
            });
        },
        clearSession() {
            remove(session, SESSION_KEY);
        },
        // The invitation secret is a bearer credential. It is kept only for the
        // current tab so a reload can re-share or rejoin, and it is cleared as
        // soon as the room ends.
        readInvite(roomId) {
            const stored = readJson(session, `${INVITE_KEY_PREFIX}${roomId}`);
            return stored === null || typeof stored.inviteSecret !== 'string' ? null : stored.inviteSecret;
        },
        writeInvite(roomId, inviteSecret) {
            if (typeof roomId !== 'string' || typeof inviteSecret !== 'string') {
                return false;
            }
            return writeJson(session, `${INVITE_KEY_PREFIX}${roomId}`, { inviteSecret });
        },
        clearInvite(roomId) {
            remove(session, `${INVITE_KEY_PREFIX}${roomId}`);
        },
        readDisplayName() {
            if (local === null) {
                return null;
            }
            try {
                const value = local.getItem(DISPLAY_NAME_KEY);
                return typeof value === 'string' && value.length > 0 ? value : null;
            } catch (_) {
                return null;
            }
        },
        writeDisplayName(displayName) {
            if (local === null || typeof displayName !== 'string' || displayName.length === 0) {
                return false;
            }
            try {
                local.setItem(DISPLAY_NAME_KEY, displayName);
                return true;
            } catch (_) {
                return false;
            }
        },
        get available() {
            return session !== null;
        },
    };
};

module.exports = {
    SESSION_KEY,
    INVITE_KEY_PREFIX,
    DISPLAY_NAME_KEY,
    SESSION_MAX_AGE_MS,
    createStorage,
};
