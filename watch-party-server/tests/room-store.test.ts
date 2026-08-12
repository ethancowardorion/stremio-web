// Copyright (C) 2017-2026 Smart code 203358507

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolError } from '../src/protocol/errors.ts';
import type { MediaDescriptor, PlayerCapabilities, RoomPolicy, SourceBundle } from '../src/protocol/types.ts';
import { Room, type CreateRoomInput, type RoomOptions } from '../src/rooms/Room.ts';
import { RoomStore } from '../src/rooms/RoomStore.ts';
import { secretsMatch } from '../src/rooms/ids.ts';
import { SessionStore } from '../src/sessions/SessionStore.ts';
import { hashResumeToken, resumeTokenMatches } from '../src/sessions/ResumeToken.ts';

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DURATION_MS = 3_480_000;

const capabilities = (overrides: Partial<PlayerCapabilities> = {}): PlayerCapabilities => ({
    scheduledActions: true,
    observeBuffering: true,
    setPlaybackRate: true,
    navigateNext: true,
    playerImplementation: 'HTMLVideo',
    ...overrides,
});

const media = (overrides: Partial<MediaDescriptor> = {}): MediaDescriptor => ({
    type: 'movie',
    metaId: 'tt0111161',
    videoId: null,
    title: 'A Film',
    expectedDurationMs: DURATION_MS,
    live: false,
    ...overrides,
});

const source = (overrides: Partial<SourceBundle> = {}): SourceBundle => ({
    streamParam: 'encoded',
    stream: { infoHash: 'abc', fileIdx: 0 },
    streamTransportUrl: 'https://addon.example/manifest.json',
    metaTransportUrl: null,
    playerPath: '/player/encoded',
    kind: 'torrent',
    fingerprint: 'torrent:abc:0',
    authKey: null,
    ...overrides,
});

const roomInput = (overrides: Partial<CreateRoomInput> = {}): CreateRoomInput => ({
    host: { displayName: 'Host', deviceLabel: 'Laptop', capabilities: capabilities() },
    media: media(),
    source: source(),
    observation: { positionMs: 0, rate: 1, durationMs: DURATION_MS },
    policy: undefined,
    ...overrides,
});

const roomOptions = (overrides: Partial<RoomOptions> = {}): RoomOptions => ({
    nowMs: T0,
    ttlMs: 12 * 60 * MINUTE,
    maxParticipants: 3,
    commandHistorySize: 16,
    defaultLeadMs: 750,
    hostGraceMs: 20_000,
    ...overrides,
});

const storeOptions = () => ({
    maxRooms: 2,
    roomTtlMs: 60 * MINUTE,
    roomIdleTtlMs: 30 * MINUTE,
    maxParticipantsPerRoom: 3,
    commandHistorySize: 16,
    defaultLeadMs: 750,
    hostGraceMs: 20_000,
});

const expectCode = (fn: () => unknown, code: string): void => {
    assert.throws(fn, (error: unknown) => error instanceof ProtocolError && error.code === code);
};

// ----------------------------------------------------------------------- ids

test('ids: the room id and the invitation secret are independent values', () => {
    const room = Room.create(roomInput(), roomOptions());
    assert.notEqual(room.roomId, room.inviteSecret);
    // At least 128 bits of entropy, base64url encoded.
    assert.ok(room.inviteSecret.length >= 22, `secret was only ${room.inviteSecret.length} characters`);
    assert.match(room.roomId, /^[A-Za-z0-9_-]+$/);
});

test('ids: secret comparison rejects mismatched values and lengths', () => {
    assert.equal(secretsMatch('abcdef', 'abcdef'), true);
    assert.equal(secretsMatch('abcdef', 'abcdeg'), false);
    assert.equal(secretsMatch('abcdef', 'abc'), false);
});

test('ids: a room snapshot never carries the invitation secret', () => {
    const room = Room.create(roomInput(), roomOptions());
    const serialized = JSON.stringify(room.toSnapshot(T0));
    assert.equal(serialized.includes(room.inviteSecret), false);
});

