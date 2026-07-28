// Copyright (C) 2017-2026 Smart code 203358507

import type { PlaybackState } from '../protocol/types.ts';

/**
 * Pure canonical-position arithmetic.
 *
 * These functions are shared in spirit with the client's `drift.js`: both sides
 * must agree exactly on where the room "is" at a given server time, otherwise a
 * guest would correct toward a position the host never published.
 */

/** Positions are clamped into the known timeline; unknown duration means no upper bound. */
export const clampPositionMs = (positionMs: number, durationMs: number | null): number => {
    const lowerBounded = Math.max(0, Math.round(positionMs));
    if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) {
        return lowerBounded;
    }
    return Math.min(lowerBounded, Math.round(durationMs));
};

/**
 * Where the media should be at `atServerMs`.
 *
 * Three cases:
 * - paused: the position never moves;
 * - before `effectiveAtServerMs`: a scheduled transition has not started yet, so
 *   the position is still the published one (this is what makes a 500-1000 ms
 *   scheduled lead an aligned start rather than a jump);
 * - after: the published position plus elapsed time scaled by the rate.
 */
export const positionAtServerMs = (
    state: PlaybackState,
    atServerMs: number,
    durationMs: number | null = null,
): number => {
    if (state.paused) {
        return clampPositionMs(state.positionMs, durationMs);
    }
    const elapsedMs = atServerMs - state.effectiveAtServerMs;
    if (elapsedMs <= 0) {
        return clampPositionMs(state.positionMs, durationMs);
    }
    return clampPositionMs(state.positionMs + elapsedMs * state.rate, durationMs);
};

/** True while a scheduled transition has been published but has not taken effect. */
export const isPendingSchedule = (state: PlaybackState, atServerMs: number): boolean =>
    atServerMs < state.effectiveAtServerMs;

export const createInitialPlaybackState = (input: {
    nowMs: number;
    positionMs: number;
    rate: number;
    mediaRevision: number;
    durationMs?: number | null;
}): PlaybackState => ({
    revision: 1,
    mediaRevision: input.mediaRevision,
    // A room always starts paused: guests must load and pass the ready barrier
    // before anything plays (plan section 6.1).
    paused: true,
    positionMs: clampPositionMs(input.positionMs, input.durationMs ?? null),
    rate: input.rate,
    updatedAtServerMs: input.nowMs,
    effectiveAtServerMs: input.nowMs,
});

/**
 * Freezes playback at its current position, e.g. when the host disconnects or a
 * media change resets the room. Returns a paused state one revision newer.
 */
export const freezePlayback = (
    state: PlaybackState,
    nowMs: number,
    durationMs: number | null = null,
): PlaybackState => ({
    revision: state.revision + 1,
    mediaRevision: state.mediaRevision,
    paused: true,
    positionMs: positionAtServerMs(state, nowMs, durationMs),
    rate: state.rate,
    updatedAtServerMs: nowMs,
    effectiveAtServerMs: nowMs,
});

/** Resets playback to the start of a new media revision, paused and unscheduled. */
export const resetPlaybackForMedia = (
    state: PlaybackState,
    input: { nowMs: number; mediaRevision: number; positionMs: number; durationMs?: number | null },
): PlaybackState => ({
    revision: state.revision + 1,
    mediaRevision: input.mediaRevision,
    paused: true,
    positionMs: clampPositionMs(input.positionMs, input.durationMs ?? null),
    rate: state.rate,
    updatedAtServerMs: input.nowMs,
    effectiveAtServerMs: input.nowMs,
});
