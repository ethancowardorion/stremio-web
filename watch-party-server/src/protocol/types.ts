// Copyright (C) 2017-2026 Smart code 203358507

import type { JsonValue } from './validate.ts';

/**
 * Wire types shared by the room service and the Stremio Web client.
 *
 * Every time value is integer milliseconds. Media positions are milliseconds
 * because that is the unit `@stremio/stremio-video` uses end to end (plan
 * section 2.1); server timestamps are epoch milliseconds.
 */

export const PROTOCOL_VERSION = 1;

/** Oldest envelope version this build still accepts. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

export type Envelope<TType extends string = string, TPayload = unknown> = {
    v: number;
    type: TType;
    requestId?: string;
    roomId?: string;
    payload: TPayload;
};

/**
 * What a client's player implementation can actually do.
 *
 * Advertised rather than assumed, because Chromecast, the desktop shell, YouTube
 * and TV implementations do not all support scheduled actions or rate changes
 * (plan section 8.1). A client missing a required capability joins as an
 * observer instead of silently claiming to be synchronized.
 */
export type PlayerCapabilities = {
    scheduledActions: boolean;
    observeBuffering: boolean;
    setPlaybackRate: boolean;
    navigateNext: boolean;
    playerImplementation: string;
};

export const REQUIRED_CAPABILITIES = ['scheduledActions'] as const;

export type MediaDescriptor = {
    /** Stremio metadata type, e.g. `movie` or `series`. */
    type: string | null;
    metaId: string | null;
    videoId: string | null;
    /** Display title, shown on the join screen before the guest loads anything. */
    title: string | null;
    expectedDurationMs: number | null;
    /** Live media has no stable finite timeline and is refused for MVP. */
    live: boolean;
};

export const SOURCE_KINDS = ['torrent', 'youtube', 'url', 'external', 'unknown'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Everything a guest needs to reproduce the host's player route.
 *
 * This deliberately carries raw Stremio material — the encoded stream parameter,
 * add-on transport URLs and optionally an auth key — because exact-source handoff
 * is the default for this self-hosted deployment (plan section 11). The service
 * relays it to authenticated participants and never fetches it.
 */
export type SourceBundle = {
    /** The encoded `stream` route parameter exactly as the host used it. */
    streamParam: string;
    /** Decoded stream object; opaque because add-ons define its shape. */
    stream: JsonValue | null;
    streamTransportUrl: string | null;
    metaTransportUrl: string | null;
    /** Host player path, kept only as a reproduction/debug fallback. */
    playerPath: string | null;
    kind: SourceKind;
    /** Stable identity of the source: `infoHash:fileIdx`, `yt:<id>` or a URL/object hash. */
    fingerprint: string;
    /** Optional host Stremio auth material for source flows that need it. */
    authKey: string | null;
};

/**
 * Canonical, server-owned playback state.
 *
 * `positionMs` is the media position at `effectiveAtServerMs`. For an immediate
 * transition `effectiveAtServerMs === updatedAtServerMs`, which reduces to the
 * formula in plan section 8.4; for a scheduled start the position stays put
 * until the effective time arrives, which is what makes the 500-1000 ms lead
 * time in plan section 9.2 correct rather than a jump.
 */
export type PlaybackState = {
    revision: number;
    mediaRevision: number;
    paused: boolean;
    positionMs: number;
    rate: number;
    updatedAtServerMs: number;
    effectiveAtServerMs: number;
};

export type RoomPolicy = {
    /** Whether guests may publish play and pause commands. */
    allowGuestPlayPause: boolean;
    /** Whether the first start waits for every guest, or only for the host. */
    requireAllReadyToStart: boolean;
    /** Whether sustained buffering by a supported guest freezes the room. */
    pauseOnGuestBuffering: boolean;
    /**
     * Whether the room pauses when the *host* stops making progress.
     *
     * Distinct from guest buffering, and on by default. A host that cannot keep
     * up is not one slow participant among many — it is the reference clock, so
     * the alternative is everyone watching ahead of the person driving. Pausing
     * also states the problem plainly, which is the cue to switch to a source
     * the host can actually stream.
     */
    pauseOnHostStall: boolean;
};

export type ParticipantPublic = {
    participantId: string;
    displayName: string;
    /** Distinguishes two devices on one Stremio account, e.g. `Laptop` vs `TV`. */
    deviceLabel: string | null;
    isHost: boolean;
    connected: boolean;
    ready: boolean;
    loaded: boolean;
    buffering: boolean;
    durationMs: number | null;
    mediaRevision: number;
    sourceFingerprint: string | null;
    capabilities: PlayerCapabilities;
    /** False when a required capability is missing; such a client only observes. */
    supported: boolean;
    joinedAtServerMs: number;
    lastSeenServerMs: number;
};

export type RoomSnapshot = {
    roomId: string;
    hostParticipantId: string;
    createdAtServerMs: number;
    expiresAtServerMs: number;
    revision: number;
    mediaRevision: number;
    media: MediaDescriptor;
    source: SourceBundle;
    playback: PlaybackState;
    participants: ParticipantPublic[];
    policy: RoomPolicy;
    serverTimeMs: number;
};

export const PLAYBACK_ACTIONS = ['play', 'pause', 'seek', 'rate'] as const;

export type PlaybackAction = (typeof PLAYBACK_ACTIONS)[number];

export const ROOM_CLOSE_REASONS = [
    /** Absolute or idle TTL elapsed. */
    'expired',
    /** The host's resume window closed without it coming back. */
    'host_left',
    /** The host explicitly ended the room. */
    'host_ended',
    /** This client left of its own accord; the room may still be running. */
    'left',
    'server_shutdown',
] as const;

export type RoomCloseReason = (typeof ROOM_CLOSE_REASONS)[number];

export const CLIENT_MESSAGE_TYPES = [
    'session.hello',
    'clock.ping',
    'room.create',
    'room.join',
    'room.leave',
    'room.close',
    'room.reset',
    'room.policy.update',
    'participant.ready',
    'playback.command',
    'playback.observation',
    'media.change',
    'source.refresh',
] as const;

export type ClientMessageType = (typeof CLIENT_MESSAGE_TYPES)[number];

export const SERVER_MESSAGE_TYPES = [
    'session.welcome',
    'clock.pong',
    /** Sent only to the creating host; carries the invitation secret once. */
    'room.created',
    'room.snapshot',
    'room.updated',
    'participant.updated',
    'participant.left',
    'playback.state',
    'media.changed',
    'source.updated',
    'room.closed',
    'error',
] as const;

export type ServerMessageType = (typeof SERVER_MESSAGE_TYPES)[number];