// ---------------------------------------------------------------- membership

test('join: the correct secret admits a guest', () => {
    const room = Room.create(roomInput(), roomOptions());
    const guest = room.join({
        inviteSecret: room.inviteSecret,
        displayName: 'Guest',
        deviceLabel: 'TV',
        capabilities: capabilities(),
        nowMs: T0 + 1,
    });
    assert.equal(guest.isHost, false);
    assert.equal(room.participantCount, 2);
});

test('join: a wrong secret is indistinguishable from a missing room', () => {
    const room = Room.create(roomInput(), roomOptions());
    expectCode(
        () =>
            room.join({
                inviteSecret: 'x'.repeat(room.inviteSecret.length),
                displayName: 'Guest',
                deviceLabel: null,
                capabilities: capabilities(),
                nowMs: T0,
            }),
        'ROOM_NOT_FOUND',
    );
});

test('join: the participant limit is enforced', () => {
    const room = Room.create(roomInput(), roomOptions({ maxParticipants: 2 }));
    room.join({ inviteSecret: room.inviteSecret, displayName: 'Guest', deviceLabel: null, capabilities: capabilities(), nowMs: T0 });
    expectCode(
        () => room.join({ inviteSecret: room.inviteSecret, displayName: 'Third', deviceLabel: null, capabilities: capabilities(), nowMs: T0 }),
        'ROOM_FULL',
    );
});

test('join: two devices on one account remain two distinct participants', () => {
    // The room has no notion of account identity at all, so identical names and
    // capabilities cannot be deduplicated or merged (plan section 11.4).
    const room = Room.create(roomInput(), roomOptions());
    const first = room.join({ inviteSecret: room.inviteSecret, displayName: 'Ethan', deviceLabel: 'Laptop', capabilities: capabilities(), nowMs: T0 });
    const second = room.join({ inviteSecret: room.inviteSecret, displayName: 'Ethan', deviceLabel: 'TV', capabilities: capabilities(), nowMs: T0 });
    assert.notEqual(first.participantId, second.participantId);
    assert.equal(room.participantCount, 3);
});

test('capabilities: a client missing a required capability joins unsupported', () => {
    const room = Room.create(roomInput(), roomOptions());
    const guest = room.join({
        inviteSecret: room.inviteSecret,
        displayName: 'Cast',
        deviceLabel: null,
        capabilities: capabilities({ scheduledActions: false }),
        nowMs: T0,
    });
    assert.equal(guest.supported, false);
});

test('readiness: an unsupported client never counts as ready', () => {
    const room = Room.create(roomInput(), roomOptions());
    const guest = room.join({
        inviteSecret: room.inviteSecret,
        displayName: 'Cast',
        deviceLabel: null,
        capabilities: capabilities({ scheduledActions: false }),
        nowMs: T0,
    });
    room.updateReadiness(guest.participantId, {
        ready: true,
        loaded: true,
        buffering: false,
        durationMs: DURATION_MS,
        mediaRevision: 1,
        sourceFingerprint: 'torrent:abc:0',
    }, T0);
    assert.equal(room.getParticipant(guest.participantId)?.ready, false);
});

test('readiness: readiness for an older media revision is not accepted', () => {
    const room = Room.create(roomInput(), roomOptions());
    room.updateReadiness(room.hostParticipantId, {
        ready: true,
        loaded: true,
        buffering: false,
        durationMs: DURATION_MS,
        mediaRevision: 0,
        sourceFingerprint: null,
    }, T0);
    assert.equal(room.hostParticipant?.ready, false);
});

// ------------------------------------------------------------------ authority

test('authority: a guest cannot mutate playback', () => {
    const room = Room.create(roomInput(), roomOptions());
    const guest = room.join({ inviteSecret: room.inviteSecret, displayName: 'Guest', deviceLabel: null, capabilities: capabilities(), nowMs: T0 });
    expectCode(
        () =>
            room.applyHostCommand(guest.participantId, {
                commandId: 'c1',
                action: 'pause',
                expectedRevision: 1,
                mediaRevision: 1,
            }, T0),
        'NOT_HOST',
    );
});

