// Copyright (C) 2017-2026 Smart code 203358507

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolError } from '../src/protocol/errors.ts';
import type { PlaybackState } from '../src/protocol/types.ts';
import {
    clampPositionMs,
    createInitialPlaybackState,
    freezePlayback,
    isPendingSchedule,
    positionAtServerMs,
    resetPlaybackForMedia,
} from '../src/sync/canonicalPlayback.ts';
import { CommandHistory, applyPlaybackCommand, type ApplyCommandContext, type PlaybackCommand } from '../src/sync/commands.ts';

const T0 = 1_700_000_000_000;
const DURATION_MS = 3_480_000;

const playing = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
    revision: 10,
    mediaRevision: 1,
    paused: false,
    positionMs: 60_000,
    rate: 1,
    updatedAtServerMs: T0,
    effectiveAtServerMs: T0,
    ...overrides,
});

const paused = (overrides: Partial<PlaybackState> = {}): PlaybackState =>
    playing({ paused: true, ...overrides });

const context = (overrides: Partial<ApplyCommandContext> = {}): ApplyCommandContext => ({
    nowMs: T0,
    durationMs: DURATION_MS,
    defaultLeadMs: 750,
    lastServerInitiatedRevision: 0,
    appliedCommandIds: new Set<string>(),
    ...overrides,
});

const command = (overrides: Partial<PlaybackCommand> = {}): PlaybackCommand => ({
    commandId: 'c1',
    action: 'pause',
    expectedRevision: 10,
    mediaRevision: 1,
    ...overrides,
});

// ------------------------------------------------------------ canonical state

test('clamp: positions are bounded to the known timeline and rounded', () => {
    assert.equal(clampPositionMs(-5, DURATION_MS), 0);
    assert.equal(clampPositionMs(10.6, DURATION_MS), 11);
    assert.equal(clampPositionMs(DURATION_MS + 1000, DURATION_MS), DURATION_MS);
});

test('clamp: an unknown duration leaves the upper bound open', () => {
    assert.equal(clampPositionMs(9_999_999, null), 9_999_999);
    assert.equal(clampPositionMs(9_999_999, 0), 9_999_999);
});

test('position: a paused room never advances', () => {
    const state = paused();
    assert.equal(positionAtServerMs(state, T0 + 60_000, DURATION_MS), 60_000);
});

test('position: a playing room advances with elapsed server time', () => {
    const state = playing();
    assert.equal(positionAtServerMs(state, T0 + 5_000, DURATION_MS), 65_000);
});

test('position: the rate scales elapsed time', () => {
    const state = playing({ rate: 2 });
    assert.equal(positionAtServerMs(state, T0 + 5_000, DURATION_MS), 70_000);
});

test('position: a scheduled start does not advance before it takes effect', () => {
    const state = playing({ effectiveAtServerMs: T0 + 750 });
    assert.equal(isPendingSchedule(state, T0), true);
    assert.equal(positionAtServerMs(state, T0, DURATION_MS), 60_000);
    assert.equal(positionAtServerMs(state, T0 + 750, DURATION_MS), 60_000);
    assert.equal(positionAtServerMs(state, T0 + 1_750, DURATION_MS), 61_000);
    assert.equal(isPendingSchedule(state, T0 + 1_000), false);
});

test('position: playback cannot run past a known duration', () => {
    const state = playing({ positionMs: DURATION_MS - 1_000 });
    assert.equal(positionAtServerMs(state, T0 + 60_000, DURATION_MS), DURATION_MS);
});

test('initial state: a new room starts paused at the requested position', () => {
    const state = createInitialPlaybackState({ nowMs: T0, positionMs: 12_345, rate: 1, mediaRevision: 1, durationMs: DURATION_MS });
    assert.equal(state.paused, true);
    assert.equal(state.positionMs, 12_345);
    assert.equal(state.revision, 1);
    assert.equal(state.effectiveAtServerMs, T0);
});

test('freeze: pins the live position and bumps the revision', () => {
    const frozen = freezePlayback(playing(), T0 + 10_000, DURATION_MS);
    assert.equal(frozen.paused, true);
    assert.equal(frozen.positionMs, 70_000);
    assert.equal(frozen.revision, 11);
    assert.equal(frozen.effectiveAtServerMs, T0 + 10_000);
});

test('media reset: restarts paused at zero on the new revision', () => {
    const reset = resetPlaybackForMedia(playing(), { nowMs: T0 + 5, mediaRevision: 2, positionMs: 0 });
    assert.equal(reset.mediaRevision, 2);
    assert.equal(reset.paused, true);
    assert.equal(reset.positionMs, 0);
    assert.equal(reset.revision, 11);
});

// ------------------------------------------------------------------- commands

test('play: schedules the start ahead and keeps the paused position', () => {
    const result = applyPlaybackCommand(paused(), command({ action: 'play' }), context());
    assert.equal(result.outcome, 'applied');
    assert.equal(result.state.paused, false);
    assert.equal(result.state.positionMs, 60_000);
    assert.equal(result.state.effectiveAtServerMs, T0 + 750);
    assert.equal(result.state.revision, 11);
    // Nothing should have moved before the scheduled instant.
    assert.equal(positionAtServerMs(result.state, T0 + 750, DURATION_MS), 60_000);
    assert.equal(positionAtServerMs(result.state, T0 + 1_750, DURATION_MS), 61_000);
});

