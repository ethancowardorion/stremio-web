// Copyright (C) 2017-2026 Smart code 203358507

import { ProtocolError } from '../protocol/errors.ts';
import type { PlaybackAction, PlaybackState } from '../protocol/types.ts';
import { clampPositionMs, positionAtServerMs } from './canonicalPlayback.ts';

/**
 * Host command application.
 *
 * Correctness rests on command ids and revisions, never on timing (plan section
 * 9.4). A replayed command after a reconnect is a no-op; a command computed
 * against state the server has since changed on its own is rejected.
 */

export type PlaybackCommand = {
    commandId: string;
    action: PlaybackAction;
    expectedRevision: number;
    mediaRevision: number;
    positionMs?: number | undefined;
    rate?: number | undefined;
    leadMs?: number | undefined;
};

export type ApplyCommandContext = {
    nowMs: number;
    durationMs: number | null;
    /** Default scheduled lead time for transitions that start playback. */
    defaultLeadMs: number;
    /**
     * The revision at which the server last changed playback state by itself
     * (host-grace pause, media reset). A host command carrying an
     * `expectedRevision` older than this was computed against state the host
     * could not have known about, so it is refused rather than applied blindly.
     */
    lastServerInitiatedRevision: number;
    /** Command ids already applied, for idempotent reconnect/retry. */
    appliedCommandIds: ReadonlySet<string>;
};

export type ApplyCommandResult =
    | { outcome: 'applied'; state: PlaybackState }
    | { outcome: 'duplicate'; state: PlaybackState };

const requirePosition = (command: PlaybackCommand): number => {
    if (command.positionMs === undefined) {
        throw new ProtocolError('VALIDATION_FAILED', `${command.action} requires positionMs`, {
            details: { path: 'payload.positionMs' },
        });
    }
    return command.positionMs;
};

const requireRate = (command: PlaybackCommand): number => {
    if (command.rate === undefined) {
        throw new ProtocolError('VALIDATION_FAILED', 'rate command requires rate', {
            details: { path: 'payload.rate' },
        });
    }
    return command.rate;
};

export const applyPlaybackCommand = (
    state: PlaybackState,
    command: PlaybackCommand,
    context: ApplyCommandContext,
): ApplyCommandResult => {
    if (context.appliedCommandIds.has(command.commandId)) {
        return { outcome: 'duplicate', state };
    }

    if (command.mediaRevision !== state.mediaRevision) {
        throw new ProtocolError('STALE_MEDIA_REVISION', 'command targets a different media revision', {
            details: { expected: state.mediaRevision, received: command.mediaRevision },
        });
    }

    // A client can never legitimately be ahead of the server, and a client that
    // predates a server-initiated change must resynchronize first.
    if (command.expectedRevision > state.revision || command.expectedRevision < context.lastServerInitiatedRevision) {
        throw new ProtocolError('STALE_REVISION', 'command was computed against stale room state', {
            details: { currentRevision: state.revision, expectedRevision: command.expectedRevision },
        });
    }

    const { nowMs, durationMs } = context;
    const leadMs = command.leadMs ?? context.defaultLeadMs;
    const base = {
        revision: state.revision + 1,
        mediaRevision: state.mediaRevision,
        updatedAtServerMs: nowMs,
    };

    switch (command.action) {
        case 'play': {
            // Scheduling the start slightly ahead lets every ready client begin
            // at the same server instant instead of on message arrival.
            const effectiveAtServerMs = nowMs + leadMs;
            const startPositionMs = command.positionMs ?? positionAtServerMs(state, effectiveAtServerMs, durationMs);
            return {
                outcome: 'applied',
                state: {
                    ...base,
                    paused: false,
                    positionMs: clampPositionMs(startPositionMs, durationMs),
                    rate: state.rate,
                    effectiveAtServerMs,
                },
            };
        }
        case 'pause': {
            // Pausing takes effect immediately: there is nothing to align to.
            const pausedPositionMs = command.positionMs ?? positionAtServerMs(state, nowMs, durationMs);
            return {
                outcome: 'applied',
                state: {
                    ...base,
                    paused: true,
                    positionMs: clampPositionMs(pausedPositionMs, durationMs),
                    rate: state.rate,
                    effectiveAtServerMs: nowMs,
                },
            };
        }
        case 'seek': {
            const targetPositionMs = clampPositionMs(requirePosition(command), durationMs);
            // A seek while playing gets the same lead as a play so that clients
            // have time to buffer at the new position before it becomes live.
            const effectiveAtServerMs = state.paused ? nowMs : nowMs + leadMs;
            return {
                outcome: 'applied',
                state: {
                    ...base,
                    paused: state.paused,
                    positionMs: targetPositionMs,
                    rate: state.rate,
                    effectiveAtServerMs,
                },
            };
        }
        case 'rate': {
            const nextRate = requireRate(command);
            // Rebase the position first, otherwise the elapsed time since the
            // last update would be replayed at the new rate.
            return {
                outcome: 'applied',
                state: {
                    ...base,
                    paused: state.paused,
                    positionMs: positionAtServerMs(state, nowMs, durationMs),
                    rate: nextRate,
                    effectiveAtServerMs: nowMs,
                },
            };
        }
        default: {
            const exhaustive: never = command.action;
            throw new ProtocolError('VALIDATION_FAILED', `unsupported action ${String(exhaustive)}`);
        }
    }
};

/**
 * Bounded set of applied command ids.
 *
 * Idempotency only needs to survive a reconnect window, so the history is a ring
 * rather than an unbounded set — an unbounded one would be a memory leak for a
 * long session.
 */
export class CommandHistory {
    private readonly capacity: number;
    private readonly order: string[] = [];
    private readonly ids = new Set<string>();

    constructor(capacity: number) {
        this.capacity = Math.max(1, capacity);
    }

    has(commandId: string): boolean {
        return this.ids.has(commandId);
    }

    add(commandId: string): void {
        if (this.ids.has(commandId)) {
            return;
        }
        this.ids.add(commandId);
        this.order.push(commandId);
        while (this.order.length > this.capacity) {
            const evicted = this.order.shift();
            if (evicted !== undefined) {
                this.ids.delete(evicted);
            }
        }
    }

    get size(): number {
        return this.ids.size;
    }

    asSet(): ReadonlySet<string> {
        return this.ids;
    }

    clear(): void {
        this.order.length = 0;
        this.ids.clear();
    }
}
