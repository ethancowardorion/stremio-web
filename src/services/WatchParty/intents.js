// Copyright (C) 2017-2026 Smart code 203358507

// Local playback intent routing.
//
// Kept pure and separate from the React adapter so the authority rules can be
// tested exactly, and so the two directions of the bridge stay distinct: an
// intent produces a *command description*, never a direct player mutation
// (plan section 9.4).

const { PLAYBACK_ACTION } = require('./protocol');

const TIMELINE_ACTIONS = ['play', 'pause', 'seek', 'rate'];

const OUTCOME = {
    // Not in a party: the player applies the change itself, as it always has.
    APPLY_LOCALLY: 'apply-locally',
    // Host: publish a command and wait for canonical state, so the host starts
    // at the same scheduled instant as everyone else rather than a lead early.
    PUBLISH: 'publish',
    // Guest: the timeline is not theirs to change.
    BLOCKED: 'blocked',
};

// Decides what should happen to a local timeline intent.
//
// `handled` is what the player checks: when true it must not apply the change
// itself, either because a command was published or because the intent was
// refused.
const routeTimelineIntent = (input) => {
    const {
        inRoom,
        isHost,
        allowGuestPlayPause,
        allowGuestSeek,
        allowGuestPlaybackRate,
        action,
        options,
        videoState,
    } = input;

    if (!TIMELINE_ACTIONS.includes(action)) {
        return { outcome: OUTCOME.APPLY_LOCALLY, handled: false, command: null };
    }
    if (!inRoom) {
        return { outcome: OUTCOME.APPLY_LOCALLY, handled: false, command: null };
    }
    const guestActionAllowed =
        (allowGuestPlayPause === true && (action === 'play' || action === 'pause')) ||
        (allowGuestSeek === true && action === 'seek') ||
        (allowGuestPlaybackRate === true && action === 'rate');
    if (!isHost && !guestActionAllowed) {
        return { outcome: OUTCOME.BLOCKED, handled: true, command: null };
    }

    const state = videoState || {};
    switch (action) {
        case 'play':
            return {
                outcome: OUTCOME.PUBLISH,
                handled: true,
                command: { action: PLAYBACK_ACTION.PLAY, options: {} },
            };
        case 'pause':
            return {
                outcome: OUTCOME.PUBLISH,
                handled: true,
                // The host's measured position is more accurate than anything the
                // service could infer, so it travels with the command.
                command: {
                    action: PLAYBACK_ACTION.PAUSE,
                    options: typeof state.time === 'number' ? { positionMs: state.time } : {},
                },
            };
        case 'seek': {
            const positionMs =
                options !== undefined && options !== null && typeof options.positionMs === 'number'
                    ? options.positionMs
                    : state.time;
            if (typeof positionMs !== 'number') {
                // Nothing to seek to; refuse rather than publish a malformed
                // command the service would reject anyway.
                return { outcome: OUTCOME.BLOCKED, handled: true, command: null };
            }
            return {
                outcome: OUTCOME.PUBLISH,
                handled: true,
                command: { action: PLAYBACK_ACTION.SEEK, options: { positionMs } },
            };
        }
        case 'rate': {
            const rate = options !== undefined && options !== null && typeof options.rate === 'number' ? options.rate : null;
            if (rate === null) {
                return { outcome: OUTCOME.BLOCKED, handled: true, command: null };
            }
            return {
                outcome: OUTCOME.PUBLISH,
                handled: true,
                command: { action: PLAYBACK_ACTION.RATE, options: { rate } },
            };
        }
        default:
            return { outcome: OUTCOME.APPLY_LOCALLY, handled: false, command: null };
    }
};

// Whether this client may report itself ready for the current media revision.
// Every condition is a reason a client could be present but not synchronized.
const computeReadiness = (input) => {
    const reasons = [];
    if (!input.inRoom) {
        reasons.push('not-in-room');
    }
    if (!input.supported) {
        reasons.push('unsupported-player');
    }
    // Loading/alignment can be established without playing, so a paused guest
    // can announce readiness automatically. A gesture is required only after
    // the browser has actually rejected a play request.
    if (input.activationRequired) {
        reasons.push('activation-required');
    }
    if (!input.loaded) {
        reasons.push('not-loaded');
    }
    // Buffering is deliberately not a readiness precondition.
    //
    // It is a display signal, not a barrier. The readyState it derives from is
    // unreliable — Chrome reports both a paused element and, for some sources, a
    // normally playing one as below HAVE_FUTURE_DATA — so gating on it would
    // leave a healthy client permanently unready and deadlock the room, since
    // the host must be ready before playback can start. Room policy is explicit
    // that one slow participant must not lock the room; a client that really has
    // fallen behind is caught by `aligned` instead, and catches up through drift
    // correction.
    if (!input.sourceCompatible) {
        reasons.push('source-incompatible');
    }
    if (!input.aligned) {
        reasons.push('not-aligned');
    }
    return { ready: reasons.length === 0, reasons };
};

module.exports = {
    OUTCOME,
    TIMELINE_ACTIONS,
    routeTimelineIntent,
    computeReadiness,
};
