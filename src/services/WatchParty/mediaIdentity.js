// Copyright (C) 2017-2026 Smart code 203358507

// Media identity and exact-source handoff.
//
// The host captures the complete raw Stremio source context needed to reproduce
// its player route; the guest reconstructs that route locally so its own Stremio
// streaming server resolves the stream. A host-resolved runtime URL (a
// 127.0.0.1 address, a signed URL bound to the host's IP) is never reused as-is.

// Non-cryptographic 32-bit FNV-1a. Fingerprints are identity, not security: the
// invitation secret is what authorizes a join. A short stable hash keeps the
// fingerprint printable and cheap to compare.
const fnv1a = (input) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
};

// Key-sorted serialization, so two structurally identical stream objects always
// hash the same regardless of property order.
const stableStringify = (value) => {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value === undefined ? null : value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const SOURCE_KIND = {
    TORRENT: 'torrent',
    YOUTUBE: 'youtube',
    URL: 'url',
    EXTERNAL: 'external',
    UNKNOWN: 'unknown',
};

const sourceKind = (stream) => {
    if (!stream || typeof stream !== 'object') {
        return SOURCE_KIND.UNKNOWN;
    }
    if (typeof stream.infoHash === 'string' && stream.infoHash.length > 0) {
        return SOURCE_KIND.TORRENT;
    }
    if (typeof stream.ytId === 'string' && stream.ytId.length > 0) {
        return SOURCE_KIND.YOUTUBE;
    }
    if (typeof stream.url === 'string' && stream.url.length > 0) {
        return SOURCE_KIND.URL;
    }
    if (typeof stream.externalUrl === 'string' && stream.externalUrl.length > 0) {
        return SOURCE_KIND.EXTERNAL;
    }
    return SOURCE_KIND.UNKNOWN;
};

// A stable identity for "the same file", used to detect a guest that loaded
// something else. Torrents and YouTube have natural identities; anything else
// falls back to a hash so the value can never leak a URL by itself.
const sourceFingerprint = (stream) => {
    const kind = sourceKind(stream);
    switch (kind) {
        case SOURCE_KIND.TORRENT: {
            const fileIdx = typeof stream.fileIdx === 'number' ? stream.fileIdx : 'x';
            return `torrent:${stream.infoHash.toLowerCase()}:${fileIdx}`;
        }
        case SOURCE_KIND.YOUTUBE:
            return `yt:${stream.ytId}`;
        case SOURCE_KIND.URL:
            return `url:${fnv1a(stream.url)}`;
        case SOURCE_KIND.EXTERNAL:
            return `external:${fnv1a(stream.externalUrl)}`;
        default:
            return `unknown:${fnv1a(stableStringify(stream || null))}`;
    }
};

// Rebuilds the Stremio player route from raw parameters.
//
// The route's optional tail is positional, so a gap cannot be skipped: if any
// later parameter is present, the earlier ones must be emitted too.
const buildPlayerPath = (params) => {
    if (!params || typeof params.stream !== 'string' || params.stream.length === 0) {
        return null;
    }
    const tail = [params.streamTransportUrl, params.metaTransportUrl, params.type, params.id, params.videoId];
    let lastPresent = -1;
    for (let index = 0; index < tail.length; index++) {
        if (typeof tail[index] === 'string' && tail[index].length > 0) {
            lastPresent = index;
        }
    }
    const segments = [encodeURIComponent(params.stream)];
    for (let index = 0; index <= lastPresent; index++) {
        const value = tail[index];
        segments.push(encodeURIComponent(typeof value === 'string' ? value : ''));
    }
    return `/player/${segments.join('/')}`;
};

// Captures everything the guest needs. `stream` is the decoded descriptor and is
// carried for fingerprinting and diagnostics; the guest reconstructs playback
// from `streamParam` and the transport URLs, which is what makes its own local
// streaming server do the resolving.
const captureSourceBundle = (input) => {
    const urlParams = (input && input.urlParams) || {};
    const stream = (input && input.stream) || null;
    const params = {
        stream: urlParams.stream,
        streamTransportUrl: urlParams.streamTransportUrl,
        metaTransportUrl: urlParams.metaTransportUrl,
        type: urlParams.type,
        id: urlParams.id,
        videoId: urlParams.videoId,
    };
    const asStringOrNull = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

    return {
        streamParam: typeof params.stream === 'string' ? params.stream : '',
        stream,
        streamTransportUrl: asStringOrNull(params.streamTransportUrl),
        metaTransportUrl: asStringOrNull(params.metaTransportUrl),
        playerPath: buildPlayerPath(params),
        kind: sourceKind(stream),
        fingerprint: sourceFingerprint(stream),
        authKey: asStringOrNull(input && input.authKey),
    };
};

// The route a guest should navigate to. Built from the bundle's raw parameters
// rather than from the host's `playerPath`, which is only a debug fallback.
const guestPlayerPath = (bundle, media) => {
    if (!bundle) {
        return null;
    }
    const path = buildPlayerPath({
        stream: bundle.streamParam,
        streamTransportUrl: bundle.streamTransportUrl,
        metaTransportUrl: bundle.metaTransportUrl,
        type: media && media.type,
        id: media && media.metaId,
        videoId: media && media.videoId,
    });
    return path === null ? bundle.playerPath || null : path;
};

const mediaDescriptor = (input) => {
    const asStringOrNull = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
    return {
        type: asStringOrNull(input && input.type),
        metaId: asStringOrNull(input && input.metaId),
        videoId: asStringOrNull(input && input.videoId),
        title: asStringOrNull(input && input.title),
        expectedDurationMs:
            typeof (input && input.durationMs) === 'number' && isFinite(input.durationMs) && input.durationMs > 0
                ? Math.round(input.durationMs)
                : null,
        live: (input && input.live) === true,
    };
};

// Different cuts of the same title share metadata ids but not timelines, so the
// loaded duration is compared as well. Tolerance is the larger of two seconds
// and half a percent (plan section 11.3).
const DURATION_TOLERANCE_MS = 2000;
const DURATION_TOLERANCE_RATIO = 0.005;

const durationToleranceMs = (durationMs) =>
    Math.max(DURATION_TOLERANCE_MS, Math.abs(durationMs) * DURATION_TOLERANCE_RATIO);

const isDurationCompatible = (expectedMs, actualMs) => {
    if (typeof expectedMs !== 'number' || typeof actualMs !== 'number' || !isFinite(expectedMs) || !isFinite(actualMs)) {
        // An unknown duration is not evidence of a mismatch; the fingerprint
        // check still applies.
        return true;
    }
    if (expectedMs <= 0 || actualMs <= 0) {
        return true;
    }
    return Math.abs(expectedMs - actualMs) <= durationToleranceMs(expectedMs);
};

const COMPATIBILITY = {
    OK: 'ok',
    UNKNOWN: 'unknown',
    FINGERPRINT_MISMATCH: 'fingerprint-mismatch',
    DURATION_MISMATCH: 'duration-mismatch',
};

// Whether what the guest actually loaded matches what the room is watching.
const evaluateSourceCompatibility = (input) => {
    const expectedFingerprint = input && input.expectedFingerprint;
    const actualFingerprint = input && input.actualFingerprint;
    if (typeof expectedFingerprint !== 'string' || typeof actualFingerprint !== 'string') {
        return { status: COMPATIBILITY.UNKNOWN, compatible: false };
    }
    if (expectedFingerprint !== actualFingerprint) {
        return { status: COMPATIBILITY.FINGERPRINT_MISMATCH, compatible: false };
    }
    if (!isDurationCompatible(input.expectedDurationMs, input.actualDurationMs)) {
        return { status: COMPATIBILITY.DURATION_MISMATCH, compatible: false };
    }
    return { status: COMPATIBILITY.OK, compatible: true };
};

// A bundle safe to put in a log line, a breadcrumb or an analytics event. The
// service is allowed to process auth keys and stream URLs; observability is not.
const redactSourceBundle = (bundle) => {
    if (!bundle || typeof bundle !== 'object') {
        return null;
    }
    return {
        kind: bundle.kind,
        fingerprint: bundle.fingerprint,
        hasStreamTransportUrl: typeof bundle.streamTransportUrl === 'string',
        hasMetaTransportUrl: typeof bundle.metaTransportUrl === 'string',
        hasAuthKey: typeof bundle.authKey === 'string',
        streamParamLength: typeof bundle.streamParam === 'string' ? bundle.streamParam.length : 0,
    };
};

module.exports = {
    SOURCE_KIND,
    COMPATIBILITY,
    DURATION_TOLERANCE_MS,
    DURATION_TOLERANCE_RATIO,
    fnv1a,
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
};
