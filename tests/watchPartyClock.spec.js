// Copyright (C) 2017-2023 Smart code 203358507

const { createClock, MAX_USABLE_UNCERTAINTY_MS } = require('../src/services/WatchParty/clock');

// A round trip where the local monotonic clock starts at `sentAt`, the server sits
// `offsetMs` ahead of it, and the two legs take `outboundMs` and `inboundMs`.
const sample = ({ sentAt, offsetMs, outboundMs, inboundMs, serverProcessingMs = 0 }) => {
    const serverRecvMs = sentAt + offsetMs + outboundMs;
    const serverSendMs = serverRecvMs + serverProcessingMs;
    return {
        clientSentMonotonicMs: sentAt,
        serverRecvMs,
        serverSendMs,
        clientRecvMonotonicMs: sentAt + outboundMs + serverProcessingMs + inboundMs,
    };
};

describe('watch party clock estimation', () => {
    it('has no estimate before any sample arrives', () => {
        const clock = createClock();
        expect(clock.hasEstimate).toBe(false);
        expect(clock.offsetMs).toBeNull();
        expect(clock.toServerTime(1000)).toBeNull();
        expect(clock.toLocalTime(1000)).toBeNull();
    });

    it('recovers the exact offset from a symmetric round trip', () => {
        const clock = createClock();
        clock.addSample(sample({ sentAt: 1000, offsetMs: 500_000, outboundMs: 20, inboundMs: 20 }));
        expect(clock.offsetMs).toBe(500_000);
        expect(clock.roundTripMs).toBe(40);
        expect(clock.uncertaintyMs).toBe(20);
        expect(clock.toServerTime(2000)).toBe(502_000);
        expect(clock.toLocalTime(502_000)).toBe(2000);
    });

    it('excludes server processing time from the round trip and the offset', () => {
        // A slow server must not look like a slow network, and must not skew the
        // offset: both server timestamps are used precisely so it cancels out.
        const clock = createClock();
        clock.addSample(sample({ sentAt: 0, offsetMs: 1000, outboundMs: 15, inboundMs: 15, serverProcessingMs: 100 }));
        expect(clock.roundTripMs).toBe(30);
        expect(clock.offsetMs).toBe(1000);
    });

    it('keeps the lowest round trip regardless of arrival order', () => {
        const clock = createClock();
        clock.addSample(sample({ sentAt: 0, offsetMs: 1000, outboundMs: 200, inboundMs: 200 }));
        clock.addSample(sample({ sentAt: 1000, offsetMs: 1000, outboundMs: 10, inboundMs: 10 }));
        clock.addSample(sample({ sentAt: 2000, offsetMs: 1000, outboundMs: 300, inboundMs: 300 }));
        expect(clock.roundTripMs).toBe(20);
        expect(clock.offsetMs).toBe(1000);
    });

    it('is skewed by asymmetric latency, and reports the resulting uncertainty', () => {
        // 200 ms out, 20 ms back: the estimator cannot see the asymmetry, so it
        // splits the difference. What matters is that the reported uncertainty is
        // large enough for callers to widen their scheduling lead.
        const clock = createClock();
        clock.addSample(sample({ sentAt: 0, offsetMs: 0, outboundMs: 200, inboundMs: 20 }));
        expect(clock.offsetMs).toBe(90);
        expect(clock.uncertaintyMs).toBe(110);
        expect(Math.abs(clock.offsetMs)).toBeLessThanOrEqual(clock.uncertaintyMs);
    });

    it('flags a high-latency estimate as not confident', () => {
        const clock = createClock();
        clock.addSample(sample({ sentAt: 0, offsetMs: 0, outboundMs: 10, inboundMs: 10 }));
        expect(clock.isConfident).toBe(true);

        const slow = createClock();
        slow.addSample(sample({ sentAt: 0, offsetMs: 0, outboundMs: 2000, inboundMs: 2000 }));
        expect(slow.uncertaintyMs).toBeGreaterThan(MAX_USABLE_UNCERTAINTY_MS);
        expect(slow.isConfident).toBe(false);
    });

    it('drops samples beyond the window so a stale best cannot persist forever', () => {
        const clock = createClock({ sampleSize: 2 });
        clock.addSample(sample({ sentAt: 0, offsetMs: 1000, outboundMs: 5, inboundMs: 5 }));
        clock.addSample(sample({ sentAt: 1000, offsetMs: 2000, outboundMs: 50, inboundMs: 50 }));
        clock.addSample(sample({ sentAt: 2000, offsetMs: 2000, outboundMs: 60, inboundMs: 60 }));
        expect(clock.sampleCount).toBe(2);
        // The 10 ms sample has aged out; the best of the remaining window wins.
        expect(clock.offsetMs).toBe(2000);
        expect(clock.roundTripMs).toBe(100);
    });

    it('ignores malformed and physically impossible samples', () => {
        const clock = createClock();
        expect(clock.addSample({})).toBeNull();
        expect(clock.addSample({ clientSentMonotonicMs: 'x', clientRecvMonotonicMs: 1, serverRecvMs: 1, serverSendMs: 1 })).toBeNull();
        // Server claims to have spent longer processing than the whole round trip.
        expect(clock.addSample({ clientSentMonotonicMs: 0, clientRecvMonotonicMs: 10, serverRecvMs: 0, serverSendMs: 100 })).toBeNull();
        expect(clock.hasEstimate).toBe(false);
    });

    it('uses the injected monotonic clock for serverNow', () => {
        let monotonic = 5000;
        const clock = createClock({ monotonicNow: () => monotonic });
        clock.addSample(sample({ sentAt: 0, offsetMs: 1_000_000, outboundMs: 5, inboundMs: 5 }));
        expect(clock.serverNow()).toBe(1_005_000);
        monotonic = 6000;
        expect(clock.serverNow()).toBe(1_006_000);
    });

    it('is unaffected by a wall-clock jump, because it never reads wall time', () => {
        let monotonic = 1000;
        const clock = createClock({ monotonicNow: () => monotonic });
        clock.addSample(sample({ sentAt: 1000, offsetMs: 700_000, outboundMs: 10, inboundMs: 10 }));
        const before = clock.serverNow();

        const realDateNow = Date.now;
        Date.now = () => realDateNow() + 3_600_000;
        try {
            monotonic += 1000;
            expect(clock.serverNow()).toBe(before + 1000);
        } finally {
            Date.now = realDateNow;
        }
    });

    it('forgets everything on reset, as required after a reconnect', () => {
        const clock = createClock();
        clock.addSample(sample({ sentAt: 0, offsetMs: 1000, outboundMs: 5, inboundMs: 5 }));
        clock.reset();
        expect(clock.hasEstimate).toBe(false);
        expect(clock.sampleCount).toBe(0);
    });
});