const makeReadyRoom = (policy?: Partial<RoomPolicy>): Room => {
    const room = Room.create(roomInput(policy === undefined ? {} : { policy }), roomOptions());
    room.updateReadiness(room.hostParticipantId, {
        ready: true,
        loaded: true,
        buffering: false,
        durationMs: DURATION_MS,
        mediaRevision: 1,
        sourceFingerprint: 'torrent:abc:0',
    }, T0);
    return room;
};

test('barrier: the host cannot start before its own player is ready', () => {
    const room = Room.create(roomInput(), roomOptions());
    expectCode(
        () => room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1 }, T0),
        'READINESS_BARRIER',
    );
});

test('barrier: with requireAllReadyToStart, an unready guest blocks the first start', () => {
    const room = makeReadyRoom();
    room.join({ inviteSecret: room.inviteSecret, displayName: 'Guest', deviceLabel: null, capabilities: capabilities(), nowMs: T0 });
    expectCode(
        () => room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1 }, T0),
        'READINESS_BARRIER',
    );
});

test('barrier: once the room has started, a guest that drops out cannot block a resume', () => {
    const room = makeReadyRoom();
    const guest = room.join({ inviteSecret: room.inviteSecret, displayName: 'Guest', deviceLabel: null, capabilities: capabilities(), nowMs: T0 });
    room.updateReadiness(guest.participantId, {
        ready: true, loaded: true, buffering: false, durationMs: DURATION_MS, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0',
    }, T0);

    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1 }, T0);
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c2', action: 'pause', expectedRevision: 2, mediaRevision: 1 }, T0 + 1_000);
    // The guest rebuffers and stops being ready.
    room.updateReadiness(guest.participantId, {
        ready: false, loaded: true, buffering: true, durationMs: DURATION_MS, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0',
    }, T0 + 2_000);

    const result = room.applyHostCommand(room.hostParticipantId, { commandId: 'c3', action: 'play', expectedRevision: 3, mediaRevision: 1 }, T0 + 3_000);
    assert.equal(result.outcome, 'applied');
});

test('barrier: a recovered host becomes ready and can resume without strict alignment', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0,
    }, T0);
    room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c2', action: 'pause', expectedRevision: 2, mediaRevision: 1,
    }, T0 + 1_000);
    room.updateReadiness(room.hostParticipantId, {
        ready: false,
        loaded: true,
        buffering: false,
        durationMs: DURATION_MS,
        mediaRevision: 1,
        sourceFingerprint: 'torrent:abc:0',
    }, T0 + 2_000);
    assert.equal(room.hostParticipant?.ready, true);

    const result = room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c3', action: 'play', expectedRevision: 3, mediaRevision: 1, leadMs: 0,
    }, T0 + 3_000);
    assert.equal(result.outcome, 'applied');
});

test('barrier: a genuinely buffering host stays unready and cannot resume', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0,
    }, T0);
    room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c2', action: 'pause', expectedRevision: 2, mediaRevision: 1,
    }, T0 + 1_000);
    room.updateReadiness(room.hostParticipantId, {
        ready: true,
        loaded: true,
        buffering: true,
        durationMs: DURATION_MS,
        mediaRevision: 1,
        sourceFingerprint: 'torrent:abc:0',
    }, T0 + 2_000);

    assert.equal(room.hostParticipant?.ready, false);
    expectCode(() => room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c3', action: 'play', expectedRevision: 3, mediaRevision: 1, leadMs: 0,
    }, T0 + 3_000), 'READINESS_BARRIER');
});

