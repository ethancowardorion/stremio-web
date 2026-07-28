// Copyright (C) 2017-2026 Smart code 203358507

// Drift and authority decisions.
//
// Pure by design: this module never touches React or the player. It answers one
// question — "given canonical room state and what the local player is actually
// doing, what should change?" — so the thresholds can be tested at their exact
// boundaries and tuned from spike evidence without touching the adapter.

// Below this, do nothing. Correcting inside the deadband produces visible
// oscillation for no benefit.
const DEADBAND_MS = 250;

// Above this, hard seek. Between the deadband and here, MVP only monitors;
// soft rate correction is opt-in until the drift spike sets final numbers.
const HARD_SEEK_THRESHOLD_MS = 1000;

// A paused room can be aligned invisibly, so it uses the tighter bound.
const PAUSED_ALIGN_THRESHOLD_MS = 250;

// Temporary rate nudge used by soft correction.
const SOFT_RATE_FACTOR = 0.05;

// Once drift falls under this, the base rate is restored.
const SOFT_RESTORE_MS = 150;

const REASON = {
    NO_CANONICAL_STATE: 'no-canonical-state',
    NO_CLOCK: 'no-clock',
    SCHEDULE_PENDING: 'schedule-pending',
    FORCED_ALIGN: 'forced-align',
    PAUSE_MISMATCH: 'pause-mismatch',
    ALIGNED: 'aligned',
    MONITOR: 'monitor',
    SOFT_RATE: 'soft-rate',
    HARD_SEEK: 'hard-seek',
    BUFFERING: 'buffering',
};

const clampPositionMs = (positionMs, durationMs) => {
    const lowerBounded = Math.max(0, Math.round(positionMs));
    if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs <= 0) {
        return lowerBounded;
    }
    return Math.min(lowerBounded, Math.round(durationMs));
};

// Where the media should be at a given server time. Must agree exactly with the
// service's own calculation, or guests would correct toward a position the host
// never published.
const expectedPositionMs = (playback, serverNowMs, durationMs) => {
    if (playback === null || typeof playback !== 'object') {
        return null;
    }
    if (playback.paused) {
        return clampPositionMs(playback.positionMs, durationMs);
    }
    const elapsedMs = serverNowMs - playback.effectiveAtServerMs;
    if (elapsedMs <= 0) {
        return clampPositionMs(playback.positionMs, durationMs);
    }
    return clampPositionMs(playback.positionMs + elapsedMs * playback.rate, durationMs);
};

const noChange = (reason, extra) => ({
    paused: null,
    seekToMs: null,
    rate: null,
    driftMs: null,
    expectedPositionMs: null,
    reason,
    ...extra,
});

