// Copyright (C) 2017-2026 Smart code 203358507

const React = require('react');
const PropTypes = require('prop-types');
const { WatchPartyContext } = require('./WatchPartyContext');
const { CLIENT_MESSAGE, SERVER_MESSAGE, PLAYBACK_ACTION } = require('./protocol');
const { CLIENT_EVENT, createWatchPartyClient } = require('./WatchPartyClient');
const { ACTION, CONNECTION_STATUS, initialState, reduce, selectSelf, selectHost, selectIsHost, selectIsFollower } = require('./reducer');
const { resolveWatchPartyUrl, buildInvitationUrl } = require('./endpoint');
const { expectedPositionMs } = require('./drift');

// Long-lived watch party state.
//
// Mounted above the routes so the socket, the room and the clock estimate all
// survive navigation between the join screen, meta details and the player
// (plan section 2.3). The connection is opened lazily: a user who never starts
// a party never opens a socket.

// Neutral on purpose: the same default is used whether this client creates the
// room or joins one, and the host/you badges already say which is which.
const DEFAULT_DISPLAY_NAME = 'Viewer';

// Capabilities are only known once a player implementation has loaded, but the
// handshake happens earlier than that — a guest joins from the invitation route,
// where no player is mounted at all. Connecting with no manifest would be
// rejected outright, so this describes the ordinary browser player and the
// adapter corrects it (reconnecting to re-announce) the moment it knows better.
const DEFAULT_CAPABILITIES = {
    scheduledActions: true,
    observeBuffering: true,
    setPlaybackRate: true,
    navigateNext: true,
    playerImplementation: 'pending',
};

const randomId = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;

const monotonicNow = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