test('media end: the room becomes idle until the host changes media', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0,
    }, T0);

    assert.equal(room.endMedia(room.hostParticipantId, T0 + 10_000), true);
    assert.equal(room.mediaActive, false);
    assert.equal(room.playback.paused, true);
    assert.equal(room.toSnapshot(T0 + 10_000).mediaActive, false);
    expectCode(() => room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c2', action: 'play', expectedRevision: room.playback.revision, mediaRevision: 1,
    }, T0 + 10_001), 'READINESS_BARRIER');

    room.changeMedia(room.hostParticipantId, {
        mediaChangeId: 'next', media: media({ videoId: 'next' }), source: source({ fingerprint: 'torrent:def:1' }),
    }, T0 + 11_000);
    assert.equal(room.mediaActive, true);
});

test('media end: a guest cannot end the current media', () => {
    const room = makeReadyRoom();
    const guest = room.join({
        inviteSecret: room.inviteSecret,
        displayName: 'Guest',
        deviceLabel: null,
        capabilities: capabilities(),
        nowMs: T0,
    });
    expectCode(() => room.endMedia(guest.participantId, T0 + 1), 'NOT_HOST');
});

test('authority: guest seek and rate grants do not grant source or play/pause control', () => {
    const room = makeReadyRoom({ allowGuestSeek: true, allowGuestPlaybackRate: true });
    const guest = room.join({
        inviteSecret: room.inviteSecret,
        displayName: 'Guest',
        deviceLabel: null,
        capabilities: capabilities(),
        nowMs: T0,
    });

    const seek = room.applyHostCommand(guest.participantId, {
        commandId: 'guest-seek', action: 'seek', expectedRevision: 1, mediaRevision: 1, positionMs: 4_000,
    }, T0);
    assert.equal(seek.state.positionMs, 4_000);
    const rate = room.applyHostCommand(guest.participantId, {
        commandId: 'guest-rate', action: 'rate', expectedRevision: 2, mediaRevision: 1, rate: 1.25,
    }, T0 + 1);
    assert.equal(rate.state.rate, 1.25);
    expectCode(
        () => room.applyHostCommand(guest.participantId, {
            commandId: 'guest-play', action: 'play', expectedRevision: 3, mediaRevision: 1,
        }, T0 + 2),
        'NOT_HOST',
    );
    expectCode(
        () => room.changeMedia(guest.participantId, {
            mediaChangeId: 'guest-media', media: media(), source: source(),
        }, T0 + 3),
        'NOT_HOST',
    );
});

test('presence: the host can remove a guest but not itself', () => {
    const room = makeReadyRoom();
    const guest = room.join({
        inviteSecret: room.inviteSecret,
        displayName: 'Guest',
        deviceLabel: null,
        capabilities: capabilities(),
        nowMs: T0,
    });
    room.removeParticipantByHost(room.hostParticipantId, guest.participantId, T0 + 1);
    assert.equal(room.getParticipant(guest.participantId), undefined);
    expectCode(
        () => room.removeParticipantByHost(room.hostParticipantId, room.hostParticipantId, T0 + 2),
        'VALIDATION_FAILED',
    );
});

test('barrier: a media change re-arms it for the new episode', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1 }, T0);
    room.changeMedia(room.hostParticipantId, { mediaChangeId: 'm1', media: media({ videoId: 'e2' }), source: source() }, T0 + 1_000);
    assert.equal(room.mediaRevision, 2);
    assert.equal(room.hostParticipant?.ready, false);
    expectCode(
        () => room.applyHostCommand(room.hostParticipantId, { commandId: 'c2', action: 'play', expectedRevision: room.playback.revision, mediaRevision: 2 }, T0 + 2_000),
        'READINESS_BARRIER',
    );
});

