// Copyright (C) 2017-2023 Smart code 203358507

const {
    SOURCE_KIND,
    COMPATIBILITY,
    stableStringify,
    sourceKind,
    sourceFingerprint,
    buildPlayerPath,
    captureSourceBundle,
    guestPlayerPath,
    mediaDescriptor,
    durationToleranceMs,
    isDurationCompatible,
    evaluateSourceCompatibility,
    redactSourceBundle,
} = require('../src/services/WatchParty/mediaIdentity');

const HOST_URL_PARAMS = {
    stream: 'eyJpbmZvSGFzaCI6ImFiYyIsImZpbGVJZHgiOjB9',
    streamTransportUrl: 'https://addon.example/c/config/manifest.json',
    metaTransportUrl: 'https://v3-cinemeta.strem.io/manifest.json',
    type: 'series',
    id: 'tt0903747',
    videoId: 'tt0903747:1:1',
};

describe('watch party source kinds and fingerprints', () => {
    it('classifies every supported stream shape', () => {
        expect(sourceKind({ infoHash: 'abc', fileIdx: 0 })).toBe(SOURCE_KIND.TORRENT);
        expect(sourceKind({ ytId: 'dQw4w9WgXcQ' })).toBe(SOURCE_KIND.YOUTUBE);
        expect(sourceKind({ url: 'https://cdn.example/a.mkv' })).toBe(SOURCE_KIND.URL);
        expect(sourceKind({ externalUrl: 'https://example.com/watch' })).toBe(SOURCE_KIND.EXTERNAL);
        expect(sourceKind({})).toBe(SOURCE_KIND.UNKNOWN);
        expect(sourceKind(null)).toBe(SOURCE_KIND.UNKNOWN);
    });

    it('uses the natural identity for torrents and YouTube', () => {
        expect(sourceFingerprint({ infoHash: 'ABC123', fileIdx: 2 })).toBe('torrent:abc123:2');
        expect(sourceFingerprint({ infoHash: 'abc123' })).toBe('torrent:abc123:x');
        expect(sourceFingerprint({ ytId: 'dQw4w9WgXcQ' })).toBe('yt:dQw4w9WgXcQ');
    });

    it('distinguishes different files inside the same torrent', () => {
        expect(sourceFingerprint({ infoHash: 'abc', fileIdx: 0 })).not.toBe(sourceFingerprint({ infoHash: 'abc', fileIdx: 1 }));
    });

    it('hashes direct urls instead of embedding them', () => {
        const url = 'https://debrid.example/signed?token=super-secret';
        const fingerprint = sourceFingerprint({ url });
        expect(fingerprint).toMatch(/^url:[0-9a-f]{8}$/);
        expect(fingerprint).not.toContain('super-secret');
        expect(sourceFingerprint({ url })).toBe(fingerprint);
        expect(sourceFingerprint({ url: `${url}x` })).not.toBe(fingerprint);
    });

    it('is stable across key ordering for unknown stream shapes', () => {
        expect(sourceFingerprint({ a: 1, b: 2 })).toBe(sourceFingerprint({ b: 2, a: 1 }));
        expect(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
    });
});

describe('watch party player route reconstruction', () => {
    it('rebuilds the full route with encoded segments', () => {
        expect(buildPlayerPath(HOST_URL_PARAMS)).toBe(
            '/player/eyJpbmZvSGFzaCI6ImFiYyIsImZpbGVJZHgiOjB9' +
            '/https%3A%2F%2Faddon.example%2Fc%2Fconfig%2Fmanifest.json' +
            '/https%3A%2F%2Fv3-cinemeta.strem.io%2Fmanifest.json' +
            '/series/tt0903747/tt0903747%3A1%3A1'
        );
    });

    it('omits the optional tail entirely when nothing follows the stream', () => {
        expect(buildPlayerPath({ stream: 'encoded' })).toBe('/player/encoded');
    });

    it('keeps the tail positional, emitting empty segments for gaps', () => {
        // The route is positional, so a missing meta transport url cannot simply
        // be skipped without shifting every later parameter.
        expect(buildPlayerPath({ stream: 'encoded', type: 'movie', id: 'tt1' })).toBe('/player/encoded///movie/tt1');
    });

    it('refuses to build a route without a stream parameter', () => {
        expect(buildPlayerPath({ type: 'movie' })).toBeNull();
        expect(buildPlayerPath({ stream: '' })).toBeNull();
        expect(buildPlayerPath(null)).toBeNull();
    });
});

describe('watch party source bundle capture', () => {
    const stream = { infoHash: 'abc', fileIdx: 0 };

    it('round-trips every raw parameter exactly', () => {
        const bundle = captureSourceBundle({ urlParams: HOST_URL_PARAMS, stream, authKey: 'auth-123' });
        expect(bundle.streamParam).toBe(HOST_URL_PARAMS.stream);
        expect(bundle.streamTransportUrl).toBe(HOST_URL_PARAMS.streamTransportUrl);
        expect(bundle.metaTransportUrl).toBe(HOST_URL_PARAMS.metaTransportUrl);
        expect(bundle.stream).toEqual(stream);
        expect(bundle.kind).toBe(SOURCE_KIND.TORRENT);
        expect(bundle.fingerprint).toBe('torrent:abc:0');
        expect(bundle.authKey).toBe('auth-123');
    });

    it('normalizes absent optional fields to null rather than undefined', () => {
        const bundle = captureSourceBundle({ urlParams: { stream: 'encoded' }, stream });
        expect(bundle.streamTransportUrl).toBeNull();
        expect(bundle.metaTransportUrl).toBeNull();
        expect(bundle.authKey).toBeNull();
        expect(JSON.parse(JSON.stringify(bundle)).authKey).toBeNull();
    });

    it('rebuilds the guest route from raw parameters, not from the host path', () => {
        const bundle = captureSourceBundle({ urlParams: HOST_URL_PARAMS, stream });
        const media = { type: 'series', metaId: 'tt0903747', videoId: 'tt0903747:1:1' };
        expect(guestPlayerPath(bundle, media)).toBe(bundle.playerPath);
    });

    it('carries no host-resolved runtime url, so the guest resolves locally', () => {
        // The bundle must describe the add-on stream, never the host's own
        // 127.0.0.1 streaming-server address.
        const bundle = captureSourceBundle({ urlParams: HOST_URL_PARAMS, stream });
        const serialized = JSON.stringify(bundle);
        expect(serialized).not.toContain('127.0.0.1');
        expect(serialized).not.toContain('11470');
    });

    it('falls back to the recorded host path when parameters cannot rebuild a route', () => {
        expect(guestPlayerPath({ streamParam: '', playerPath: '/player/fallback' }, null)).toBe('/player/fallback');
        expect(guestPlayerPath(null, null)).toBeNull();
    });
});

describe('watch party media descriptors', () => {
    it('normalizes a descriptor from player state', () => {
        expect(mediaDescriptor({
            type: 'series',
            metaId: 'tt0903747',
            videoId: 'tt0903747:1:1',
            title: 'Pilot',
            durationMs: 3_480_400.7,
            live: false,
        })).toEqual({
            type: 'series',
            metaId: 'tt0903747',
            videoId: 'tt0903747:1:1',
            title: 'Pilot',
            expectedDurationMs: 3_480_401,
            live: false,
        });
    });

    it('coerces missing, empty and non-finite values', () => {
        expect(mediaDescriptor({ type: '', durationMs: 0 })).toEqual({
            type: null,
            metaId: null,
            videoId: null,
            title: null,
            expectedDurationMs: null,
            live: false,
        });
        expect(mediaDescriptor(null).expectedDurationMs).toBeNull();
        expect(mediaDescriptor({ durationMs: Number.POSITIVE_INFINITY }).expectedDurationMs).toBeNull();
        expect(mediaDescriptor({ live: true }).live).toBe(true);
    });
});

describe('watch party duration compatibility', () => {
    it('uses the larger of two seconds and half a percent', () => {
        expect(durationToleranceMs(60_000)).toBe(2000);
        expect(durationToleranceMs(3_480_000)).toBe(17_400);
    });

    it('accepts differences inside the tolerance and rejects those outside it', () => {
        expect(isDurationCompatible(60_000, 61_999)).toBe(true);
        expect(isDurationCompatible(60_000, 62_001)).toBe(false);
        expect(isDurationCompatible(3_480_000, 3_490_000)).toBe(true);
        expect(isDurationCompatible(3_480_000, 3_500_000)).toBe(false);
    });

    it('treats an unknown duration as inconclusive rather than incompatible', () => {
        expect(isDurationCompatible(null, 60_000)).toBe(true);
        expect(isDurationCompatible(60_000, null)).toBe(true);
        expect(isDurationCompatible(0, 60_000)).toBe(true);
    });

    it('classifies the reason a guest source does not match', () => {
        expect(evaluateSourceCompatibility({
            expectedFingerprint: 'torrent:abc:0',
            actualFingerprint: 'torrent:abc:0',
            expectedDurationMs: 3_480_000,
            actualDurationMs: 3_481_000,
        })).toEqual({ status: COMPATIBILITY.OK, compatible: true });

        expect(evaluateSourceCompatibility({
            expectedFingerprint: 'torrent:abc:0',
            actualFingerprint: 'torrent:def:1',
        }).status).toBe(COMPATIBILITY.FINGERPRINT_MISMATCH);

        expect(evaluateSourceCompatibility({
            expectedFingerprint: 'torrent:abc:0',
            actualFingerprint: 'torrent:abc:0',
            expectedDurationMs: 3_480_000,
            actualDurationMs: 3_600_000,
        }).status).toBe(COMPATIBILITY.DURATION_MISMATCH);

        expect(evaluateSourceCompatibility({ expectedFingerprint: 'torrent:abc:0' })).toEqual({
            status: COMPATIBILITY.UNKNOWN,
            compatible: false,
        });
    });
});

describe('watch party redaction', () => {
    it('keeps credentials and locators out of anything observability could copy', () => {
        const bundle = captureSourceBundle({
            urlParams: {
                ...HOST_URL_PARAMS,
                streamTransportUrl: 'https://addon.example/SECRET-CONFIG/manifest.json',
            },
            stream: { url: 'https://debrid.example/signed?token=super-secret' },
            authKey: 'auth-super-secret',
        });
        const redacted = redactSourceBundle(bundle);
        const serialized = JSON.stringify(redacted);

        expect(serialized).not.toContain('auth-super-secret');
        expect(serialized).not.toContain('SECRET-CONFIG');
        expect(serialized).not.toContain('super-secret');
        expect(serialized).not.toContain(HOST_URL_PARAMS.stream);

        expect(redacted.kind).toBe(SOURCE_KIND.URL);
        expect(redacted.hasAuthKey).toBe(true);
        expect(redacted.hasStreamTransportUrl).toBe(true);
        expect(redacted.streamParamLength).toBe(HOST_URL_PARAMS.stream.length);
    });

    it('tolerates a missing bundle', () => {
        expect(redactSourceBundle(null)).toBeNull();
        expect(redactSourceBundle('nope')).toBeNull();
    });
});
