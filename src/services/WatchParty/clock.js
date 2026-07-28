// Copyright (C) 2017-2026 Smart code 203358507

// Server clock estimation.
//
// Offsets are measured against a monotonic local clock (performance.now) rather
// than wall time, so a system clock correction mid-film cannot make playback jump.
// The estimator keeps a small window of samples and trusts the one with the lowest
// round trip, because that sample has the least room for asymmetric queuing delay.

const DEFAULT_SAMPLE_SIZE = 5;

// Beyond this the estimate is treated as unusable and the caller should prefer
// hard alignment over scheduling.
const MAX_USABLE_UNCERTAINTY_MS = 750;

const createClock = (options) => {
    const sampleSize = (options && options.sampleSize) || DEFAULT_SAMPLE_SIZE;
    const monotonicNow = (options && options.monotonicNow) || (() => Date.now());

    let samples = [];
    let best = null;

    // One sample yields both a round trip and an offset. The offset is the usual
    // NTP estimator: it assumes the outbound and inbound legs are symmetric, which
    // is why the lowest-RTT sample is the one worth keeping.
    const addSample = (sample) => {
        const { clientSentMonotonicMs, clientRecvMonotonicMs, serverRecvMs, serverSendMs } = sample;
        if (
            typeof clientSentMonotonicMs !== 'number' ||
            typeof clientRecvMonotonicMs !== 'number' ||
            typeof serverRecvMs !== 'number' ||
            typeof serverSendMs !== 'number'
        ) {
            return null;
        }

        const roundTripMs = (clientRecvMonotonicMs - clientSentMonotonicMs) - (serverSendMs - serverRecvMs);
        if (!Number.isFinite(roundTripMs) || roundTripMs < 0) {
            return null;
        }

        const offsetMs =
            ((serverRecvMs - clientSentMonotonicMs) + (serverSendMs - clientRecvMonotonicMs)) / 2;
        const entry = { roundTripMs, offsetMs, uncertaintyMs: roundTripMs / 2 };

        samples.push(entry);
        if (samples.length > sampleSize) {
            samples = samples.slice(samples.length - sampleSize);
        }

        best = samples.reduce(
            (lowest, candidate) => (lowest === null || candidate.roundTripMs < lowest.roundTripMs ? candidate : lowest),
            null
        );
        return entry;
    };

    // Local monotonic time -> server epoch time.
    const toServerTime = (localMonotonicMs) => {
        if (best === null) {
            return null;
        }
        return localMonotonicMs + best.offsetMs;
    };

    // Server epoch time -> local monotonic time, used to schedule a transition.
    const toLocalTime = (serverMs) => {
        if (best === null) {
            return null;
        }
        return serverMs - best.offsetMs;
    };

    const serverNow = () => toServerTime(monotonicNow());

    return {
        addSample,
        toServerTime,
        toLocalTime,
        serverNow,
        get offsetMs() {
            return best === null ? null : best.offsetMs;
        },
        get uncertaintyMs() {
            return best === null ? null : best.uncertaintyMs;
        },
        get roundTripMs() {
            return best === null ? null : best.roundTripMs;
        },
        get sampleCount() {
            return samples.length;
        },
        get hasEstimate() {
            return best !== null;
        },
        // A high-uncertainty estimate is still usable for display, but callers
        // should widen scheduling lead time or fall back to hard alignment.
        get isConfident() {
            return best !== null && best.uncertaintyMs <= MAX_USABLE_UNCERTAINTY_MS;
        },
        reset() {
            samples = [];
            best = null;
        },
    };
};

module.exports = {
    createClock,
    DEFAULT_SAMPLE_SIZE,
    MAX_USABLE_UNCERTAINTY_MS,
};
