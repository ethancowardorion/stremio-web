// Copyright (C) 2017-2023 Smart code 203358507

const {
    ACTION,
    CONNECTION_STATUS,
    initialState,
    reduce,
    selectSelf,
    selectHost,
    selectIsHost,
    selectIsFollower,
} = require('../src/services/WatchParty/reducer');
const { PROTOCOL_VERSION, SERVER_MESSAGE } = require('../src/services/WatchParty/protocol');

const message = (type, payload, requestId) => ({
    type: ACTION.MESSAGE,
    envelope: { v: PROTOCOL_VERSION, type, payload, ...(requestId ? { requestId } : {}) },
});

const participant = (overrides) => ({
    participantId: 'p-host',
    displayName: 'Host',
    deviceLabel: 'Laptop',
    isHost: true,
    connected: true,
    ready: false,
    loaded: false,
    buffering: false,
    durationMs: null,
    mediaRevision: 1,
    sourceFingerprint: null,
    capabilities: {},
    supported: true,
    joinedAtServerMs: 0,
    lastSeenServerMs: 0,
    ...overrides,
});

const playback = (overrides) => ({
    revision: 1,
    mediaRevision: 1,
    paused: true,
    positionMs: 0,
    rate: 1,
    updatedAtServerMs: 1000,
    effectiveAtServerMs: 1000,
    ...overrides,
});

const snapshotPayload = (overrides = {}) => ({
    room: {
        roomId: 'room-1',
        hostParticipantId: 'p-host',
        createdAtServerMs: 1000,
        expiresAtServerMs: 99_000,
        revision: 1,
        mediaRevision: 1,
        media: { type: 'series', metaId: 'tt1', videoId: 'tt1:1:1', title: 'Pilot', expectedDurationMs: 1000, live: false },
        source: { fingerprint: 'torrent:abc:0', streamParam: 'encoded' },
        playback: playback(),
        participants: [participant()],
        policy: { allowGuestPlayPause: false, requireAllReadyToStart: true, pauseOnGuestBuffering: false },
        serverTimeMs: 1000,
        ...overrides.room,
    },
    selfParticipantId: 'p-host',
    ...overrides,
});

// A client in a room has always completed a handshake first, so the helper
// mirrors that order: welcome, then snapshot.
const welcomed = () => reduce(initialState, message(SERVER_MESSAGE.SESSION_WELCOME, {
    sessionId: 's1',
    resumed: false,
    supported: true,
    missingCapabilities: [],
    requiredCapabilities: ['scheduledActions'],
    limits: {},
    serverTimeMs: 1000,
}));

const joined = () => reduce(welcomed(), message(SERVER_MESSAGE.ROOM_SNAPSHOT, snapshotPayload()));

describe('watch party reducer: connection lifecycle', () => {
    it('distinguishes a first connection from a reconnection', () => {
        const connecting = reduce(initialState, { type: ACTION.CONNECTING });
        expect(connecting.status).toBe(CONNECTION_STATUS.CONNECTING);

        const withSession = { ...initialState, session: { sessionId: 's1' } };
        expect(reduce(withSession, { type: ACTION.CONNECTING }).status).toBe(CONNECTION_STATUS.RECONNECTING);
    });

    it('treats the handshake, not the open socket, as connected', () => {
        const open = reduce(initialState, { type: ACTION.OPEN });
        expect(open.status).toBe(CONNECTION_STATUS.IDLE);

        const welcomed = reduce(open, message(SERVER_MESSAGE.SESSION_WELCOME, {
            sessionId: 's1',
            resumed: false,
            supported: true,
            missingCapabilities: [],
            requiredCapabilities: ['scheduledActions'],
            limits: { maxMessageBytes: 1024 },
            serverTimeMs: 4242,
        }));
        expect(welcomed.status).toBe(CONNECTION_STATUS.CONNECTED);
        expect(welcomed.session.sessionId).toBe('s1');
        expect(welcomed.session.supported).toBe(true);
        expect(welcomed.serverTimeMs).toBe(4242);
    });

    it('marks the local participant offline and unready when the socket drops', () => {
        const dropped = reduce(joined(), { type: ACTION.CLOSED });
        expect(dropped.status).toBe(CONNECTION_STATUS.RECONNECTING);
        expect(selectSelf(dropped).connected).toBe(false);
        expect(selectSelf(dropped).ready).toBe(false);
    });

    it('stops reconnecting when a close is permanent', () => {
        expect(reduce(joined(), { type: ACTION.CLOSED, permanent: true }).status).toBe(CONNECTION_STATUS.CLOSED);
    });

    it('does not claim to be reconnecting when it never connected', () => {
        // Tearing down a client that never completed a handshake must not look
        // like a lost connection to a service that was never reached.
        expect(reduce(initialState, { type: ACTION.CLOSED }).status).toBe(CONNECTION_STATUS.CLOSED);
    });

    it('records the last error without discarding room state', () => {
        const errored = reduce(joined(), message(SERVER_MESSAGE.ERROR, { code: 'RATE_LIMITED', message: 'slow down' }, 'r7'));
        expect(errored.lastError).toEqual({ code: 'RATE_LIMITED', message: 'slow down', requestId: 'r7' });
        expect(errored.room.roomId).toBe('room-1');
    });
});

