// Copyright (C) 2017-2026 Smart code 203358507

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolError } from '../src/protocol/errors.ts';
import type { MediaDescriptor, PlayerCapabilities, SourceBundle } from '../src/protocol/types.ts';
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

const makeReadyRoom = (): Room => {
    const room = Room.create(roomInput(), roomOptions());
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
    const changed = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 12_000, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );
    assert.equal(changed, true);
    assert.equal(room.playback.positionMs, 12_000);
    assert.equal(room.playback.revision, revisionBefore + 1);
});

test('observation: a host observation within tolerance changes nothing', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    const revisionBefore = room.playback.revision;
    const changed = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 10_100, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );
    assert.equal(changed, false);
    assert.equal(room.playback.revision, revisionBefore);
});

test('observation: a disagreeing paused flag is ignored rather than adopted', () => {
    // A transient host rebuffer must not flip the whole room's play state.
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 }, T0);
    const changed = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 999_000, paused: true, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );
    assert.equal(changed, false);
    assert.equal(room.playback.paused, false);
});

test('observation: a pending scheduled start is never cancelled by an observation', () => {
    const room = makeReadyRoom();
    room.applyHostCommand(room.hostParticipantId, { commandId: 'c1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 750 }, T0);
    const changed = room.applyHostObservation(
        room.hostParticipantId,
        { positionMs: 500_000, paused: false, rate: 1, mediaRevision: 1 },
        T0 + 100,
        250,
    );
    assert.equal(changed, false);
    assert.equal(room.playback.effectiveAtServerMs, T0 + 750);
});

test('observation: a guest observation is never authoritative', () => {
    const room = makeReadyRoom();
    const guest = room.join({ inviteSecret: room.inviteSecret, displayName: 'Guest', deviceLabel: null, capabilities: capabilities(), nowMs: T0 });
    const changed = room.applyHostObservation(
        guest.participantId,
        { positionMs: 999_000, paused: true, rate: 1, mediaRevision: 1 },
        T0 + 10_000,
        250,
    );
    assert.equal(changed, false);
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