test('play: an explicit lead overrides the default', () => {
    const result = applyPlaybackCommand(paused(), command({ action: 'play', leadMs: 0 }), context());
    assert.equal(result.state.effectiveAtServerMs, T0);
});

test('play: while already playing, the scheduled position accounts for the lead', () => {
    const result = applyPlaybackCommand(playing(), command({ action: 'play' }), context({ nowMs: T0 + 10_000 }));
    // Position at the effective instant, i.e. 10.75 s after the last update.
    assert.equal(result.state.positionMs, 70_750);
});

test('pause: takes effect immediately at the measured position', () => {
    const result = applyPlaybackCommand(playing(), command({ action: 'pause', positionMs: 71_234 }), context({ nowMs: T0 + 10_000 }));
    assert.equal(result.state.paused, true);
    assert.equal(result.state.positionMs, 71_234);
    assert.equal(result.state.effectiveAtServerMs, T0 + 10_000);
});

test('pause: without a measured position, canonical position is used', () => {
    const result = applyPlaybackCommand(playing(), command({ action: 'pause' }), context({ nowMs: T0 + 10_000 }));
    assert.equal(result.state.positionMs, 70_000);
});

test('seek: while paused applies immediately and keeps the paused flag', () => {
    const result = applyPlaybackCommand(paused(), command({ action: 'seek', positionMs: 120_000 }), context());
    assert.equal(result.state.paused, true);
    assert.equal(result.state.positionMs, 120_000);
    assert.equal(result.state.effectiveAtServerMs, T0);
});

test('seek: while playing gets the same lead as a play, so clients can buffer', () => {
    const result = applyPlaybackCommand(playing(), command({ action: 'seek', positionMs: 120_000 }), context());
    assert.equal(result.state.paused, false);
    assert.equal(result.state.positionMs, 120_000);
    assert.equal(result.state.effectiveAtServerMs, T0 + 750);
});

test('seek: targets beyond the duration are clamped', () => {
    const result = applyPlaybackCommand(paused(), command({ action: 'seek', positionMs: DURATION_MS + 5_000 }), context());
    assert.equal(result.state.positionMs, DURATION_MS);
});

test('seek: a missing position is a validation failure, not a silent no-op', () => {
    assert.throws(
        () => applyPlaybackCommand(paused(), command({ action: 'seek' }), context()),
        (error: unknown) => error instanceof ProtocolError && error.code === 'VALIDATION_FAILED',
    );
});

test('rate: rebases the position before changing the rate', () => {
    const result = applyPlaybackCommand(playing(), command({ action: 'rate', rate: 2 }), context({ nowMs: T0 + 10_000 }));
    assert.equal(result.state.rate, 2);
    assert.equal(result.state.positionMs, 70_000);
    // The elapsed 10 s must not be replayed at the new rate.
    assert.equal(positionAtServerMs(result.state, T0 + 15_000, DURATION_MS), 80_000);
});

test('rate: a missing rate is a validation failure', () => {
    assert.throws(
        () => applyPlaybackCommand(playing(), command({ action: 'rate' }), context()),
        (error: unknown) => error instanceof ProtocolError && error.code === 'VALIDATION_FAILED',
    );
});

test('idempotency: a replayed command id is a no-op that reports the current state', () => {
    const state = playing();
    const result = applyPlaybackCommand(state, command({ action: 'pause' }), context({ appliedCommandIds: new Set(['c1']) }));
    assert.equal(result.outcome, 'duplicate');
    assert.equal(result.state, state);
});

test('revisions: a command from the future is refused', () => {
    assert.throws(
        () => applyPlaybackCommand(playing(), command({ expectedRevision: 11 }), context()),
        (error: unknown) => error instanceof ProtocolError && error.code === 'STALE_REVISION',
    );
});

test('revisions: a command predating a server-initiated change is refused', () => {
    assert.throws(
        () => applyPlaybackCommand(playing(), command({ expectedRevision: 9 }), context({ lastServerInitiatedRevision: 10 })),
        (error: unknown) => error instanceof ProtocolError && error.code === 'STALE_REVISION',
    );
});

test('revisions: an in-flight host command with a slightly old revision still applies', () => {
    // The host sends a second command before the first broadcast arrives; only
    // the host writes playback, so ordering is already guaranteed by the server.
    const result = applyPlaybackCommand(playing({ revision: 12 }), command({ expectedRevision: 10 }), context());
    assert.equal(result.outcome, 'applied');
    assert.equal(result.state.revision, 13);
});

test('media revision: a command for another episode is refused', () => {
    assert.throws(
        () => applyPlaybackCommand(playing(), command({ mediaRevision: 2 }), context()),
        (error: unknown) => error instanceof ProtocolError && error.code === 'STALE_MEDIA_REVISION',
    );
});

test('history: the applied-command ring evicts oldest ids and stays bounded', () => {
    const history = new CommandHistory(3);
    history.add('a');
    history.add('b');
    history.add('a');
    assert.equal(history.size, 2);
    history.add('c');
    history.add('d');
    assert.equal(history.size, 3);
    assert.equal(history.has('a'), false);
    assert.equal(history.has('d'), true);
    history.clear();
    assert.equal(history.size, 0);
});