// Decides what the local player should be told to do right now.
//
// Returns a plain description of the desired change; every field that is `null`
// means "leave this alone". The adapter applies it through the direct player
// setters, never through the local intent path, so nothing echoes back as a new
// command.
const decideCorrection = (input) => {
    const {
        playback,
        serverNowMs,
        localPositionMs,
        localPaused,
        localRate,
        durationMs = null,
        buffering = false,
        forceAlign = false,
        softCorrection = false,
        canSetRate = false,
    } = input;

    if (playback === null || playback === undefined) {
        return noChange(REASON.NO_CANONICAL_STATE);
    }
    if (typeof serverNowMs !== 'number' || !isFinite(serverNowMs)) {
        // Without a clock estimate a guest cannot know where the room is; doing
        // nothing is safer than guessing.
        return noChange(REASON.NO_CLOCK);
    }

    const baseRate = playback.rate;
    const rateCorrection = canSetRate && typeof localRate === 'number' && localRate !== baseRate ? baseRate : null;

    // A published-but-not-yet-effective transition: pre-position while staying
    // paused. That is exactly what the scheduled lead time is for.
    if (serverNowMs < playback.effectiveAtServerMs) {
        const target = clampPositionMs(playback.positionMs, durationMs);
        const pendingDriftMs = typeof localPositionMs === 'number' ? localPositionMs - target : null;
        return {
            paused: localPaused === false ? true : null,
            seekToMs: pendingDriftMs !== null && Math.abs(pendingDriftMs) > PAUSED_ALIGN_THRESHOLD_MS ? target : null,
            rate: rateCorrection,
            driftMs: pendingDriftMs,
            expectedPositionMs: target,
            reason: REASON.SCHEDULE_PENDING,
        };
    }

    const expected = expectedPositionMs(playback, serverNowMs, durationMs);
    const driftMs = typeof localPositionMs === 'number' ? localPositionMs - expected : null;

    // A reconnect or a fresh media load always hard aligns before the client is
    // allowed to claim it is synchronized.
    if (forceAlign) {
        return {
            paused: localPaused !== playback.paused ? playback.paused : null,
            seekToMs: expected,
            rate: rateCorrection,
            driftMs,
            expectedPositionMs: expected,
            reason: REASON.FORCED_ALIGN,
        };
    }

    if (localPaused !== null && localPaused !== undefined && localPaused !== playback.paused) {
        // Align position at the same time, so resuming does not immediately
        // trigger a second correction.
        const misalignedMs = driftMs === null ? 0 : Math.abs(driftMs);
        return {
            paused: playback.paused,
            seekToMs: misalignedMs > PAUSED_ALIGN_THRESHOLD_MS ? expected : null,
            rate: rateCorrection,
            driftMs,
            expectedPositionMs: expected,
            reason: REASON.PAUSE_MISMATCH,
        };
    }

    if (driftMs === null) {
        return noChange(REASON.NO_CANONICAL_STATE, { expectedPositionMs: expected });
    }

    const absoluteDriftMs = Math.abs(driftMs);

    if (playback.paused) {
        return {
            paused: null,
            seekToMs: absoluteDriftMs > PAUSED_ALIGN_THRESHOLD_MS ? expected : null,
            rate: rateCorrection,
            driftMs,
            expectedPositionMs: expected,
            reason: absoluteDriftMs > PAUSED_ALIGN_THRESHOLD_MS ? REASON.HARD_SEEK : REASON.ALIGNED,
        };
    }

    if (buffering) {
        // Seeking a player that is already struggling makes it worse; it catches
        // up on its own once it can play again.
        return {
            paused: null,
            seekToMs: null,
            rate: rateCorrection,
            driftMs,
            expectedPositionMs: expected,
            reason: REASON.BUFFERING,
        };
    }

    if (absoluteDriftMs > HARD_SEEK_THRESHOLD_MS) {
        return {
            paused: null,
            seekToMs: expected,
            rate: rateCorrection,
            driftMs,
            expectedPositionMs: expected,
            reason: REASON.HARD_SEEK,
        };
    }

    if (absoluteDriftMs > DEADBAND_MS) {
        if (softCorrection && canSetRate) {
            // Ahead of the room: slow down. Behind: speed up. Always relative to
            // the host-selected base rate, never replacing it.
            const factor = driftMs > 0 ? 1 - SOFT_RATE_FACTOR : 1 + SOFT_RATE_FACTOR;
            return {
                paused: null,
                seekToMs: null,
                rate: baseRate * factor,
                driftMs,
                expectedPositionMs: expected,
                reason: REASON.SOFT_RATE,
            };
        }
        return {
            paused: null,
            seekToMs: null,
            rate: rateCorrection,
            driftMs,
            expectedPositionMs: expected,
            reason: REASON.MONITOR,
        };
    }

    // Inside the deadband. If soft correction had nudged the rate, restore it.
    const shouldRestoreRate =
        canSetRate && typeof localRate === 'number' && localRate !== baseRate && absoluteDriftMs <= SOFT_RESTORE_MS;
    return {
        paused: null,
        seekToMs: null,
        rate: shouldRestoreRate ? baseRate : rateCorrection,
        driftMs,
        expectedPositionMs: expected,
        reason: REASON.ALIGNED,
    };
};

// Whether the client may report itself as synchronized. Used for the ready flag
// so an unaligned or unsupported client never claims to be in sync.
const isSynchronized = (decision) =>
    decision !== null &&
    decision.seekToMs === null &&
    decision.paused === null &&
    (decision.reason === REASON.ALIGNED || decision.reason === REASON.MONITOR);

module.exports = {
    DEADBAND_MS,
    HARD_SEEK_THRESHOLD_MS,
    PAUSED_ALIGN_THRESHOLD_MS,
    SOFT_RATE_FACTOR,
    SOFT_RESTORE_MS,
    REASON,
    clampPositionMs,
    expectedPositionMs,
    decideCorrection,
    isSynchronized,
};
