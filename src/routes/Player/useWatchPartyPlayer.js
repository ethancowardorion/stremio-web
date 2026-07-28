// Copyright (C) 2017-2026 Smart code 203358507

const React = require('react');
const { useNavigate } = require('react-router');
// Imported from the leaf modules rather than the package barrel: the barrel
// pulls in the provider (and therefore JSX and the whole React tree), which this
// adapter does not need and which would make it untestable in isolation.
const { useWatchParty } = require('stremio/services/WatchParty/WatchPartyContext');
const { playerCapabilities } = require('stremio/services/WatchParty/protocol');
const { decideCorrection, isSynchronized } = require('stremio/services/WatchParty/drift');
const { routeTimelineIntent, computeReadiness } = require('stremio/services/WatchParty/intents');
const {
    captureSourceBundle,
    guestPlayerPath,
    mediaDescriptor,
    sourceFingerprint,
    evaluateSourceCompatibility,
    COMPATIBILITY: SOURCE_COMPATIBILITY,
} = require('stremio/services/WatchParty/mediaIdentity');

// Bridges the watch party room to the existing `stremio-video` abstraction.
//
// The two directions are deliberately separate APIs (plan section 9.4):
//
//   handleTimelineIntent -> authority check -> host publishes any command,
//                                              permitted guests publish play/pause
//   applyCanonicalState  -> direct video setters, never publishes anything
//
// Nothing here reads or writes the DOM media element; every observation and
// command goes through `useVideo`, which is what keeps the desktop shell, cast
// and TV implementations working.

// How often canonical state is re-evaluated against the local player. Fine
// enough to correct promptly, coarse enough not to chase every `timeupdate`.
const CORRECTION_INTERVAL_MS = 250;

// The host is the reference clock, so it publishes its real position regularly.
const HOST_OBSERVATION_INTERVAL_MS = 500;

// Guests report far less often: their observations only feed presence and the
// service's drift histogram.
const GUEST_OBSERVATION_INTERVAL_MS = 5000;

// If canonical state says "playing" but the local player stays paused this long
// after we asked it to play, the browser almost certainly rejected `play()`.
const ACTIVATION_TIMEOUT_MS = 1200;

const READINESS_INTERVAL_MS = 1000;

// A short rebuffer is cheaper and less disruptive than stopping the room. Only
// publish buffering after it persists long enough that somebody would otherwise
// start missing content.
const BUFFERING_GRACE_MS = 500;

// A seek is treated as landed once observed time is this close to the target.
const SEEK_SETTLE_TOLERANCE_MS = 500;

// ...or after this long, so a seek the player silently ignored cannot wedge
// correction permanently.
const SEEK_SETTLE_TIMEOUT_MS = 2000;