describe('watch party reducer: room state', () => {
    it('adopts a snapshot wholesale', () => {
        const state = joined();
        expect(state.room.roomId).toBe('room-1');
        expect(state.mediaRevision).toBe(1);
        expect(state.selfParticipantId).toBe('p-host');
        expect(state.participants).toHaveLength(1);
        expect(selectIsHost(state)).toBe(true);
        expect(selectIsFollower(state)).toBe(false);
    });

    it('keeps the invitation secret only from room.created', () => {
        const created = reduce(initialState, message(SERVER_MESSAGE.ROOM_CREATED, {
            ...snapshotPayload(),
            roomId: 'room-1',
            inviteSecret: 'a-very-secret-value',
        }));
        expect(created.inviteSecret).toBe('a-very-secret-value');
        // A later snapshot must not clear it, and must not invent one either.
        expect(reduce(created, message(SERVER_MESSAGE.ROOM_SNAPSHOT, snapshotPayload())).inviteSecret).toBe('a-very-secret-value');
        expect(joined().inviteSecret).toBeNull();
    });

    it('identifies the follower role for a guest', () => {
        const guestState = reduce(initialState, message(SERVER_MESSAGE.ROOM_SNAPSHOT, {
            ...snapshotPayload({
                room: {
                    ...snapshotPayload().room,
                    participants: [participant(), participant({ participantId: 'p-guest', displayName: 'Guest', isHost: false })],
                },
            }),
            selfParticipantId: 'p-guest',
        }));
        expect(selectIsHost(guestState)).toBe(false);
        expect(selectIsFollower(guestState)).toBe(true);
        expect(selectHost(guestState).participantId).toBe('p-host');
        expect(selectSelf(guestState).displayName).toBe('Guest');
    });

    it('applies a live room policy update', () => {
        const updated = reduce(joined(), message(SERVER_MESSAGE.ROOM_UPDATED, {
            policy: {
                allowGuestPlayPause: true,
                requireAllReadyToStart: true,
                pauseOnGuestBuffering: false,
                pauseOnHostStall: true,
            },
        }));
        expect(updated.room.policy.allowGuestPlayPause).toBe(true);
    });

    it('upserts participants rather than duplicating them', () => {
        const withGuest = reduce(joined(), message(SERVER_MESSAGE.PARTICIPANT_UPDATED, {
            participant: participant({ participantId: 'p-guest', isHost: false, displayName: 'Guest' }),
        }));
        expect(withGuest.participants).toHaveLength(2);

        const updated = reduce(withGuest, message(SERVER_MESSAGE.PARTICIPANT_UPDATED, {
            participant: participant({ participantId: 'p-guest', isHost: false, displayName: 'Guest', ready: true }),
        }));
        expect(updated.participants).toHaveLength(2);
        expect(updated.participants.find((p) => p.participantId === 'p-guest').ready).toBe(true);
    });

    it('removes a departed participant and ignores an unknown one', () => {
        const withGuest = reduce(joined(), message(SERVER_MESSAGE.PARTICIPANT_UPDATED, {
            participant: participant({ participantId: 'p-guest', isHost: false }),
        }));
        expect(reduce(withGuest, message(SERVER_MESSAGE.PARTICIPANT_LEFT, { participantId: 'p-guest' })).participants).toHaveLength(1);
        expect(reduce(withGuest, message(SERVER_MESSAGE.PARTICIPANT_LEFT, { participantId: 'nobody' })).participants).toHaveLength(2);
    });

    it('ignores malformed participant frames', () => {
        const state = joined();
        expect(reduce(state, message(SERVER_MESSAGE.PARTICIPANT_UPDATED, {}))).toBe(state);
        expect(reduce(state, message(SERVER_MESSAGE.PARTICIPANT_LEFT, { participantId: 7 }))).toBe(state);
    });

    it('clears everything when the room closes and keeps the reason', () => {
        const closed = reduce(joined(), message(SERVER_MESSAGE.ROOM_CLOSED, { reason: 'host_left' }));
        expect(closed.room).toBeNull();
        expect(closed.playback).toBeNull();
        expect(closed.participants).toEqual([]);
        expect(closed.inviteSecret).toBeNull();
        expect(closed.closeReason).toBe('host_left');
        expect(closed.status).toBe(CONNECTION_STATUS.CLOSED);
        expect(closed.session).toBeNull();
    });

    it('restores an invitation only for the current room', () => {
        const state = joined();
        const unchanged = reduce(state, {
            type: ACTION.RESTORE_INVITE,
            roomId: 'another-room',
            inviteSecret: 'secret',
        });
        expect(unchanged).toBe(state);

        const restored = reduce(state, {
            type: ACTION.RESTORE_INVITE,
            roomId: state.room.roomId,
            inviteSecret: 'secret',
        });
        expect(restored.inviteSecret).toBe('secret');
    });

    it('resets room state on an explicit local leave but keeps the session', () => {
        const left = reduce(joined(), { type: ACTION.LEAVE });
        expect(left.room).toBeNull();
        expect(left.participants).toEqual([]);
        expect(left.status).toBe(joined().status);
    });
});

