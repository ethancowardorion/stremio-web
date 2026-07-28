// Copyright (C) 2017-2023 Smart code 203358507

const {
    DEADBAND_MS,
    HARD_SEEK_THRESHOLD_MS,
    REASON,
    expectedPositionMs,
    decideCorrection,
    isSynchronized,
} = require('../src/services/WatchParty/drift');

const T0 = 1_700_000_000_000;
const DURATION_MS = 3_480_000;

const playback = (overrides) => ({
    revision: 5,
    mediaRevision: 1,
    paused: false,
    positionMs: 60_000,
    rate: 1,
    updatedAtServerMs: T0,
    effectiveAtServerMs: T0,
    ...overrides,
});

const decide = (overrides) =>
    decideCorrection({
        playback: playback(),
        serverNowMs: T0,
        localPositionMs: 60_000,
        localPaused: false,
        localRate: 1,
        durationMs: DURATION_MS,
        ...overrides,
    });

describe('watch party expected position', () => {
    it('does not advance while paused', () => {
        expect(expectedPositionMs(playback({ paused: true }), T0 + 30_000, DURATION_MS)).toBe(60_000);
    });

    it('advances with elapsed server time, scaled by the rate', () => {
        expect(expectedPositionMs(playback(), T0 + 10_000, DURATION_MS)).toBe(70_000);
        expect(expectedPositionMs(playback({ rate: 1.5 }), T0 + 10_000, DURATION_MS)).toBe(75_000);
    });

    it('clamps to the timeline and returns null without canonical state', () => {
        expect(expectedPositionMs(playback({ positionMs: DURATION_MS - 500 }), T0 + 60_000, DURATION_MS)).toBe(DURATION_MS);
        expect(expectedPositionMs(playback({ positionMs: -5000 }), T0, DURATION_MS)).toBe(0);
        expect(expectedPositionMs(null, T0, DURATION_MS)).toBeNull();
    });

    it('leaves the upper bound open when the duration is unknown', () => {
        expect(expectedPositionMs(playback(), T0 + 10_000, null)).toBe(70_000);
    });
});

describe('watch party correction: preconditions', () => {
    it('does nothing without canonical state or without a clock estimate', () => {
        expect(decide({ playback: null }).reason).toBe(REASON.NO_CANONICAL_STATE);
        expect(decide({ serverNowMs: null }).reason).toBe(REASON.NO_CLOCK);
        expect(decide({ serverNowMs: null }).seekToMs).toBeNull();
    });

    it('pre-positions while paused during a scheduled start', () => {
        const decision = decide({
            playback: playback({ effectiveAtServerMs: T0 + 750 }),
            localPositionMs: 50_000,
            localPaused: false,
        });
        expect(decision.reason).toBe(REASON.SCHEDULE_PENDING);
        expect(decision.paused).toBe(true);
        expect(decision.seekToMs).toBe(60_000);
    });

    it('does not seek during a scheduled start when already at the target', () => {
        const decision = decide({
            playback: playback({ effectiveAtServerMs: T0 + 750 }),
            localPositionMs: 60_100,
            localPaused: true,
        });
        expect(decision.reason).toBe(REASON.SCHEDULE_PENDING);
        expect(decision.paused).toBeNull();
        expect(decision.seekToMs).toBeNull();
    });

    it('hard aligns on a forced align when the player is out of position', () => {
        const decision = decide({ forceAlign: true, localPositionMs: 60_010, serverNowMs: T0 + 10_000 });
        expect(decision.reason).toBe(REASON.FORCED_ALIGN);
        expect(decision.seekToMs).toBe(70_000);
    });

    it('does not seek on a forced align when already in position', () => {
        // Seeking a correctly positioned player restarts its buffering for no
        // benefit; repeating that is what makes playback stutter.
        const decision = decide({ forceAlign: true, localPositionMs: 70_100, serverNowMs: T0 + 10_000 });
        expect(decision.reason).toBe(REASON.FORCED_ALIGN);
        expect(decision.seekToMs).toBeNull();
    });
});

describe('watch party correction: play state', () => {
    it('resumes a locally paused follower and aligns it at the same time', () => {
        const decision = decide({ localPaused: true, localPositionMs: 10_000, serverNowMs: T0 + 10_000 });
        expect(decision.reason).toBe(REASON.PAUSE_MISMATCH);
        expect(decision.paused).toBe(false);
        expect(decision.seekToMs).toBe(70_000);
    });

    it('pauses a locally playing follower when the room is paused', () => {
        const decision = decide({ playback: playback({ paused: true }), localPaused: false, localPositionMs: 60_050 });
        expect(decision.paused).toBe(true);
        // Already aligned, so no visible seek is needed.
        expect(decision.seekToMs).toBeNull();
    });

    it('aligns position while the room is paused', () => {
        const aligned = decide({ playback: playback({ paused: true }), localPaused: true, localPositionMs: 60_200 });
        expect(aligned.reason).toBe(REASON.ALIGNED);
        expect(aligned.seekToMs).toBeNull();

        const drifted = decide({ playback: playback({ paused: true }), localPaused: true, localPositionMs: 65_000 });
        expect(drifted.reason).toBe(REASON.HARD_SEEK);
        expect(drifted.seekToMs).toBe(60_000);
    });
});

