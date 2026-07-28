/**
 * @jest-environment jsdom
 */
// Copyright (C) 2017-2023 Smart code 203358507

const React = require('react');
const { createRoot } = require('react-dom/client');
const { MemoryRouter } = require('react-router-dom');

// React 18.3 moved `act` onto the React package; the test-utils export still
// works but warns on every call.
const act = typeof React.act === 'function' ? React.act : require('react-dom/test-utils').act;
const { WatchPartyContext } = require('../src/services/WatchParty/WatchPartyContext');
const useWatchPartyPlayer = require('../src/routes/Player/useWatchPartyPlayer');

global.IS_REACT_ACT_ENVIRONMENT = true;

const T0 = 1_700_000_000_000;
const DURATION_MS = 3_480_000;

const HOST_URL_PARAMS = {
    stream: 'encoded-stream',
    streamTransportUrl: 'https://addon.example/manifest.json',
    metaTransportUrl: 'https://meta.example/manifest.json',
    type: 'series',
    id: 'tt1',
    videoId: 'tt1:1:1',
};

// Mirrors the shape of `useVideo`: observed state plus the same setters, so the
// adapter is exercised through the real abstraction rather than the DOM.
const createFakeVideo = (overrides = {}) => {
    const calls = [];
    // The setters mutate observed state, as a real implementation would: without
    // that, a correction would appear to have no effect and the adapter would
    // look like it was oscillating when it is not.
    const video = {
        calls,
        state: {
            manifest: { name: 'HTMLVideo', props: ['time', 'paused', 'buffering', 'playbackSpeed', 'duration'], commands: ['load'] },
            stream: { infoHash: 'abc', fileIdx: 0 },
            loaded: true,
            paused: true,
            time: 60_000,
            duration: DURATION_MS,
            buffering: false,
            playbackSpeed: 1,
            volume: 100,
            muted: false,
            ...overrides,
        },
        setPaused: (value) => {
            calls.push(['setPaused', value]);
            video.state.paused = value;
        },
        setTime: (value) => {
            calls.push(['setTime', value]);
            video.state.time = value;
        },
        setPlaybackSpeed: (value) => {
            calls.push(['setPlaybackSpeed', value]);
            video.state.playbackSpeed = value;
        },
        setVolume: (value) => calls.push(['setVolume', value]),
        setMuted: (value) => calls.push(['setMuted', value]),
    };
    return video;
};

const createPlayback = (overrides = {}) => ({
    revision: 5,
    mediaRevision: 1,
    paused: true,
    positionMs: 60_000,
    rate: 1,
    updatedAtServerMs: T0,
    effectiveAtServerMs: T0,
    ...overrides,
});

const createWatchPartyValue = (overrides = {}) => {
    const commands = [];
    const readiness = [];
    const observations = [];
    const mediaChanges = [];
    const capabilities = [];
    const policies = [];
    const value = {
        available: true,
        inRoom: false,
        isHost: false,
        isFollower: false,
        status: 'connected',
        session: { supported: true, missingCapabilities: [] },
        room: null,
        media: null,
        source: null,
        mediaRevision: 0,
        resetRevision: 0,
        playback: null,
        participants: [],
        self: null,
        host: null,
        invitationUrl: null,
        lastError: null,
        closeReason: null,
        clock: { offsetMs: 0, uncertaintyMs: 10, isConfident: true },
        serverNow: () => T0,
        actions: {
            setCapabilities: (next) => capabilities.push(next),
            sendCommand: (action, options) => commands.push({ action, options }),
            setReady: (next) => readiness.push(next),
            observe: (next) => observations.push(next),
            changeMedia: (next) => mediaChanges.push(next),
            refreshSource: () => undefined,
            updatePolicy: (next) => policies.push(next),
            createRoom: () => Promise.resolve({}),
            leave: () => undefined,
            closeRoom: () => undefined,
            resetRoom: () => undefined,
            retryConnection: () => undefined,
        },
        ...overrides,
    };
    return { value, commands, readiness, observations, mediaChanges, capabilities, policies };
};