test('buffering: a supported guest freezes a running room by default', () => {
    const room = makeReadyRoom();
    const guest = room.join({
        inviteSecret: room.inviteSecret,
        displayName: 'Guest',
        deviceLabel: null,
        capabilities: capabilities(),
        nowMs: T0,
    });
    room.updateReadiness(guest.participantId, {
        ready: true, loaded: true, buffering: false, durationMs: DURATION_MS, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0',
    }, T0);
    room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0,
    }, T0);

    room.updateReadiness(guest.participantId, {
        ready: true, loaded: true, buffering: true, durationMs: DURATION_MS, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0',
    }, T0 + 750);
    const result = room.pauseForBuffering(guest.participantId, T0 + 750);

    assert.deepEqual(result, { changed: true, reason: 'participant_buffering' });
    assert.equal(room.playback.paused, true);
    assert.equal(room.playback.positionMs, 750);
    assert.equal(room.pauseReason, 'participant_buffering');
});

test('buffering: a room can opt out of guest-triggered pauses', () => {
    const room = makeReadyRoom({ pauseOnGuestBuffering: false });
    const guest = room.join({
        inviteSecret: room.inviteSecret,
        displayName: 'Guest',
        deviceLabel: null,
        capabilities: capabilities(),
        nowMs: T0,
    });
    room.updateReadiness(guest.participantId, {
        ready: true, loaded: true, buffering: false, durationMs: DURATION_MS, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0',
    }, T0);
    room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0,
    }, T0);
    room.updateReadiness(guest.participantId, {
        ready: true, loaded: true, buffering: true, durationMs: DURATION_MS, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0',
    }, T0 + 750);

    assert.deepEqual(room.pauseForBuffering(guest.participantId, T0 + 750), { changed: false, reason: null });
    assert.equal(room.playback.paused, false);
});

test('buffering: a host freezes the room even when guest buffering is ignored', () => {
    const room = makeReadyRoom({ pauseOnGuestBuffering: false });
    room.applyHostCommand(room.hostParticipantId, {
        commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0,
    }, T0);
    room.updateReadiness(room.hostParticipantId, {
        ready: true, loaded: true, buffering: true, durationMs: DURATION_MS, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0',
    }, T0 + 750);

    assert.equal(room.pauseForBuffering(room.hostParticipantId, T0 + 750).changed, true);
    assert.equal(room.playback.paused, true);
});

test('media change: a replayed change id does not advance the revision twice', () => {
    const room = makeReadyRoom();
    const first = room.changeMedia(room.hostParticipantId, { mediaChangeId: 'm1', media: media(), source: source() }, T0);
    const second = room.changeMedia(room.hostParticipantId, { mediaChangeId: 'm1', media: media(), source: source() }, T0 + 10);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(room.mediaRevision, 2);
});

test('media: live media is refused at creation and at change', () => {
    expectCode(() => Room.create(roomInput({ media: media({ live: true }) }), roomOptions()), 'UNSUPPORTED_MEDIA');
    const room = makeReadyRoom();
    expectCode(
        () => room.changeMedia(room.hostParticipantId, { mediaChangeId: 'm1', media: media({ live: true }), source: source() }, T0),
        'UNSUPPORTED_MEDIA',
    );
});

// ---------------------------------------------------------- host observations

test('observation: a host observation past the tolerance rebases canonical position', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    const revisionBefore = room.playback.revision;
    const result = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 12_000, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );
    assert.equal(result.changed, true);
    assert.equal(room.playback.positionMs, 12_000);
    assert.equal(room.playback.revision, revisionBefore + 1);
});

test('observation: a host observation within tolerance changes nothing', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    const revisionBefore = room.playback.revision;
    const result = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 10_100, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );
    assert.equal(result.changed, false);
    assert.equal(room.playback.revision, revisionBefore);
});

test('observation: a stalled host never drags the room backwards', () => {
    // Reported from real two-client use: the host seeks, rebuffers, and its
    // position stops advancing. If canonical follows it back, every other
    // participant is yanked backwards, plays forward again before the next
    // observation, and is yanked back once more — a sawtooth that only ends
    // when the host recovers.
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    const revisionBefore = room.playback.revision;

    // Ten seconds of wall time pass; the host has managed only one.
    const result = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 1_000, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );

    assert.equal(result.changed, false);
    assert.equal(room.playback.revision, revisionBefore);
    // The room keeps running, so the stalled host is measurably behind and can
    // report itself unready rather than claiming to be synchronized.
    assert.equal(room.canonicalPositionMs(T0 + 10_000), 10_000);
});