describe('watch party correction: drift thresholds', () => {
    it('does nothing inside the deadband, at the exact boundary included', () => {
        const atBoundary = decide({ localPositionMs: 60_000 + DEADBAND_MS });
        expect(atBoundary.reason).toBe(REASON.ALIGNED);
        expect(atBoundary.seekToMs).toBeNull();
        expect(atBoundary.driftMs).toBe(DEADBAND_MS);
    });

    it('only monitors between the deadband and the hard-seek threshold', () => {
        const justOver = decide({ localPositionMs: 60_000 + DEADBAND_MS + 1 });
        expect(justOver.reason).toBe(REASON.MONITOR);
        expect(justOver.seekToMs).toBeNull();

        const atHardBoundary = decide({ localPositionMs: 60_000 + HARD_SEEK_THRESHOLD_MS });
        expect(atHardBoundary.reason).toBe(REASON.MONITOR);
        expect(atHardBoundary.seekToMs).toBeNull();
    });

    it('hard seeks past the threshold, in both directions', () => {
        const ahead = decide({ localPositionMs: 60_000 + HARD_SEEK_THRESHOLD_MS + 1 });
        expect(ahead.reason).toBe(REASON.HARD_SEEK);
        expect(ahead.seekToMs).toBe(60_000);
        expect(ahead.driftMs).toBe(HARD_SEEK_THRESHOLD_MS + 1);

        const behind = decide({ localPositionMs: 60_000 - HARD_SEEK_THRESHOLD_MS - 1 });
        expect(behind.reason).toBe(REASON.HARD_SEEK);
        expect(behind.seekToMs).toBe(60_000);
        expect(behind.driftMs).toBe(-HARD_SEEK_THRESHOLD_MS - 1);
    });

    it('never seeks a player that is buffering and has fallen behind', () => {
        const decision = decide({ localPositionMs: 0, buffering: true });
        expect(decision.reason).toBe(REASON.BUFFERING);
        expect(decision.seekToMs).toBeNull();
    });

    it('ignores the buffering flag while drift is within tolerance', () => {
        // Chrome reports a normally playing element as below HAVE_FUTURE_DATA for
        // some sources, so buffering on its own says nothing about whether this
        // client is keeping up. Only real drift does.
        const decision = decide({ localPositionMs: 60_000, buffering: true });
        expect(decision.reason).toBe(REASON.ALIGNED);
        expect(isSynchronized(decision)).toBe(true);
    });
});

describe('watch party correction: soft rate correction', () => {
    it('is off by default, so MVP only monitors moderate drift', () => {
        expect(decide({ localPositionMs: 60_500 }).rate).toBeNull();
    });

    it('slows a follower that is ahead and speeds up one that is behind', () => {
        const ahead = decide({ localPositionMs: 60_500, softCorrection: true, canSetRate: true });
        expect(ahead.reason).toBe(REASON.SOFT_RATE);
        expect(ahead.rate).toBeCloseTo(0.95, 5);

        const behind = decide({ localPositionMs: 59_500, softCorrection: true, canSetRate: true });
        expect(behind.rate).toBeCloseTo(1.05, 5);
    });

    it('scales the correction from the host-selected base rate, never replacing it', () => {
        const decision = decideCorrection({
            playback: playback({ rate: 1.5 }),
            serverNowMs: T0,
            localPositionMs: 60_500,
            localPaused: false,
            localRate: 1.5,
            durationMs: DURATION_MS,
            softCorrection: true,
            canSetRate: true,
        });
        expect(decision.rate).toBeCloseTo(1.425, 5);
    });

    it('does not nudge the rate when the implementation cannot set one', () => {
        const decision = decide({ localPositionMs: 60_500, softCorrection: true, canSetRate: false });
        expect(decision.reason).toBe(REASON.MONITOR);
        expect(decision.rate).toBeNull();
    });

    it('restores the base rate once drift falls back inside the restore window', () => {
        const decision = decide({ localPositionMs: 60_100, localRate: 0.95, canSetRate: true, softCorrection: true });
        expect(decision.reason).toBe(REASON.ALIGNED);
        expect(decision.rate).toBe(1);
    });

    it('restores the canonical rate whenever the local rate disagrees', () => {
        const decision = decide({ playback: playback({ rate: 2 }), localRate: 1, canSetRate: true, localPositionMs: 60_000 });
        expect(decision.rate).toBe(2);
    });
});

describe('watch party synchronization reporting', () => {
    it('reports synchronized only when nothing needs correcting', () => {
        expect(isSynchronized(decide({ localPositionMs: 60_000 }))).toBe(true);
        expect(isSynchronized(decide({ localPositionMs: 60_500 }))).toBe(true);
        expect(isSynchronized(decide({ localPositionMs: 90_000 }))).toBe(false);
        expect(isSynchronized(decide({ localPaused: true }))).toBe(false);
        expect(isSynchronized(decide({ serverNowMs: null }))).toBe(false);
        expect(isSynchronized(decide({ playback: null }))).toBe(false);
        expect(isSynchronized(null)).toBe(false);
    });

    it('never reports synchronized while a scheduled start is pending', () => {
        const decision = decide({ playback: playback({ effectiveAtServerMs: T0 + 750 }), localPaused: true });
        expect(isSynchronized(decision)).toBe(false);
    });

    it('does not report synchronized when buffering has let it fall behind', () => {
        expect(isSynchronized(decide({ buffering: true, localPositionMs: 0 }))).toBe(false);
    });
});