const WatchPartyProvider = ({ children, clientFactory, endpointUrl, clientVersion }) => {
    const [state, dispatch] = React.useReducer(reduce, initialState);
    const [clockState, setClockState] = React.useState({
        offsetMs: null,
        uncertaintyMs: null,
        roundTripMs: null,
        isConfident: false,
    });

    const clientRef = React.useRef(null);
    const capabilitiesRef = React.useRef(DEFAULT_CAPABILITIES);
    // Command builders need the freshest revision without being rebuilt on every
    // playback frame, which would re-register handlers throughout the player.
    const stateRef = React.useRef(state);
    stateRef.current = state;
    // Kept in a ref as well as in state so callbacks do not need to be rebuilt
    // (and re-registered) every time the room changes.
    const roomIdRef = React.useRef(null);
    roomIdRef.current = state.room === null ? null : state.room.roomId;

    const resolvedUrl = React.useMemo(() => {
        return resolveWatchPartyUrl({
            configuredUrl: endpointUrl,
            location: typeof window === 'undefined' ? null : window.location,
        });
    }, [endpointUrl]);

    const [displayName, setDisplayNameState] = React.useState(DEFAULT_DISPLAY_NAME);

    const getClient = React.useCallback(() => {
        if (clientRef.current !== null) {
            return clientRef.current;
        }
        if (resolvedUrl === null) {
            return null;
        }
        const factory = clientFactory || createWatchPartyClient;
        const client = factory({
            url: resolvedUrl,
            clientVersion,
            monotonicNow,
        });

        client.events.on(CLIENT_EVENT.MESSAGE, (envelope) => {
            if (envelope.type === SERVER_MESSAGE.ROOM_SNAPSHOT && envelope.payload.room) {
                const roomId = envelope.payload.room.roomId;
                const isHost = envelope.payload.selfParticipantId === envelope.payload.room.hostParticipantId;
                const inviteSecret = isHost ? client.storage.readInvite(roomId) : null;
                dispatch({ type: ACTION.MESSAGE, envelope });
                if (inviteSecret !== null) {
                    dispatch({ type: ACTION.RESTORE_INVITE, roomId, inviteSecret });
                }
                return;
            }
            if (envelope.type === SERVER_MESSAGE.ROOM_CLOSED) {
                const stored = client.storage.readSession();
                const roomId = roomIdRef.current || (stored && stored.roomId);
                if (roomId !== null) {
                    client.storage.clearInvite(roomId);
                }
                client.disconnect({ forget: true });
            }
            dispatch({ type: ACTION.MESSAGE, envelope });
        });
        client.events.on(CLIENT_EVENT.STATUS, (status) => {
            if (status === 'connecting') {
                dispatch({ type: ACTION.CONNECTING });
            } else if (status === 'closed') {
                dispatch({ type: ACTION.CLOSED });
            } else if (status === 'open') {
                dispatch({ type: ACTION.OPEN });
            }
        });
        client.events.on(CLIENT_EVENT.CLOCK, (sample) => setClockState(sample));
        client.events.on(CLIENT_EVENT.ERROR, (error) => dispatch({ type: ACTION.ERROR, error }));

        clientRef.current = client;
        const storedName = client.storage.readDisplayName();
        if (storedName !== null) {
            setDisplayNameState(storedName);
        }
        return client;
    }, [resolvedUrl, clientFactory, clientVersion]);

    React.useEffect(() => {
        return () => {
            if (clientRef.current !== null) {
                clientRef.current.disconnect();
                clientRef.current.events.removeAllListeners();
                clientRef.current = null;
            }
        };
    }, []);

    // A reload is a disconnect like any other, and the service holds the
    // participant open for the resume grace period. Without this, refreshing the
    // page would silently drop the user out of a room they are still watching in.
    // Nothing connects unless a room was actually joined, so a user who never
    // starts a party still never opens a socket.
    const resumeAttempted = React.useRef(false);
    React.useEffect(() => {
        if (resumeAttempted.current || resolvedUrl === null) {
            return;
        }
        resumeAttempted.current = true;
        const client = getClient();
        if (client === null) {
            return;
        }
        const stored = client.storage.readSession();
        if (stored !== null && stored.roomId !== null) {
            client.connect(capabilitiesRef.current);
        }
    }, [resolvedUrl, getClient]);

    // The service learns a client's player capabilities during the handshake, so a
    // change (switching to a cast device, loading a different implementation) has
    // to be re-announced on a fresh connection rather than patched in place.
    const setCapabilities = React.useCallback((capabilities) => {
        const previous = capabilitiesRef.current;
        capabilitiesRef.current = capabilities;
        const client = clientRef.current;
        if (client === null || !client.isConnected) {
            return;
        }
        const changed = Object.keys(capabilities).some((key) => capabilities[key] !== previous[key]);
        if (changed) {
            client.reconnect(capabilities);
        }
    }, []);

    const ensureConnected = React.useCallback(() => {
        const client = getClient();
        if (client === null) {
            return null;
        }
        if (client.status === 'idle' || client.status === 'closed') {
            client.connect(capabilitiesRef.current);
        }
        return client;
    }, [getClient]);

    // Resolves once the handshake completes, so callers can act on a connection
    // rather than racing it.
    const waitForConnection = React.useCallback(() => {
        const client = ensureConnected();
        if (client === null) {
            return Promise.reject({ code: 'NO_ENDPOINT', message: 'watch party endpoint is not configured' });
        }
        if (client.isConnected) {
            return Promise.resolve(client);
        }
        return new Promise((resolve, reject) => {
            const onReady = () => {
                cleanUp();
                resolve(client);
            };
            const onStatus = (status) => {
                if (status === 'closed') {
                    cleanUp();
                    reject({ code: 'CONNECTION_FAILED', message: 'could not reach the watch party service' });
                }
            };
            const cleanUp = () => {
                client.events.off(CLIENT_EVENT.READY, onReady);
                client.events.off(CLIENT_EVENT.STATUS, onStatus);
            };
            client.events.on(CLIENT_EVENT.READY, onReady);
            client.events.on(CLIENT_EVENT.STATUS, onStatus);
        });
    }, [ensureConnected]);

    const setDisplayName = React.useCallback((name) => {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        const next = trimmed.length > 0 ? trimmed : DEFAULT_DISPLAY_NAME;
        setDisplayNameState(next);
        const client = clientRef.current;
        if (client !== null) {
            client.storage.writeDisplayName(next);
        }
    }, []);

    const createRoom = React.useCallback(async (input) => {
        const client = await waitForConnection();
        const envelope = await client.request(CLIENT_MESSAGE.ROOM_CREATE, {
            displayName: input.displayName || displayName,
            deviceLabel: input.deviceLabel || null,
            media: input.media,
            source: input.source,
            observation: input.observation,
            ...(input.policy ? { policy: input.policy } : {}),
        });
        const roomId = envelope.payload.roomId;
        client.rememberRoom(roomId);
        client.storage.writeInvite(roomId, envelope.payload.inviteSecret);
        return envelope.payload;
    }, [waitForConnection, displayName]);

    const joinRoom = React.useCallback(async (input) => {
        const client = await waitForConnection();
        const envelope = await client.request(CLIENT_MESSAGE.ROOM_JOIN, {
            roomId: input.roomId,
            inviteSecret: input.inviteSecret,
            displayName: input.displayName || displayName,
            deviceLabel: input.deviceLabel || null,
        });
        client.rememberRoom(input.roomId);
        client.storage.writeInvite(input.roomId, input.inviteSecret);
        return envelope.payload;
    }, [waitForConnection, displayName]);

    const leave = React.useCallback(() => {
        const client = clientRef.current;
        const roomId = roomIdRef.current;
        if (client !== null) {
            client.send(CLIENT_MESSAGE.ROOM_LEAVE, {});
            if (roomId !== null) {
                client.storage.clearInvite(roomId);
            }
            // The socket is dropped rather than kept idle: a user who left a
            // party should not be holding a connection to the service.
            client.disconnect({ forget: true });
        }
        dispatch({ type: ACTION.LEAVE });
    }, []);

    const closeRoom = React.useCallback(() => {
        const client = clientRef.current;
        if (client !== null) {
            client.send(CLIENT_MESSAGE.ROOM_CLOSE, {});
        }
    }, []);

    const setReady = React.useCallback((input) => {
        const client = clientRef.current;
        if (client === null || !client.isConnected) {
            return null;
        }
        return client.send(CLIENT_MESSAGE.PARTICIPANT_READY, {
            ready: input.ready === true,
            loaded: input.loaded === true,
            buffering: input.buffering === true,
            durationMs: typeof input.durationMs === 'number' ? Math.round(input.durationMs) : null,
            mediaRevision: input.mediaRevision,
            sourceFingerprint: typeof input.sourceFingerprint === 'string' ? input.sourceFingerprint : null,
        });
    }, []);

    const observe = React.useCallback((input) => {
        const client = clientRef.current;
        if (client === null || !client.isConnected) {
            return null;
        }
        return client.send(CLIENT_MESSAGE.PLAYBACK_OBSERVATION, {
            positionMs: Math.max(0, Math.round(input.positionMs)),
            paused: input.paused === true,
            rate: typeof input.rate === 'number' && input.rate > 0 ? input.rate : 1,
            buffering: input.buffering === true,
            durationMs: typeof input.durationMs === 'number' ? Math.round(input.durationMs) : null,
            mediaRevision: input.mediaRevision,
        });
    }, []);

    // Host-only. Guests never reach this path: the player adapter blocks their
    // intents before they become commands, and the service rejects them anyway.
    const sendCommand = React.useCallback((action, options) => {
        const client = clientRef.current;
        if (client === null || !client.isConnected) {
            return null;
        }
        const playback = stateRef.current.playback;
        if (playback === null) {
            return null;
        }
        const payload = {
            commandId: randomId(),
            action,
            expectedRevision: playback.revision,
            mediaRevision: playback.mediaRevision,
        };
        if (options && typeof options.positionMs === 'number') {
            payload.positionMs = Math.max(0, Math.round(options.positionMs));
        }
        if (options && typeof options.rate === 'number') {
            payload.rate = options.rate;
        }
        if (options && typeof options.leadMs === 'number') {
            payload.leadMs = Math.max(0, Math.round(options.leadMs));
        }
        return client.send(CLIENT_MESSAGE.PLAYBACK_COMMAND, payload);
    }, []);

    const changeMedia = React.useCallback((input) => {
        const client = clientRef.current;
        if (client === null || !client.isConnected) {
            return null;
        }
        return client.send(CLIENT_MESSAGE.MEDIA_CHANGE, {
            mediaChangeId: input.mediaChangeId || randomId(),
            media: input.media,
            source: input.source,
        });
    }, []);

    const refreshSource = React.useCallback((source) => {
        const client = clientRef.current;
        if (client === null || !client.isConnected) {
            return null;
        }
        return client.send(CLIENT_MESSAGE.SOURCE_REFRESH, { source });
    }, []);

    const retryConnection = React.useCallback(() => {
        const client = clientRef.current;
        if (client !== null) {
            client.reconnectNow();
        } else {
            ensureConnected();
        }
    }, [ensureConnected]);

    const serverNow = React.useCallback(() => {
        const client = clientRef.current;
        if (client === null || !client.clock.hasEstimate) {
            return null;
        }
        return client.clock.serverNow();
    }, []);

    const expectedPosition = React.useCallback((durationMs) => {
        const now = serverNow();
        if (now === null) {
            return null;
        }
        return expectedPositionMs(stateRef.current.playback, now, typeof durationMs === 'number' ? durationMs : null);
    }, [serverNow]);

    const self = React.useMemo(() => selectSelf(state), [state]);
    const host = React.useMemo(() => selectHost(state), [state]);
    const isHost = React.useMemo(() => selectIsHost(state), [state]);
    const isFollower = React.useMemo(() => selectIsFollower(state), [state]);

    const invitationUrl = React.useMemo(() => {
        if (state.room === null || state.inviteSecret === null || typeof window === 'undefined') {
            return null;
        }
        return buildInvitationUrl({
            origin: `${window.location.origin}${window.location.pathname}`.replace(/\/$/, ''),
            roomId: state.room.roomId,
            inviteSecret: state.inviteSecret,
        });
    }, [state.room, state.inviteSecret]);

    const value = React.useMemo(() => ({
        // False when no endpoint could be resolved, e.g. a build served from
        // `file://`. Consumers hide the feature rather than showing a broken one.
        available: resolvedUrl !== null,
        endpointUrl: resolvedUrl,
        status: state.status,
        connected: state.status === CONNECTION_STATUS.CONNECTED,
        session: state.session,
        room: state.room,
        media: state.media,
        source: state.source,
        mediaRevision: state.mediaRevision,
        playback: state.playback,
        participants: state.participants,
        selfParticipantId: state.selfParticipantId,
        self,
        host,
        isHost,
        isFollower,
        inRoom: state.room !== null,
        inviteSecret: state.inviteSecret,
        invitationUrl,
        closeReason: state.closeReason,
        pauseReason: state.pauseReason,
        lastError: state.lastError,
        clock: clockState,
        displayName,
        serverNow,
        expectedPosition,
        actions: {
            setCapabilities,
            setDisplayName,
            createRoom,
            joinRoom,
            leave,
            closeRoom,
            setReady,
            observe,
            sendCommand,
            changeMedia,
            refreshSource,
            retryConnection,
        },
        PLAYBACK_ACTION,
    }), [
        resolvedUrl,
        state,
        self,
        host,
        isHost,
        isFollower,
        invitationUrl,
        clockState,
        displayName,
        serverNow,
        expectedPosition,
        setCapabilities,
        setDisplayName,
        createRoom,
        joinRoom,
        leave,
        closeRoom,
        setReady,
        observe,
        sendCommand,
        changeMedia,
        refreshSource,
        retryConnection,
    ]);

    return (
        <WatchPartyContext.Provider value={value}>
            {children}
        </WatchPartyContext.Provider>
    );
};

WatchPartyProvider.propTypes = {
    children: PropTypes.node,
    // Injected by tests; production uses the real reconnecting client.
    clientFactory: PropTypes.func,
    endpointUrl: PropTypes.string,
    clientVersion: PropTypes.string,
};

module.exports = WatchPartyProvider;