const renderAdapter = ({ watchPartyValue, video, player, urlParams, casting }) => {
    const result = { current: null };
    let renderCount = 0;
    const Probe = () => {
        renderCount += 1;
        result.current = useWatchPartyPlayer({
            player: player || { selected: { stream: video.state.stream }, title: 'Pilot', nextVideo: null },
            // A fresh object every render, exactly as `useVideo()` produces. The
            // adapter must not treat that as a reason to do anything.
            video: { ...video },
            urlParams: urlParams || HOST_URL_PARAMS,
            casting: casting === true,
        });
        return null;
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
        root.render(
            React.createElement(
                MemoryRouter,
                { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
                React.createElement(WatchPartyContext.Provider, { value: watchPartyValue }, React.createElement(Probe))
            )
        );
    });
    const render = () =>
        root.render(
            React.createElement(
                MemoryRouter,
                { future: { v7_startTransition: true, v7_relativeSplatPath: true } },
                React.createElement(WatchPartyContext.Provider, { value: watchPartyValue }, React.createElement(Probe))
            )
        );

    return {
        result,
        get renderCount() {
            return renderCount;
        },
        // Stands in for the renders the player produces naturally, several times
        // a second, as observed time advances.
        rerender(times = 1) {
            for (let index = 0; index < times; index += 1) {
                act(render);
            }
        },
        unmount() {
            act(() => root.unmount());
            container.remove();
        },
    };
};

describe('watch party player adapter: outside a party', () => {
    it('leaves autoplay and every control exactly as they were', () => {
        const { value } = createWatchPartyValue();
        const video = createFakeVideo();
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(result.current.inRoom).toBe(false);
        expect(result.current.autoplay).toBe(true);
        expect(result.current.controlsLocked).toBe(false);
        expect(result.current.handleTimelineIntent('play')).toBe(false);
        expect(video.calls).toEqual([]);
        unmount();
    });

    it('advertises the player implementation capabilities', () => {
        const { value, capabilities } = createWatchPartyValue();
        const video = createFakeVideo();
        const { unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(capabilities[capabilities.length - 1]).toEqual({
            scheduledActions: true,
            observeBuffering: true,
            setPlaybackRate: true,
            navigateNext: true,
            playerImplementation: 'HTMLVideo',
        });
        unmount();
    });
});

describe('watch party player adapter: host authority', () => {
    const hostValue = (playbackOverrides = {}) =>
        createWatchPartyValue({
            inRoom: true,
            isHost: true,
            isFollower: false,
            mediaRevision: 1,
            room: { roomId: 'r1', hostParticipantId: 'p1', policy: {} },
            media: { type: 'series', metaId: 'tt1', videoId: 'tt1:1:1', title: 'Pilot', expectedDurationMs: DURATION_MS, live: false },
            source: { streamParam: HOST_URL_PARAMS.stream, fingerprint: 'torrent:abc:0' },
            playback: createPlayback(playbackOverrides),
        });

    it('publishes one command per host intent and applies nothing locally', () => {
        const { value, commands } = hostValue();
        const video = createFakeVideo();
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });
        const callsBefore = video.calls.length;

        expect(result.current.handleTimelineIntent('play')).toBe(true);
        expect(commands).toEqual([{ action: 'play', options: {} }]);
        // The host waits for canonical state too, so it starts with everyone else.
        expect(video.calls.length).toBe(callsBefore);
        unmount();
    });

    it('sends the measured position with a pause and the target with a seek', () => {
        const { value, commands } = hostValue({ paused: false });
        const video = createFakeVideo({ paused: false });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        act(() => {
            result.current.handleTimelineIntent('pause');
            result.current.handleTimelineIntent('seek', { positionMs: 120_000 });
        });
        expect(commands).toEqual([
            { action: 'pause', options: { positionMs: 60_000 } },
            { action: 'seek', options: { positionMs: 120_000 } },
        ]);
        unmount();
    });

    it('does not lock the host out of the timeline controls', () => {
        const { value } = hostValue();
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video: createFakeVideo() });
        expect(result.current.controlsLocked).toBe(false);
        expect(result.current.isHost).toBe(true);
        unmount();
    });

    it('exposes room policy updates to the player menu', () => {
        const { value, policies } = hostValue();
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video: createFakeVideo() });

        act(() => result.current.updatePolicy({ allowGuestPlayPause: true }));

        expect(policies).toEqual([{ allowGuestPlayPause: true }]);
        unmount();
    });
});