test('observation: the room still follows a host that runs ahead', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);

    const result = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 12_000, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );

    assert.equal(result.changed, true);
    assert.equal(room.playback.positionMs, 12_000);
});

test('observation: with the stall pause off, canonical never moves backwards', () => {
    const room = makeReadyRoom({ pauseOnHostStall: false });
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);

    let previous = room.canonicalPositionMs(T0);
    for (let tick = 1; tick <= 6; tick += 1) {
        const nowMs = T0 + tick * 2_000;
        room.applyHostObservation(
            room.hostParticipantId,
            { positionMs: 1_500, paused: false, rate: 1, mediaRevision: 1 },
            nowMs,
            250,
            3_000,
        );
        const current = room.canonicalPositionMs(nowMs);
        assert.ok(current >= previous, `canonical went backwards: ${previous} -> ${current}`);
        previous = current;
    }
});

test('stall pause: a host that stops making progress pauses the room', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);

    // First sample only establishes a baseline; nothing is known yet.
    const baseline = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 2_000, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 2_000,
        250,
        3_000,
    );
    assert.equal(baseline.reason, null);

    // Then the host stops advancing for longer than the grace period.
    room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 2_100, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 4_000,
        250,
        3_000,
    );
    const paused = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 2_150, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 6_000,
        250,
        3_000,
    );

    assert.equal(paused.changed, true);
    assert.equal(paused.reason, 'host_stalled');
    assert.equal(room.playback.paused, true);
    assert.equal(room.pauseReason, 'host_stalled');
    assert.equal(room.hostParticipant?.buffering, true);
    assert.equal(room.hostParticipant?.ready, false);
    // Paused where the host actually is, which is the position it has data for.
    assert.equal(room.playback.positionMs, 2_150);
});

test('stall pause: the room settles rather than pausing repeatedly', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);

    let pauses = 0;
    for (let tick = 1; tick <= 8; tick += 1) {
        const result = room.applyHostObservation(
            room.hostParticipantId,
            { positionMs: 1_500, paused: false, rate: 1, mediaRevision: 1 },
            T0 + tick * 2_000,
            250,
            3_000,
        );
        if (result.reason === 'host_stalled') {
            pauses += 1;
        }
    }
    assert.equal(pauses, 1, 'the room should pause once, not on every observation');
    assert.equal(room.playback.paused, true);
});

test('stall pause: a host keeping up is never paused', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);

    for (let tick = 1; tick <= 8; tick += 1) {
        const nowMs = T0 + tick * 2_000;
        const result = room.applyHostObservation(
            room.hostParticipantId,
            { positionMs: tick * 2_000, paused: false, rate: 1, mediaRevision: 1 },
            nowMs,
            250,
            3_000,
        );
        assert.equal(result.reason, null);
    }
    assert.equal(room.playback.paused, false);
});

test('stall pause: resuming clears the reason and the measured stall', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    for (let tick = 1; tick <= 4; tick += 1) {
        room.applyHostObservation(
            room.hostParticipantId,
            { positionMs: 1_500, paused: false, rate: 1, mediaRevision: 1 },
            T0 + tick * 2_000,
            250,
            3_000,
        );
    }
    assert.equal(room.playback.paused, true);

    room.updateReadiness(room.hostParticipantId, {
        ready: true, loaded: true, buffering: false, durationMs: DURATION_MS, mediaRevision: 1, sourceFingerprint: 'torrent:abc:0',
    }, T0 + 9_000);
    const resumed = room.applyHostCommand(
        room.hostParticipantId,
        { commandId: 'c2', action: 'play', expectedRevision: room.playback.revision, mediaRevision: 1, leadMs: 0 },
        T0 + 10_000,
    );

    assert.equal(resumed.outcome, 'applied');
    assert.equal(room.playback.paused, false);
    assert.equal(room.pauseReason, null);
});