describe('watch party reducer: revision ordering', () => {
    it('applies a strictly newer playback revision', () => {
        const next = reduce(joined(), message(SERVER_MESSAGE.PLAYBACK_STATE, {
            playback: playback({ revision: 2, paused: false, positionMs: 5000 }),
            serverTimeMs: 2000,
        }));
        expect(next.playback.revision).toBe(2);
        expect(next.playback.paused).toBe(false);
        expect(next.serverTimeMs).toBe(2000);
    });

    it('remembers why the service paused the room, and forgets it on the next change', () => {
        const stalled = reduce(joined(), message(SERVER_MESSAGE.PLAYBACK_STATE, {
            playback: playback({ revision: 2, paused: true, positionMs: 2150 }),
            reason: 'host_stalled',
        }));
        expect(stalled.pauseReason).toBe('host_stalled');

        // Resuming carries no reason, so the explanation must not linger.
        const resumed = reduce(stalled, message(SERVER_MESSAGE.PLAYBACK_STATE, {
            playback: playback({ revision: 3, paused: false, positionMs: 2150 }),
        }));
        expect(resumed.pauseReason).toBeNull();
    });

    it('ignores an equal or older revision, so a replay cannot rewind playback', () => {
        const advanced = reduce(joined(), message(SERVER_MESSAGE.PLAYBACK_STATE, {
            playback: playback({ revision: 5, positionMs: 60_000 }),
        }));
        const replayed = reduce(advanced, message(SERVER_MESSAGE.PLAYBACK_STATE, {
            playback: playback({ revision: 5, positionMs: 0 }),
        }));
        const older = reduce(advanced, message(SERVER_MESSAGE.PLAYBACK_STATE, {
            playback: playback({ revision: 4, positionMs: 0 }),
        }));
        expect(replayed.playback.positionMs).toBe(60_000);
        expect(older.playback.positionMs).toBe(60_000);
    });

    it('accepts a lower revision when the media revision moved forward', () => {
        // A new episode restarts the room's playback numbering context; the media
        // revision is what decides which timeline a frame belongs to.
        const changed = reduce(joined(), message(SERVER_MESSAGE.MEDIA_CHANGED, {
            mediaRevision: 2,
            media: { type: 'series', metaId: 'tt1', videoId: 'tt1:1:2', title: 'Episode 2', expectedDurationMs: 1000, live: false },
            source: { fingerprint: 'torrent:def:1' },
            playback: playback({ revision: 2, mediaRevision: 2 }),
        }));
        const next = reduce(changed, message(SERVER_MESSAGE.PLAYBACK_STATE, {
            playback: playback({ revision: 3, mediaRevision: 2, positionMs: 1234 }),
        }));
        expect(next.playback.positionMs).toBe(1234);
    });

    it('ignores a playback frame for a previous media revision', () => {
        const changed = reduce(joined(), message(SERVER_MESSAGE.MEDIA_CHANGED, {
            mediaRevision: 2,
            media: { videoId: 'tt1:1:2' },
            source: { fingerprint: 'torrent:def:1' },
            playback: playback({ revision: 2, mediaRevision: 2, positionMs: 0 }),
        }));
        const stale = reduce(changed, message(SERVER_MESSAGE.PLAYBACK_STATE, {
            playback: playback({ revision: 99, mediaRevision: 1, positionMs: 500_000 }),
        }));
        expect(stale.playback.positionMs).toBe(0);
        expect(stale.playback.mediaRevision).toBe(2);
    });

    it('resets everyone readiness on a media change', () => {
        const readyState = reduce(joined(), message(SERVER_MESSAGE.PARTICIPANT_UPDATED, {
            participant: participant({ ready: true, loaded: true, durationMs: 1000, sourceFingerprint: 'torrent:abc:0' }),
        }));
        expect(selectSelf(readyState).ready).toBe(true);

        const changed = reduce(readyState, message(SERVER_MESSAGE.MEDIA_CHANGED, {
            mediaRevision: 2,
            media: { videoId: 'tt1:1:2' },
            source: { fingerprint: 'torrent:def:1' },
            playback: playback({ revision: 2, mediaRevision: 2 }),
        }));
        expect(selectSelf(changed).ready).toBe(false);
        expect(selectSelf(changed).sourceFingerprint).toBeNull();
    });

    it('ignores a stale or duplicate media change', () => {
        const changed = reduce(joined(), message(SERVER_MESSAGE.MEDIA_CHANGED, {
            mediaRevision: 2,
            media: { videoId: 'tt1:1:2' },
            source: { fingerprint: 'torrent:def:1' },
            playback: playback({ revision: 2, mediaRevision: 2 }),
        }));
        const replayed = reduce(changed, message(SERVER_MESSAGE.MEDIA_CHANGED, {
            mediaRevision: 2,
            media: { videoId: 'tt1:1:2' },
            source: { fingerprint: 'torrent:def:1' },
            playback: playback({ revision: 2, mediaRevision: 2 }),
        }));
        const older = reduce(changed, message(SERVER_MESSAGE.MEDIA_CHANGED, {
            mediaRevision: 1,
            media: { videoId: 'tt1:1:1' },
            source: { fingerprint: 'torrent:abc:0' },
        }));
        expect(replayed).toBe(changed);
        expect(older).toBe(changed);
    });

    it('accepts a source refresh for the current revision and rejects an older one', () => {
        const refreshed = reduce(joined(), message(SERVER_MESSAGE.SOURCE_UPDATED, {
            mediaRevision: 1,
            source: { fingerprint: 'url:refreshed' },
        }));
        expect(refreshed.source.fingerprint).toBe('url:refreshed');

        const stale = reduce(refreshed, message(SERVER_MESSAGE.SOURCE_UPDATED, {
            mediaRevision: 0,
            source: { fingerprint: 'url:ancient' },
        }));
        expect(stale.source.fingerprint).toBe('url:refreshed');
    });

    it('passes through unknown and clock frames untouched', () => {
        const state = joined();
        expect(reduce(state, message(SERVER_MESSAGE.CLOCK_PONG, { nonce: 'n1' }))).toBe(state);
        expect(reduce(state, { type: 'something/unhandled' })).toBe(state);
    });
});