describe('watch party player adapter: guest restrictions', () => {
    const guestValue = (overrides = {}) =>
        createWatchPartyValue({
            inRoom: true,
            isHost: false,
            isFollower: true,
            mediaRevision: 1,
            room: { roomId: 'r1', hostParticipantId: 'p-host', policy: {} },
            media: { type: 'series', metaId: 'tt1', videoId: 'tt1:1:1', title: 'Pilot', expectedDurationMs: DURATION_MS, live: false },
            source: { streamParam: HOST_URL_PARAMS.stream, fingerprint: 'torrent:abc:0' },
            playback: createPlayback(),
            ...overrides,
        });

    it('blocks every guest timeline intent without emitting a command', () => {
        const { value, commands } = guestValue();
        const video = createFakeVideo();
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(result.current.controlsLocked).toBe(true);
        ['play', 'pause', 'seek', 'rate'].forEach((action) => {
            expect(result.current.handleTimelineIntent(action, { positionMs: 1, rate: 2 })).toBe(true);
        });
        expect(commands).toEqual([]);
        unmount();
    });

    it('unlocks guest play/pause while keeping seek and rate locked', () => {
        const { value, commands } = guestValue({
            room: {
                roomId: 'r1',
                hostParticipantId: 'p-host',
                policy: { allowGuestPlayPause: true },
            },
        });
        const { result, unmount } = renderAdapter({
            watchPartyValue: value,
            video: createFakeVideo({ paused: false }),
        });

        expect(result.current.controlsLocked).toBe(true);
        expect(result.current.playPauseControlsLocked).toBe(false);
        expect(result.current.handleTimelineIntent('play')).toBe(true);
        expect(result.current.handleTimelineIntent('pause')).toBe(true);
        expect(result.current.handleTimelineIntent('seek', { positionMs: 1 })).toBe(true);
        expect(result.current.handleTimelineIntent('rate', { rate: 2 })).toBe(true);
        expect(commands).toEqual([
            { action: 'play', options: {} },
            { action: 'pause', options: { positionMs: 60_000 } },
        ]);
        unmount();
    });

    it('suppresses autoplay so a guest never starts before the room does', () => {
        const { value } = guestValue();
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video: createFakeVideo() });
        expect(result.current.autoplay).toBe(false);
        unmount();
    });
});