test('observation: a disagreeing paused flag is ignored rather than adopted', () => {
    // A transient host rebuffer must not flip the whole room's play state.
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    const result = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 999_000, paused: true, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );
    assert.equal(result.changed, false);
    assert.equal(room.playback.paused, false);
});

test('observation: a pending scheduled start is never cancelled by an observation', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 750 }, T0);
    const result = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 500_000, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 100,
        250,
    );
    assert.equal(result.changed, false);
    assert.equal(room.playback.effectiveAtServerMs, T0 + 750);
});

test('observation: a guest observation is never authoritative', () => {
    const room = makeReadyRoom();
    const guest = room.join({ inviteSecret: room.inviteSecret, displayName: 'Guest', deviceLabel: null, capabilities: capabilities(), nowMs: T0 });
    const result = room.applyHostObservation(
        guest.participantId,
        { positionMs: 999_000, paused: true, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );
    assert.equal(result.changed, false);
});

// ------------------------------------------------------------- host grace/TTL

test('host grace: playback freezes only after the grace period elapses', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    room.markDisconnected(room.hostParticipantId, T0 + 1_000);

    assert.equal(room.freezeForHostGrace(T0 + 5_000), false);
    assert.equal(room.playback.paused, false);
    assert.equal(room.freezeForHostGrace(T0 + 25_000), true);
    assert.equal(room.playback.paused, true);
    assert.equal(room.playback.positionMs, 25_000);
    // Freezing twice must not keep bumping the revision.
    assert.equal(room.freezeForHostGrace(T0 + 30_000), false);
});

test('host grace: a returning host clears the freeze timer', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    room.markDisconnected(room.hostParticipantId, T0 + 1_000);
    room.markConnected(room.hostParticipantId, 'session-2', T0 + 2_000);
    assert.equal(room.freezeForHostGrace(T0 + 60_000), false);
    assert.equal(room.playback.paused, false);
});

test('host grace: after a freeze, a host command computed against the old revision is refused', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    const staleRevision = room.playback.revision;
    room.markDisconnected(room.hostParticipantId, T0 + 1_000);
    room.freezeForHostGrace(T0 + 25_000);
    expectCode(
        () => room.applyHostCommand(room.hostParticipantId, { commandId: 'c2', action: 'seek', positionMs: 0, expectedRevision: staleRevision, mediaRevision: 1 }, T0 + 26_000),
        'STALE_REVISION',
    );
});

test('disconnect: a dropped participant stops satisfying the ready barrier', () => {
    const room = makeReadyRoom();
    room.markDisconnected(room.hostParticipantId, T0 + 100);
    assert.equal(room.hostParticipant?.ready, false);
    assert.equal(room.canStartPlayback(), false);
});

test('store: rooms expire on absolute TTL and on idle TTL', () => {
    const store = new RoomStore(storeOptions());
    const room = store.create(roomInput(), T0);
    room.markDisconnected(room.hostParticipantId, T0);

    assert.equal(room.isExpired(T0 + MINUTE, 30 * MINUTE), false);
    assert.equal(room.isExpired(T0 + 31 * MINUTE, 30 * MINUTE), true);
    assert.equal(room.isExpired(T0 + 61 * MINUTE, 24 * 60 * MINUTE), true);
});

test('store: an idle room with someone still connected is kept alive', () => {
    const store = new RoomStore(storeOptions());
    const room = store.create(roomInput(), T0);
    room.markConnected(room.hostParticipantId, 'session-1', T0);
    assert.equal(room.isExpired(T0 + 31 * MINUTE, 30 * MINUTE), false);
});

test('store: sweeping removes expired rooms and reports them', () => {
    const store = new RoomStore(storeOptions());
    const room = store.create(roomInput(), T0);
    room.markDisconnected(room.hostParticipantId, T0);
    const expired = store.sweep(T0 + 31 * MINUTE);
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.room.roomId, room.roomId);
    assert.equal(expired[0]?.reason, 'expired');
    assert.equal(store.size, 0);
});

