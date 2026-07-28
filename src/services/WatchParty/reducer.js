// Copyright (C) 2017-2026 Smart code 203358507

// Authoritative room state, maintained independently of React so it can be tested
// as a pure function. Ordering is decided by revisions rather than by arrival time:
// an out-of-order or replayed frame must never be able to rewind playback.

const { SERVER_MESSAGE } = require('./protocol');

const CONNECTION_STATUS = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    CLOSED: 'closed',
};

const initialState = {
    status: CONNECTION_STATUS.IDLE,
    lastError: null,
    session: null,
    room: null,
    media: null,
    source: null,
    mediaRevision: 0,
    playback: null,
    participants: [],
    selfParticipantId: null,
    // Only ever populated on the host, and only from `room.created`.
    inviteSecret: null,
    closeReason: null,
    serverTimeMs: null,
};

const ACTION = {
    CONNECTING: 'connection/connecting',
    OPEN: 'connection/open',
    CLOSED: 'connection/closed',
    ERROR: 'connection/error',
    MESSAGE: 'server/message',
    LEAVE: 'room/leave',
};

const upsertParticipant = (participants, participant) => {
    const index = participants.findIndex((entry) => entry.participantId === participant.participantId);
    if (index === -1) {
        return participants.concat([participant]);
    }
    const next = participants.slice();
    next[index] = participant;
    return next;
};

// A room snapshot is the complete truth, so it replaces every derived field at once.
const applySnapshot = (state, payload) => {
    const room = payload.room;
    if (!room || typeof room !== 'object') {
        return state;
    }
    return {
        ...state,
        room: {
            roomId: room.roomId,
            hostParticipantId: room.hostParticipantId,
            createdAtServerMs: room.createdAtServerMs,
            expiresAtServerMs: room.expiresAtServerMs,
            policy: room.policy,
        },
        media: room.media,
        source: room.source,
        mediaRevision: room.mediaRevision,
        playback: room.playback,
        participants: Array.isArray(room.participants) ? room.participants : [],
        selfParticipantId: typeof payload.selfParticipantId === 'string' ? payload.selfParticipantId : state.selfParticipantId,
        serverTimeMs: room.serverTimeMs,
        closeReason: null,
    };
};

// Accepts a playback frame only when it is strictly newer for the media the client
// currently believes it is watching.
const isNewerPlayback = (state, playback) => {
    if (!playback || typeof playback !== 'object') {
        return false;
    }
    if (state.playback === null) {
        return true;
    }
    if (playback.mediaRevision !== state.mediaRevision) {
        return playback.mediaRevision > state.mediaRevision;
    }
    return playback.revision > state.playback.revision;
};

