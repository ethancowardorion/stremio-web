// Copyright (C) 2017-2023 Smart code 203358507

const { OUTCOME, routeTimelineIntent, computeReadiness } = require('../src/services/WatchParty/intents');

const route = (overrides) =>
    routeTimelineIntent({
        inRoom: true,
        isHost: true,
        action: 'play',
        options: undefined,
        videoState: { time: 60_000, paused: false, playbackSpeed: 1 },
        ...overrides,
    });

describe('watch party timeline intents: authority', () => {
    it('lets the player act normally when there is no party', () => {
        const decision = route({ inRoom: false });
        expect(decision.outcome).toBe(OUTCOME.APPLY_LOCALLY);
        expect(decision.handled).toBe(false);
        expect(decision.command).toBeNull();
    });

    it('blocks a guest and publishes nothing', () => {
        ['play', 'pause', 'seek', 'rate'].forEach((action) => {
            const decision = route({ isHost: false, action, options: { positionMs: 1000, rate: 2 } });
            expect(decision.outcome).toBe(OUTCOME.BLOCKED);
            // `handled` true means the player must not apply the change either,
            // so a blocked guest intent has no local effect at all.
            expect(decision.handled).toBe(true);
            expect(decision.command).toBeNull();
        });
    });

    it('lets an authorized guest publish only play and pause', () => {
        const play = route({ isHost: false, allowGuestPlayPause: true, action: 'play' });
        const pause = route({ isHost: false, allowGuestPlayPause: true, action: 'pause' });
        expect(play).toEqual({
            outcome: OUTCOME.PUBLISH,
            handled: true,
            command: { action: 'play', options: {} },
        });
        expect(pause.command).toEqual({ action: 'pause', options: { positionMs: 60_000 } });

        ['seek', 'rate'].forEach((action) => {
            const decision = route({ isHost: false, allowGuestPlayPause: true, action, options: { positionMs: 1000, rate: 2 } });
            expect(decision.outcome).toBe(OUTCOME.BLOCKED);
            expect(decision.command).toBeNull();
        });
    });

    it('takes ownership of the host intent instead of applying it locally', () => {
        // The host follows canonical state like everyone else, so it starts at the
        // same scheduled instant rather than a lead time early.
        const decision = route({ action: 'play' });
        expect(decision.outcome).toBe(OUTCOME.PUBLISH);
        expect(decision.handled).toBe(true);
        expect(decision.command).toEqual({ action: 'play', options: {} });
    });

    it('ignores actions that are not timeline actions', () => {
        const decision = route({ action: 'volume' });
        expect(decision.outcome).toBe(OUTCOME.APPLY_LOCALLY);
        expect(decision.handled).toBe(false);
    });
});

describe('watch party timeline intents: commands', () => {
    it('sends the host measured position with a pause', () => {
        expect(route({ action: 'pause' }).command).toEqual({ action: 'pause', options: { positionMs: 60_000 } });
    });

    it('omits the position when the player does not report one', () => {
        expect(route({ action: 'pause', videoState: { time: null } }).command).toEqual({ action: 'pause', options: {} });
    });

    it('uses the requested seek target, falling back to the current position', () => {
        expect(route({ action: 'seek', options: { positionMs: 120_000 } }).command).toEqual({
            action: 'seek',
            options: { positionMs: 120_000 },
        });
        expect(route({ action: 'seek' }).command).toEqual({ action: 'seek', options: { positionMs: 60_000 } });
    });

    it('refuses a seek with no target rather than publishing a malformed command', () => {
        const decision = route({ action: 'seek', videoState: { time: null } });
        expect(decision.outcome).toBe(OUTCOME.BLOCKED);
        expect(decision.command).toBeNull();
    });

    it('publishes an explicit rate and refuses a missing one', () => {
        expect(route({ action: 'rate', options: { rate: 1.5 } }).command).toEqual({
            action: 'rate',
            options: { rate: 1.5 },
        });
        expect(route({ action: 'rate' }).command).toBeNull();
        expect(route({ action: 'rate' }).outcome).toBe(OUTCOME.BLOCKED);
    });
});

describe('watch party readiness', () => {
    const readiness = (overrides) =>
        computeReadiness({
            inRoom: true,
            supported: true,
            activated: true,
            activationRequired: false,
            loaded: true,
            sourceCompatible: true,
            aligned: true,
            ...overrides,
        });

    it('is ready only when every condition holds', () => {
        expect(readiness()).toEqual({ ready: true, reasons: [] });
    });

    it('names each reason a client is not synchronized', () => {
        expect(readiness({ inRoom: false }).reasons).toContain('not-in-room');
        expect(readiness({ supported: false }).reasons).toContain('unsupported-player');
        expect(readiness({ activated: false }).reasons).not.toContain('activation-required');
        expect(readiness({ activationRequired: true }).reasons).toContain('activation-required');
        expect(readiness({ loaded: false }).reasons).toContain('not-loaded');
        expect(readiness({ sourceCompatible: false }).reasons).toContain('source-incompatible');
        expect(readiness({ aligned: false }).reasons).toContain('not-aligned');
    });

    it('reports every failing condition, not just the first', () => {
        const result = readiness({ loaded: false, supported: false, aligned: false });
        expect(result.ready).toBe(false);
        expect(result.reasons).toEqual(expect.arrayContaining(['not-loaded', 'unsupported-player', 'not-aligned']));
    });

    it('never reports ready while the browser still needs an activation gesture', () => {
        expect(readiness({ activationRequired: true }).ready).toBe(false);
    });

    it('reports ready before playback activation when the paused player is loaded and aligned', () => {
        expect(readiness({ activated: false })).toEqual({ ready: true, reasons: [] });
    });

    it('never gates readiness on the buffering flag', () => {
        // Chrome reports both a paused element and, for some sources, a normally
        // playing one as below HAVE_FUTURE_DATA, which stremio-video surfaces as
        // buffering. Gating on it would leave a healthy client permanently
        // unready, and since the host must be ready for playback to start, the
        // room would deadlock. A client that has genuinely fallen behind is
        // caught by `aligned`.
        expect(readiness({ buffering: true })).toEqual({ ready: true, reasons: [] });
        expect(readiness({ aligned: false }).reasons).toEqual(['not-aligned']);
    });
});