test('store: the room limit is enforced and reported distinctly', () => {
    const store = new RoomStore(storeOptions());
    store.create(roomInput(), T0);
    store.create(roomInput(), T0);
    expectCode(() => store.create(roomInput(), T0), 'ROOM_LIMIT_REACHED');
});

test('store: an expired room looks exactly like a missing one', () => {
    const store = new RoomStore(storeOptions());
    const room = store.create(roomInput(), T0);
    expectCode(() => store.requireOpen('does-not-exist', T0), 'ROOM_NOT_FOUND');
    expectCode(() => store.requireOpen(room.roomId, T0 + 61 * MINUTE), 'ROOM_NOT_FOUND');
});

// -------------------------------------------------------------------- sessions

test('sessions: a resume token is stored hashed, never in plaintext', () => {
    const store = new SessionStore({ resumeGraceMs: 2 * MINUTE });
    const { record, resumeToken } = store.create({ clientVersion: 'test', capabilities: capabilities(), nowMs: T0 });
    assert.notEqual(record.resumeTokenHash, resumeToken);
    assert.equal(record.resumeTokenHash, hashResumeToken(resumeToken));
    assert.equal(resumeTokenMatches(record.resumeTokenHash, resumeToken), true);
    assert.equal(resumeTokenMatches(record.resumeTokenHash, `${resumeToken}x`), false);
});

test('sessions: a disconnected session resumes with the right token', () => {
    const store = new SessionStore({ resumeGraceMs: 2 * MINUTE });
    const { record, resumeToken } = store.create({ clientVersion: 'test', capabilities: capabilities(), nowMs: T0 });
    store.markDisconnected(record.sessionId, T0 + 1_000);
    const resumed = store.resume({ sessionId: record.sessionId, resumeToken, nowMs: T0 + 2_000 });
    assert.equal(resumed.sessionId, record.sessionId);
    assert.equal(resumed.connected, true);
});

test('sessions: another participant cannot be taken over with a wrong or foreign token', () => {
    const store = new SessionStore({ resumeGraceMs: 2 * MINUTE });
    const victim = store.create({ clientVersion: 'test', capabilities: capabilities(), nowMs: T0 });
    const attacker = store.create({ clientVersion: 'test', capabilities: capabilities(), nowMs: T0 });
    store.markDisconnected(victim.record.sessionId, T0);

    expectCode(() => store.resume({ sessionId: victim.record.sessionId, resumeToken: attacker.resumeToken, nowMs: T0 + 1 }), 'RESUME_REJECTED');
    expectCode(() => store.resume({ sessionId: 'unknown', resumeToken: victim.resumeToken, nowMs: T0 + 1 }), 'RESUME_REJECTED');
});

test('sessions: a session that is still connected cannot be resumed out from under itself', () => {
    const store = new SessionStore({ resumeGraceMs: 2 * MINUTE });
    const { record, resumeToken } = store.create({ clientVersion: 'test', capabilities: capabilities(), nowMs: T0 });
    expectCode(() => store.resume({ sessionId: record.sessionId, resumeToken, nowMs: T0 + 1 }), 'RESUME_REJECTED');
});

test('sessions: the resume window closes and the record is swept', () => {
    const store = new SessionStore({ resumeGraceMs: MINUTE });
    const { record, resumeToken } = store.create({ clientVersion: 'test', capabilities: capabilities(), nowMs: T0 });
    store.markDisconnected(record.sessionId, T0);
    expectCode(() => store.resume({ sessionId: record.sessionId, resumeToken, nowMs: T0 + 2 * MINUTE }), 'RESUME_REJECTED');

    const other = store.create({ clientVersion: 'test', capabilities: capabilities(), nowMs: T0 });
    store.markDisconnected(other.record.sessionId, T0);
    const swept = store.sweep(T0 + 2 * MINUTE);
    assert.equal(swept.length, 1);
    assert.equal(store.size, 0);
});