describe('watch party player adapter: applying canonical state', () => {
    const followerValue = (playbackOverrides, extra = {}) =>
        createWatchPartyValue({
            inRoom: true,
            isHost: false,
            isFollower: true,
            mediaRevision: 1,
            room: { roomId: 'r1', hostParticipantId: 'p-host', policy: {} },
            media: { type: 'series', metaId: 'tt1', videoId: 'tt1:1:1', title: 'Pilot', expectedDurationMs: DURATION_MS, live: false },
            source: { streamParam: HOST_URL_PARAMS.stream, fingerprint: 'torrent:abc:0' },
            playback: createPlayback(playbackOverrides),
            ...extra,
        });

    it('resumes a follower through the direct setters, with no command echo', () => {
        const { value, commands } = followerValue({ paused: false, effectiveAtServerMs: T0 - 1000, positionMs: 59_000 });
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(video.calls).toContainEqual(['setPaused', false]);
        // Applying remote state must never look like a local intent.
        expect(commands).toEqual([]);
        unmount();
    });

    it('hard aligns a follower that is far from the canonical position', () => {
        const { value } = followerValue({ paused: true, positionMs: 120_000 });
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(video.calls).toContainEqual(['setTime', 120_000]);
        unmount();
    });

    it('does not seek on load when the player is already in position', () => {
        jest.useFakeTimers();
        try {
            const { value } = followerValue({ paused: true, positionMs: 60_100 });
            const video = createFakeVideo({ paused: true, time: 60_000 });
            const { unmount } = renderAdapter({ watchPartyValue: value, video });

            expect(video.calls.filter(([name]) => name === 'setTime')).toEqual([]);
            act(() => jest.advanceTimersByTime(2000));
            expect(video.calls.filter(([name]) => name === 'setTime')).toEqual([]);
            expect(video.calls.filter(([name]) => name === 'setPaused')).toEqual([]);
            unmount();
        } finally {
            jest.useRealTimers();
        }
    });

    it('aligns exactly once on load when the player is out of position', () => {
        jest.useFakeTimers();
        try {
            const { value } = followerValue({ paused: true, positionMs: 120_000 });
            const video = createFakeVideo({ paused: true, time: 60_000 });
            const { unmount } = renderAdapter({ watchPartyValue: value, video });

            expect(video.calls.filter(([name]) => name === 'setTime')).toEqual([['setTime', 120_000]]);
            act(() => jest.advanceTimersByTime(2000));
            // Having landed, it settles: no oscillation, no repeated seeking.
            expect(video.calls.filter(([name]) => name === 'setTime')).toEqual([['setTime', 120_000]]);
            unmount();
        } finally {
            jest.useRealTimers();
        }
    });

    it('does not re-seek just because the player re-rendered', () => {
        // `useVideo()` returns a new object on every render, and the player
        // renders several times a second as observed time advances. Treating
        // that as a transition worth realigning turns correction into a seek
        // storm: the element restarts buffering on each seek and never plays a
        // run of frames, which looks like the video jumping between stills.
        const { value } = followerValue({ paused: true, positionMs: 120_000 });
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { rerender, unmount } = renderAdapter({ watchPartyValue: value, video });

        const seeksAfterLoad = video.calls.filter(([name]) => name === 'setTime').length;
        expect(seeksAfterLoad).toBe(1);

        rerender(12);
        expect(video.calls.filter(([name]) => name === 'setTime')).toHaveLength(seeksAfterLoad);
        unmount();
    });

    it('does not reissue a seek before the previous one has landed', () => {
        jest.useFakeTimers();
        try {
            // Observed time lags the element, so a correction computed straight
            // after a seek still sees the old position.
            const { value } = followerValue({ paused: false, effectiveAtServerMs: T0 - 60_000, positionMs: 0 });
            const video = createFakeVideo({ paused: false, time: 0 });
            // A player that ignores setTime entirely is the worst case.
            video.setTime = (v) => video.calls.push(['setTime', v]);
            const { unmount } = renderAdapter({ watchPartyValue: value, video });

            act(() => jest.advanceTimersByTime(1500));
            const seeks = video.calls.filter(([name]) => name === 'setTime').length;
            // One on load, and at most one more once the settle window expires —
            // not one per 250 ms correction tick.
            expect(seeks).toBeLessThanOrEqual(2);
            unmount();
        } finally {
            jest.useRealTimers();
        }
    });

    it('never touches volume, mute or any local-only control', () => {
        const { value } = followerValue({ paused: false, effectiveAtServerMs: T0 - 5000, positionMs: 0 });
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { unmount } = renderAdapter({ watchPartyValue: value, video });

        const touched = new Set(video.calls.map(([name]) => name));
        expect(touched.has('setVolume')).toBe(false);
        expect(touched.has('setMuted')).toBe(false);
        unmount();
    });

    it('does nothing at all without a clock estimate', () => {
        const { value } = followerValue({ paused: false, positionMs: 0 });
        value.serverNow = () => null;
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(video.calls).toEqual([]);
        unmount();
    });

    it('does nothing until the player has loaded', () => {
        const { value } = followerValue({ paused: false, positionMs: 0 });
        const video = createFakeVideo({ loaded: false, paused: true, time: null });
        const { unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(video.calls).toEqual([]);
        unmount();
    });

    it('force-aligns again when the host resets the room', () => {
        const { value, readiness } = followerValue({ paused: true, positionMs: 60_000 });
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const adapter = renderAdapter({ watchPartyValue: value, video });
        const readinessBeforeReset = readiness.length;
        video.calls.length = 0;
        video.state.time = 5_000;
        value.resetRevision += 1;

        adapter.rerender();

        expect(video.calls).toContainEqual(['setTime', 60_000]);
        expect(readiness.length).toBeGreaterThan(readinessBeforeReset);
        adapter.unmount();
    });
});

describe('watch party player adapter: readiness', () => {
    const followerValue = (extra = {}) =>
        createWatchPartyValue({
            inRoom: true,
            isHost: false,
            isFollower: true,
            mediaRevision: 1,
            room: { roomId: 'r1', hostParticipantId: 'p-host', policy: {} },
            media: { type: 'series', metaId: 'tt1', videoId: 'tt1:1:1', title: 'Pilot', expectedDurationMs: DURATION_MS, live: false },
            source: { streamParam: HOST_URL_PARAMS.stream, fingerprint: 'torrent:abc:0' },
            playback: createPlayback(),
            ...extra,
        });

    it('automatically announces readiness once the guest player is loaded and aligned', () => {
        const { value, readiness } = followerValue();
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(result.current.ready).toBe(true);
        expect(result.current.readinessReasons).not.toContain('activation-required');
        expect(readiness[0]).toMatchObject({ ready: true, loaded: true, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0' });
        unmount();
    });

    it('asks for a click only when the browser rejects synchronized playback', () => {
        jest.useFakeTimers();
        try {
            const { value } = followerValue({
                playback: createPlayback({ paused: false, effectiveAtServerMs: T0, positionMs: 60_000 }),
            });
            const video = createFakeVideo({ paused: true, time: 60_000 });
            // Model autoplay rejection: the setter is accepted by the adapter
            // but the observed player remains paused.
            video.setPaused = (next) => video.calls.push(['setPaused', next]);
            const adapter = renderAdapter({ watchPartyValue: value, video });

            expect(adapter.result.current.activationRequired).toBe(false);
            act(() => jest.advanceTimersByTime(1500));
            expect(adapter.result.current.activationRequired).toBe(true);
            expect(adapter.result.current.readinessReasons).toContain('activation-required');
            adapter.unmount();
        } finally {
            jest.useRealTimers();
        }
    });

    it('becomes ready once the participant activates playback', () => {
        const { value, readiness } = followerValue();
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        act(() => result.current.markReady());
        expect(result.current.ready).toBe(true);
        expect(readiness[readiness.length - 1].ready).toBe(true);
        unmount();
    });

    it('becomes ready while paused even though the element reports buffering', () => {
        // Chrome parks a paused media element below HAVE_FUTURE_DATA, which
        // stremio-video reports as buffering. Blocking on that would deadlock
        // the room: the barrier could never be satisfied, so nothing could start.
        const { value } = followerValue();
        const video = createFakeVideo({ paused: true, time: 60_000, buffering: true });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        act(() => result.current.markReady());
        expect(result.current.ready).toBe(true);
        unmount();
    });

    it('keeps reporting ready while buffering but keeping up', () => {
        // Chrome reports a normally playing element as below HAVE_FUTURE_DATA for
        // some sources. Treating that alone as "not ready" would leave a healthy
        // client permanently unready and deadlock the room.
        const { value } = followerValue({
            playback: createPlayback({ paused: false, effectiveAtServerMs: T0 - 1000, positionMs: 59_000 }),
        });
        const video = createFakeVideo({ paused: false, time: 60_000, buffering: true });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        act(() => result.current.markReady());
        expect(result.current.ready).toBe(true);
        unmount();
    });

    it('ignores buffering lasting 500 ms or less', () => {
        jest.useFakeTimers();
        try {
            const { value, readiness } = followerValue({
                playback: createPlayback({ paused: false, effectiveAtServerMs: T0, positionMs: 60_000 }),
            });
            const video = createFakeVideo({ paused: false, buffering: true });
            const adapter = renderAdapter({ watchPartyValue: value, video });

            act(() => jest.advanceTimersByTime(500));
            video.state.buffering = false;
            adapter.rerender();

            expect(readiness.every((entry) => entry.buffering === false)).toBe(true);
            adapter.unmount();
        } finally {
            jest.useRealTimers();
        }
    });

    it('reports buffering once it lasts beyond 500 ms', () => {
        jest.useFakeTimers();
        try {
            const { value, readiness } = followerValue({
                playback: createPlayback({ paused: false, effectiveAtServerMs: T0, positionMs: 60_000 }),
            });
            const video = createFakeVideo({ paused: false, buffering: true });
            const adapter = renderAdapter({ watchPartyValue: value, video });

            act(() => jest.advanceTimersByTime(501));

            expect(readiness[readiness.length - 1].buffering).toBe(true);
            adapter.unmount();
        } finally {
            jest.useRealTimers();
        }
    });

    it('stops reporting ready once a stall has let it fall behind', () => {
        const { value } = followerValue({
            playback: createPlayback({ paused: false, effectiveAtServerMs: T0 - 1000, positionMs: 59_000 }),
        });
        const video = createFakeVideo({ paused: false, time: 10_000, buffering: true });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        act(() => result.current.markReady());
        expect(result.current.ready).toBe(false);
        expect(result.current.readinessReasons).toContain('not-aligned');
        unmount();
    });

    it('refuses to claim readiness on an unsupported player', () => {
        const { value } = followerValue({ session: { supported: false, missingCapabilities: ['scheduledActions'] } });
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        act(() => result.current.markReady());
        expect(result.current.ready).toBe(false);
        expect(result.current.readinessReasons).toContain('unsupported-player');
        unmount();
    });

    it('refuses to claim readiness when the loaded source does not match', () => {
        const { value } = followerValue({ source: { streamParam: HOST_URL_PARAMS.stream, fingerprint: 'torrent:different:0' } });
        const video = createFakeVideo({ paused: true, time: 60_000 });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        act(() => result.current.markReady());
        expect(result.current.ready).toBe(false);
        expect(result.current.sourceCompatibility.status).toBe('fingerprint-mismatch');
        unmount();
    });

    it('keeps retrying readiness until it actually reaches the socket', () => {
        jest.useFakeTimers();
        try {
            const attempts = [];
            const { value } = followerValue();
            // `null` is what the provider returns when the socket is not open, so
            // a publish that never left the client must not be remembered as sent.
            value.actions.setReady = (next) => {
                attempts.push(next);
                return null;
            };
            const video = createFakeVideo({ paused: true, time: 60_000 });
            const { unmount } = renderAdapter({ watchPartyValue: value, video });

            const afterMount = attempts.length;
            expect(afterMount).toBeGreaterThan(0);
            act(() => jest.advanceTimersByTime(3000));
            expect(attempts.length).toBeGreaterThan(afterMount);
            unmount();
        } finally {
            jest.useRealTimers();
        }
    });

    it('refuses to claim readiness when the duration disagrees with the room', () => {
        const { value } = followerValue({
            media: { type: 'series', metaId: 'tt1', videoId: 'tt1:1:1', title: 'Pilot', expectedDurationMs: 1_000_000, live: false },
        });
        const video = createFakeVideo({ paused: true, time: 60_000, duration: DURATION_MS });
        const { result, unmount } = renderAdapter({ watchPartyValue: value, video });

        expect(result.current.sourceCompatibility.status).toBe('duration-mismatch');
        expect(result.current.ready).toBe(false);
        unmount();
    });
});

describe('watch party player adapter: teardown', () => {
    it('clears every timer it started', () => {
        jest.useFakeTimers();
        try {
            const { value } = createWatchPartyValue({
                inRoom: true,
                isHost: true,
                mediaRevision: 1,
                room: { roomId: 'r1', hostParticipantId: 'p1', policy: {} },
                media: { type: 'series', metaId: 'tt1', videoId: 'tt1:1:1', title: 'Pilot', expectedDurationMs: DURATION_MS, live: false },
                source: { streamParam: HOST_URL_PARAMS.stream, fingerprint: 'torrent:abc:0' },
                playback: createPlayback({ paused: false }),
            });
            const { unmount } = renderAdapter({ watchPartyValue: value, video: createFakeVideo() });
            expect(jest.getTimerCount()).toBeGreaterThan(0);

            unmount();
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});