const reduceServerMessage = (state, envelope) => {
    const payload = envelope.payload;
    switch (envelope.type) {
        case SERVER_MESSAGE.SESSION_WELCOME:
            return {
                ...state,
                status: CONNECTION_STATUS.CONNECTED,
                lastError: null,
                session: {
                    sessionId: payload.sessionId,
                    resumed: payload.resumed === true,
                    supported: payload.supported === true,
                    missingCapabilities: Array.isArray(payload.missingCapabilities) ? payload.missingCapabilities : [],
                    requiredCapabilities: Array.isArray(payload.requiredCapabilities) ? payload.requiredCapabilities : [],
                    limits: payload.limits || null,
                },
                serverTimeMs: typeof payload.serverTimeMs === 'number' ? payload.serverTimeMs : state.serverTimeMs,
            };

        case SERVER_MESSAGE.ROOM_CREATED:
            return {
                ...applySnapshot(state, payload),
                inviteSecret: typeof payload.inviteSecret === 'string' ? payload.inviteSecret : null,
            };

        case SERVER_MESSAGE.ROOM_SNAPSHOT:
            return applySnapshot(state, payload);

        case SERVER_MESSAGE.ROOM_UPDATED:
            if (state.room === null || !payload.policy) {
                return state;
            }
            return { ...state, room: { ...state.room, policy: payload.policy } };

        case SERVER_MESSAGE.PARTICIPANT_UPDATED:
            if (!payload.participant || typeof payload.participant.participantId !== 'string') {
                return state;
            }
            return { ...state, participants: upsertParticipant(state.participants, payload.participant) };

        case SERVER_MESSAGE.PARTICIPANT_LEFT:
            if (typeof payload.participantId !== 'string') {
                return state;
            }
            return {
                ...state,
                participants: state.participants.filter((entry) => entry.participantId !== payload.participantId),
            };

        case SERVER_MESSAGE.PLAYBACK_STATE:
            if (!isNewerPlayback(state, payload.playback)) {
                return state;
            }
            return {
                ...state,
                playback: payload.playback,
                serverTimeMs: typeof payload.serverTimeMs === 'number' ? payload.serverTimeMs : state.serverTimeMs,
            };

        case SERVER_MESSAGE.MEDIA_CHANGED: {
            if (typeof payload.mediaRevision !== 'number' || payload.mediaRevision <= state.mediaRevision) {
                return state;
            }
            // Readiness is reset by the service; the client mirrors that so no stale
            // "ready" badge survives an episode change.
            const participants = state.participants.map((participant) => ({
                ...participant,
                ready: false,
                loaded: false,
                buffering: false,
                durationMs: null,
                sourceFingerprint: null,
            }));
            return {
                ...state,
                mediaRevision: payload.mediaRevision,
                media: payload.media,
                source: payload.source,
                playback: payload.playback || state.playback,
                participants,
                serverTimeMs: typeof payload.serverTimeMs === 'number' ? payload.serverTimeMs : state.serverTimeMs,
            };
        }

        case SERVER_MESSAGE.SOURCE_UPDATED:
            if (typeof payload.mediaRevision !== 'number' || payload.mediaRevision < state.mediaRevision) {
                return state;
            }
            return { ...state, source: payload.source };

        case SERVER_MESSAGE.ROOM_CLOSED:
            return {
                ...state,
                room: null,
                media: null,
                source: null,
                mediaRevision: 0,
                playback: null,
                participants: [],
                selfParticipantId: null,
                inviteSecret: null,
                closeReason: typeof payload.reason === 'string' ? payload.reason : 'expired',
            };

        case SERVER_MESSAGE.ERROR:
            return {
                ...state,
                lastError: {
                    code: typeof payload.code === 'string' ? payload.code : 'INTERNAL_ERROR',
                    message: typeof payload.message === 'string' ? payload.message : '',
                    requestId: envelope.requestId || null,
                },
            };

        // `clock.pong` is consumed by the clock estimator, not by room state.
        default:
            return state;
    }
};

const reduce = (state, action) => {
    switch (action.type) {
        case ACTION.CONNECTING:
            return {
                ...state,
                status: state.session === null ? CONNECTION_STATUS.CONNECTING : CONNECTION_STATUS.RECONNECTING,
            };

        case ACTION.OPEN:
            // The handshake, not the socket, marks the connection usable.
            return { ...state, lastError: null };

        case ACTION.CLOSED:
            return {
                ...state,
                // A socket that never completed a handshake has nothing to
                // reconnect to; saying "reconnecting" there would imply the
                // service was reachable and then lost, which it never was.
                status: action.permanent === true || state.session === null
                    ? CONNECTION_STATUS.CLOSED
                    : CONNECTION_STATUS.RECONNECTING,
                // Participants are stale the moment the socket drops; the next
                // snapshot restores them.
                participants: state.participants.map((participant) =>
                    participant.participantId === state.selfParticipantId
                        ? { ...participant, connected: false, ready: false }
                        : participant
                ),
            };

        case ACTION.ERROR:
            return { ...state, lastError: action.error || null };

        case ACTION.MESSAGE:
            return reduceServerMessage(state, action.envelope);

        case ACTION.LEAVE:
            return {
                ...initialState,
                status: state.status,
                session: state.session,
            };

        default:
            return state;
    }
};

const selectSelf = (state) =>
    state.participants.find((participant) => participant.participantId === state.selfParticipantId) || null;

const selectHost = (state) =>
    state.room === null
        ? null
        : state.participants.find((participant) => participant.participantId === state.room.hostParticipantId) || null;

const selectIsHost = (state) =>
    state.room !== null && state.selfParticipantId !== null && state.room.hostParticipantId === state.selfParticipantId;

// True when this client should follow rather than drive the timeline.
const selectIsFollower = (state) => state.room !== null && !selectIsHost(state);

module.exports = {
    ACTION,
    CONNECTION_STATUS,
    initialState,
    reduce,
    selectSelf,
    selectHost,
    selectIsHost,
    selectIsFollower,
};