const useWatchPartyPlayer = ({ player, video, urlParams, casting }) => {
    const watchParty = useWatchParty();
    const navigate = useNavigate();

    const [activated, setActivated] = React.useState(false);
    const [activationRequired, setActivationRequired] = React.useState(false);
    const [driftMs, setDriftMs] = React.useState(null);
    const [sustainedBuffering, setSustainedBuffering] = React.useState(false);

    const inRoom = watchParty.inRoom;
    const isHost = watchParty.isHost;
    const isFollower = watchParty.isFollower;

    // Live view of player state for callbacks and timers, so they do not have to
    // be rebuilt on every frame of playback.
    const videoStateRef = React.useRef(video.state);
    videoStateRef.current = video.state;
    // `useVideo()` builds a new object every render, so the setters are reached
    // through a ref rather than captured in dependency arrays.
    const videoRef = React.useRef(video);
    videoRef.current = video;
    const watchPartyRef = React.useRef(watchParty);
    watchPartyRef.current = watchParty;

    const playRequestedAtRef = React.useRef(null);
    // The seek most recently handed to the player, so a correction is not
    // reissued before the element has had a chance to land on it.
    const pendingSeekRef = React.useRef(null);

    // True while a previously issued seek has neither landed nor timed out.
    const isSeekSettling = React.useCallback((forceAlign, observedPositionMs, targetMs) => {
        const pending = pendingSeekRef.current;
        if (pending === null) {
            return false;
        }
        const landed = typeof observedPositionMs === 'number' &&
            Math.abs(observedPositionMs - pending.targetMs) <= SEEK_SETTLE_TOLERANCE_MS;
        if (landed || Date.now() - pending.atMs > SEEK_SETTLE_TIMEOUT_MS) {
            pendingSeekRef.current = null;
            return false;
        }
        if (Math.abs(targetMs - pending.targetMs) <= SEEK_SETTLE_TOLERANCE_MS) {
            // The same target is already in flight; sending it again achieves
            // nothing and only restarts buffering.
            return true;
        }
        // A media change or reconnect must still be able to move the player to a
        // genuinely different position immediately; routine correction waits.
        return !forceAlign;
    }, []);
    const lastReadinessRef = React.useRef(null);
    const publishedFingerprintRef = React.useRef(null);

    React.useEffect(() => {
        // A paused element commonly reports buffering even though it is merely
        // waiting to be played, so only debounce stalls during active playback.
        if (!inRoom || video.state.buffering !== true || video.state.paused === true) {
            setSustainedBuffering(false);
            return;
        }
        const timer = setTimeout(() => {
            if (videoStateRef.current.buffering === true && videoStateRef.current.paused !== true) {
                setSustainedBuffering(true);
            }
        }, BUFFERING_GRACE_MS + 1);
        return () => clearTimeout(timer);
    }, [inRoom, video.state.buffering, video.state.paused]);

    // ---------------------------------------------------------------- identity

    const selectedStream = player.selected !== null ? player.selected.stream : null;

    const localSourceBundle = React.useMemo(() => {
        if (selectedStream === null) {
            return null;
        }
        return captureSourceBundle({ urlParams, stream: selectedStream });
    }, [selectedStream, urlParams]);

    const localMedia = React.useMemo(() => {
        return mediaDescriptor({
            type: urlParams.type,
            metaId: urlParams.id,
            videoId: urlParams.videoId,
            title: player.title,
            durationMs: video.state.duration,
            // `stremio-video` reports a null duration for live media; without a
            // finite timeline there is nothing to synchronize (plan section 12).
            live: selectedStream !== null && video.state.loaded === true && video.state.duration === null,
        });
    }, [urlParams, player.title, video.state.duration, video.state.loaded, selectedStream]);

    const localFingerprint = React.useMemo(
        () => (selectedStream === null ? null : sourceFingerprint(selectedStream)),
        [selectedStream]
    );

    const sourceCompatibility = React.useMemo(() => {
        if (!inRoom || watchParty.source === null || localFingerprint === null) {
            return { status: SOURCE_COMPATIBILITY.UNKNOWN, compatible: false };
        }
        return evaluateSourceCompatibility({
            expectedFingerprint: watchParty.source.fingerprint,
            actualFingerprint: localFingerprint,
            expectedDurationMs: watchParty.media === null ? null : watchParty.media.expectedDurationMs,
            actualDurationMs: video.state.duration,
        });
    }, [inRoom, watchParty.source, watchParty.media, localFingerprint, video.state.duration]);

    // ------------------------------------------------------------ capabilities

    React.useEffect(() => {
        if (video.state.manifest === null) {
            return;
        }
        watchParty.actions.setCapabilities(playerCapabilities(video.state.manifest));
    }, [video.state.manifest, watchParty.actions]);

    const supported = watchParty.session === null ? true : watchParty.session.supported;

    // ------------------------------------------------------- canonical -> player

    // Applies canonical room state through the direct player setters. This path
    // never publishes a command, so a correction cannot echo back as a new one.
    // Deliberately has no dependencies. `useVideo()` returns a fresh object on
    // every render, so depending on it would give this callback a new identity
    // several times a second — and any effect depending on *it* would re-run
    // just as often. Everything it needs is read through refs instead.
    const applyCanonicalState = React.useCallback((options) => {
        const current = watchPartyRef.current;
        const state = videoStateRef.current;
        const player = videoRef.current;
        if (!current.inRoom || current.playback === null || state.loaded !== true) {
            return;
        }
        const serverNowMs = current.serverNow();
        if (serverNowMs === null) {
            return;
        }
        const forceAlign = options !== undefined && options.forceAlign === true;

        const decision = decideCorrection({
            playback: current.playback,
            serverNowMs,
            localPositionMs: state.time,
            localPaused: state.paused,
            localRate: state.playbackSpeed,
            durationMs: state.duration,
            buffering: state.buffering === true,
            forceAlign,
            canSetRate: state.playbackSpeed !== null,
        });

        setDriftMs(decision.driftMs);

        if (decision.seekToMs !== null && !isSeekSettling(forceAlign, state.time, decision.seekToMs)) {
            // Observed time lags the element by up to a `timeupdate` interval, so
            // a fresh correction computed immediately after a seek would still see
            // the old position and seek again. Left unchecked that becomes a seek
            // storm: the element restarts buffering each time and never plays a
            // run of frames.
            pendingSeekRef.current = { targetMs: decision.seekToMs, atMs: Date.now() };
            player.setTime(decision.seekToMs);
        }
        if (decision.rate !== null && state.playbackSpeed !== null) {
            player.setPlaybackSpeed(decision.rate);
        }
        if (decision.paused !== null) {
            if (decision.paused === false) {
                // Track when playback was asked for so a silent rejection can be
                // detected and surfaced instead of looking like drift.
                if (playRequestedAtRef.current === null) {
                    playRequestedAtRef.current = Date.now();
                }
            } else {
                playRequestedAtRef.current = null;
            }
            player.setPaused(decision.paused);
        }
    }, []);

    // Re-evaluate on a fixed tick as well as whenever canonical state changes: the
    // tick catches natural drift, the state change catches commands.
    React.useEffect(() => {
        if (!inRoom) {
            return;
        }
        applyCanonicalState();
        const interval = setInterval(applyCanonicalState, CORRECTION_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [inRoom, applyCanonicalState, watchParty.playback]);

    // A scheduled transition is applied exactly at its effective instant rather
    // than on the next tick, which would add up to one tick of avoidable error.
    React.useEffect(() => {
        if (!inRoom || watchParty.playback === null) {
            return;
        }
        const serverNowMs = watchParty.serverNow();
        if (serverNowMs === null) {
            return;
        }
        const delayMs = watchParty.playback.effectiveAtServerMs - serverNowMs;
        if (delayMs <= 0) {
            return;
        }
        const timer = setTimeout(applyCanonicalState, delayMs);
        return () => clearTimeout(timer);
    }, [inRoom, watchParty.playback, watchParty.serverNow, applyCanonicalState]);

    // Hard align after a (re)connection or a media load, before this client is
    // allowed to report itself as synchronized.
    //
    // The dependencies here are exactly the transitions that justify a forced
    // seek. `applyCanonicalState` is deliberately absent: it is stable now, and
    // listing an unstable callback here is what previously turned this into a
    // seek on every render.
    React.useEffect(() => {
        if (!inRoom || video.state.loaded !== true) {
            return;
        }
        pendingSeekRef.current = null;
        playRequestedAtRef.current = null;
        setActivationRequired(false);
        applyCanonicalState({ forceAlign: true });
    }, [inRoom, video.state.loaded, video.state.stream, watchParty.mediaRevision, watchParty.resetRevision]);

    // ------------------------------------------------------------- activation

    React.useEffect(() => {
        // Having played locally at any point proves the browser will let this
        // page produce sound, so no further gesture is needed.
        if (video.state.paused === false) {
            setActivated(true);
            setActivationRequired(false);
            playRequestedAtRef.current = null;
        }
    }, [video.state.paused]);

    React.useEffect(() => {
        if (!inRoom || watchParty.playback === null || watchParty.playback.paused) {
            return;
        }
        const timer = setInterval(() => {
            const requestedAt = playRequestedAtRef.current;
            if (requestedAt === null) {
                return;
            }
            if (videoStateRef.current.paused === true && Date.now() - requestedAt > ACTIVATION_TIMEOUT_MS) {
                setActivationRequired(true);
            }
        }, CORRECTION_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [inRoom, watchParty.playback]);

    // Fallback for browsers that reject the first synchronized play attempt.
    const markReady = React.useCallback(() => {
        setActivated(true);
        setActivationRequired(false);
        applyCanonicalState({ forceAlign: true });
    }, [applyCanonicalState]);

    // -------------------------------------------------------------- readiness

    const aligned = React.useMemo(() => {
        if (!inRoom || watchParty.playback === null || video.state.loaded !== true) {
            return false;
        }
        const serverNowMs = watchParty.serverNow();
        if (serverNowMs === null) {
            return false;
        }
        return isSynchronized(
            decideCorrection({
                playback: watchParty.playback,
                serverNowMs,
                localPositionMs: video.state.time,
                localPaused: video.state.paused,
                localRate: video.state.playbackSpeed,
                durationMs: video.state.duration,
                buffering: video.state.buffering === true,
                canSetRate: video.state.playbackSpeed !== null,
            })
        );
    }, [inRoom, watchParty.playback, watchParty.serverNow, video.state]);

    const readiness = React.useMemo(() => computeReadiness({
        inRoom,
        supported,
        activated,
        activationRequired,
        loaded: video.state.loaded === true,
        sourceCompatible: sourceCompatibility.compatible,
        aligned,
    }), [inRoom, supported, activated, activationRequired, video.state.loaded, sourceCompatibility.compatible, aligned]);
    const ready = readiness.ready;

    // Dropping a connection resets this participant's readiness on the service,
    // and a publish that never reached the socket must not be remembered as
    // sent. Forgetting the last published value makes the heartbeat below
    // re-announce readiness after a reconnect even when nothing changed locally.
    React.useEffect(() => {
        lastReadinessRef.current = null;
    }, [watchParty.status, watchParty.mediaRevision, watchParty.resetRevision]);

    React.useEffect(() => {
        if (!inRoom) {
            return;
        }
        const publish = () => {
            const state = videoStateRef.current;
            const next = {
                ready,
                loaded: state.loaded === true,
                buffering: sustainedBuffering,
                durationMs: typeof state.duration === 'number' ? state.duration : null,
                mediaRevision: watchPartyRef.current.mediaRevision,
                sourceFingerprint: localFingerprint,
            };
            const previous = lastReadinessRef.current;
            const changed =
                previous === null ||
                Object.keys(next).some((key) => next[key] !== previous[key]);
            if (!changed) {
                return;
            }
            // Only remember it as published once it actually reached the socket.
            if (watchPartyRef.current.actions.setReady(next) !== null) {
                lastReadinessRef.current = next;
            }
        };

        publish();
        const interval = setInterval(publish, READINESS_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [inRoom, ready, sustainedBuffering, localFingerprint, watchParty.mediaRevision, watchParty.resetRevision]);

    // --------------------------------------------------------- observations

    React.useEffect(() => {
        if (!inRoom) {
            return;
        }
        const intervalMs = isHost ? HOST_OBSERVATION_INTERVAL_MS : GUEST_OBSERVATION_INTERVAL_MS;
        const publish = () => {
            const state = videoStateRef.current;
            if (state.loaded !== true || typeof state.time !== 'number') {
                return;
            }
            watchPartyRef.current.actions.observe({
                positionMs: state.time,
                paused: state.paused === true,
                rate: typeof state.playbackSpeed === 'number' ? state.playbackSpeed : 1,
                buffering: sustainedBuffering,
                durationMs: typeof state.duration === 'number' ? state.duration : null,
                mediaRevision: watchPartyRef.current.mediaRevision,
            });
        };
        const interval = setInterval(publish, intervalMs);
        return () => clearInterval(interval);
    }, [inRoom, isHost, sustainedBuffering]);

    // ------------------------------------------------------ player -> canonical

    // Single interception point for every local timeline intent. Returns true
    // when the caller must not apply the change itself.
    //
    // The host is intercepted too, not only the guest: it publishes a command and
    // then follows the canonical state like everyone else, so it starts at the
    // same scheduled instant rather than a lead time early.
    const handleTimelineIntent = React.useCallback((action, options) => {
        const current = watchPartyRef.current;
        const decision = routeTimelineIntent({
            inRoom: current.inRoom,
            isHost: current.isHost,
            allowGuestPlayPause: current.room !== null &&
                current.room.policy.allowGuestPlayPause === true,
            action,
            options,
            videoState: videoStateRef.current,
        });
        if (decision.command !== null) {
            current.actions.sendCommand(decision.command.action, decision.command.options);
        }
        return decision.handled;
    }, []);

    // ------------------------------------------------------- media transitions

    // The host republishes whenever its own source changes — next episode, a
    // different stream, a refreshed link. Comparing fingerprints makes this
    // idempotent, so a re-render or a duplicate navigation cannot double-publish.
    React.useEffect(() => {
        if (!inRoom || !isHost || localSourceBundle === null || watchParty.source === null) {
            return;
        }
        if (localSourceBundle.streamParam === watchParty.source.streamParam) {
            publishedFingerprintRef.current = localSourceBundle.streamParam;
            return;
        }
        if (publishedFingerprintRef.current === localSourceBundle.streamParam) {
            return;
        }
        publishedFingerprintRef.current = localSourceBundle.streamParam;
        watchParty.actions.changeMedia({ media: localMedia, source: localSourceBundle });
    }, [inRoom, isHost, localSourceBundle, localMedia, watchParty.source, watchParty.actions]);

    // Guests follow the room's source by navigating; the route they build is
    // their own, so their local streaming server resolves the stream.
    React.useEffect(() => {
        if (!inRoom || isHost || watchParty.source === null) {
            return;
        }
        if (localSourceBundle !== null && localSourceBundle.streamParam === watchParty.source.streamParam) {
            return;
        }
        const path = guestPlayerPath(watchParty.source, watchParty.media);
        if (path !== null) {
            navigate(path, { replace: true });
        }
    }, [inRoom, isHost, watchParty.source, watchParty.media, localSourceBundle, navigate]);

    // -------------------------------------------------------------- host tools

    const startParty = React.useCallback((options) => {
        if (localSourceBundle === null) {
            return Promise.reject({ code: 'NO_SOURCE', message: 'no stream is loaded' });
        }
        if (casting === true) {
            // Cast timing and command latency differ enough that MVP refuses to
            // claim synchronization while casting (plan section 12).
            return Promise.reject({ code: 'CASTING_BLOCKED', message: 'stop casting first' });
        }
        if (localMedia.live) {
            return Promise.reject({ code: 'UNSUPPORTED_MEDIA', message: 'live media cannot be synchronized' });
        }
        // The room starts paused; capture where the host actually is so nobody
        // has to seek back to it.
        return watchParty.actions
            .createRoom({
                displayName: options !== undefined ? options.displayName : undefined,
                deviceLabel: options !== undefined ? options.deviceLabel : undefined,
                media: localMedia,
                source: localSourceBundle,
                observation: {
                    positionMs: typeof video.state.time === 'number' ? Math.max(0, Math.round(video.state.time)) : 0,
                    paused: true,
                    rate: typeof video.state.playbackSpeed === 'number' ? video.state.playbackSpeed : 1,
                    buffering: video.state.buffering === true,
                    durationMs: typeof video.state.duration === 'number' ? Math.round(video.state.duration) : null,
                    mediaRevision: 1,
                },
                policy: options !== undefined && options.policy !== undefined ? options.policy : undefined,
            })
            .then((payload) => {
                // Creating a party pauses playback so guests can catch up before
                // anything continues (plan section 6.1).
                video.setPaused(true);
                return payload;
            });
    }, [localSourceBundle, localMedia, casting, watchParty.actions, video]);

    const refreshSource = React.useCallback(() => {
        if (localSourceBundle === null) {
            return;
        }
        watchParty.actions.refreshSource(localSourceBundle);
    }, [localSourceBundle, watchParty.actions]);

    const resetRoom = React.useCallback(() => {
        const state = videoStateRef.current;
        return watchPartyRef.current.actions.resetRoom({
            positionMs: typeof state.time === 'number' ? state.time : 0,
            rate: typeof state.playbackSpeed === 'number' ? state.playbackSpeed : 1,
            buffering: state.buffering === true,
            durationMs: typeof state.duration === 'number' ? state.duration : null,
            mediaRevision: watchPartyRef.current.mediaRevision,
        });
    }, []);

    return {
        available: watchParty.available,
        inRoom,
        isHost,
        isFollower,
        supported,
        // Party participants must never autoplay: everyone loads paused and
        // starts together once the ready barrier is satisfied.
        autoplay: !inRoom,
        // Guest seek/rate/next controls stay locked. Play/pause has a separate
        // lock because the host can grant that narrower permission.
        controlsLocked: isFollower,
        playPauseControlsLocked: isFollower &&
            !(watchParty.room !== null && watchParty.room.policy.allowGuestPlayPause === true),
        ready,
        // Why this client is not ready, for diagnostics and interface copy.
        readinessReasons: readiness.reasons,
        activated,
        activationRequired,
        driftMs,
        sourceCompatibility,
        participants: watchParty.participants,
        self: watchParty.self,
        host: watchParty.host,
        room: watchParty.room,
        media: watchParty.media,
        playback: watchParty.playback,
        status: watchParty.status,
        invitationUrl: watchParty.invitationUrl,
        lastError: watchParty.lastError,
        closeReason: watchParty.closeReason,
        pauseReason: watchParty.pauseReason,
        clock: watchParty.clock,
        handleTimelineIntent,
        markReady,
        startParty,
        refreshSource,
        leave: watchParty.actions.leave,
        closeRoom: watchParty.actions.closeRoom,
        resetRoom,
        updatePolicy: watchParty.actions.updatePolicy,
        retryConnection: watchParty.actions.retryConnection,
    };
};

module.exports = useWatchPartyPlayer;
module.exports.CORRECTION_INTERVAL_MS = CORRECTION_INTERVAL_MS;
module.exports.HOST_OBSERVATION_INTERVAL_MS = HOST_OBSERVATION_INTERVAL_MS;
module.exports.GUEST_OBSERVATION_INTERVAL_MS = GUEST_OBSERVATION_INTERVAL_MS;
module.exports.ACTIVATION_TIMEOUT_MS = ACTIVATION_TIMEOUT_MS;
