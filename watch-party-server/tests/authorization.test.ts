// Copyright (C) 2017-2026 Smart code 203358507

import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../src/protocol/types.ts';
import { TestClient, capabilities, sampleSource, startHarness } from './helpers/harness.ts';

/**
 * End-to-end authority and hardening checks against a real in-process
 * WebSocket server with two clients (plan section 17.3).
 */

const setUpStartedRoom = async () => {
    const harness = await startHarness();
    const host = await harness.connect();
    await host.hello();
    await host.createRoom();

    const guest = await harness.connect();
    await guest.hello();
    await guest.joinRoom(host.roomId as string, host.inviteSecret as string);

    await host.ready();
    await guest.ready();
    return { harness, host, guest };
};

test('handshake: every message before session.hello is refused', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const client = await harness.connect();
    const error = await client.request('room.leave', {});
    assert.equal(error.type, 'error');
    assert.equal(error.payload.code, 'HANDSHAKE_REQUIRED');
});

test('handshake: a second session.hello on one socket is refused', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const client = await harness.connect();
    await client.hello();
    const error = await client.request('session.hello', {
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: 'test',
        capabilities: capabilities(),
    });
    assert.equal(error.payload.code, 'ALREADY_HANDSHAKEN');
});

test('handshake: an unsupported protocol version reports the supported range', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const client = await harness.connect();
    const error = await client.request('session.hello', {
        protocolVersion: 999,
        clientVersion: 'test',
        capabilities: capabilities(),
    });
    assert.equal(error.payload.code, 'UNSUPPORTED_PROTOCOL_VERSION');
    assert.deepEqual(error.payload.details, { min: 1, max: PROTOCOL_VERSION });
});

test('handshake: a client missing a required capability is told it is unsupported', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const client = await harness.connect();
    const welcome = await client.hello({ capabilities: capabilities({ scheduledActions: false }) });
    assert.equal(welcome.payload.supported, false);
    assert.deepEqual(welcome.payload.missingCapabilities, ['scheduledActions']);
});

test('room.create: the invitation secret is delivered exactly once, to the host only', async (t) => {
    const { harness, host, guest } = await setUpStartedRoom();
    t.after(() => harness.stop());

    const secret = host.inviteSecret as string;
    assert.ok(secret.length >= 22);
    // Nothing the guest ever received may contain the bearer credential.
    assert.equal(JSON.stringify(guest.received).includes(secret), false);
    // Neither may any subsequent snapshot sent to the host.
    const snapshots = host.received.filter((envelope) => envelope.type === 'room.snapshot');
    assert.equal(JSON.stringify(snapshots).includes(secret), false);
});

test('room.join: a wrong invitation secret is indistinguishable from a missing room', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const host = await harness.connect();
    await host.hello();
    await host.createRoom();

    const guest = await harness.connect();
    await guest.hello();
    const wrongSecret = await guest.request('room.join', {
        roomId: host.roomId,
        inviteSecret: 'z'.repeat((host.inviteSecret as string).length),
        displayName: 'Guest',
    });
    const missingRoom = await guest.request('room.join', {
        roomId: 'nosuchroom',
        inviteSecret: host.inviteSecret,
        displayName: 'Guest',
    });
    assert.equal(wrongSecret.payload.code, 'ROOM_NOT_FOUND');
    assert.equal(missingRoom.payload.code, 'ROOM_NOT_FOUND');
});

test('authority: a guest cannot change playback by crafting a raw command', async (t) => {
    const { harness, host, guest } = await setUpStartedRoom();
    t.after(() => harness.stop());

    const before = harness.server.service.rooms.get(host.roomId as string)?.playback.revision;
    const error = await guest.request('playback.command', {
        commandId: 'evil1',
        action: 'seek',
        expectedRevision: 1,
        mediaRevision: 1,
        positionMs: 999_000,
    });
    assert.equal(error.payload.code, 'NOT_HOST');
    assert.equal(harness.server.service.rooms.get(host.roomId as string)?.playback.revision, before);
});

test('authority: a guest cannot change media or refresh the source', async (t) => {
    const { harness, host, guest } = await setUpStartedRoom();
    t.after(() => harness.stop());

    const mediaError = await guest.request('media.change', {
        mediaChangeId: 'm1',
        media: { type: 'movie', metaId: 'tt1', videoId: null, title: 'Other', expectedDurationMs: 1000, live: false },
        source: sampleSource(),
    });
    const sourceError = await guest.request('source.refresh', { source: sampleSource() });
    assert.equal(mediaError.payload.code, 'NOT_HOST');
    assert.equal(sourceError.payload.code, 'NOT_HOST');
    assert.equal(harness.server.service.rooms.get(host.roomId as string)?.mediaRevision, 1);
});

test('authority: a host command is broadcast to every member exactly once', async (t) => {
    const { harness, host, guest } = await setUpStartedRoom();
    t.after(() => harness.stop());

    host.send('playback.command', {
        commandId: 'p1',
        action: 'play',
        expectedRevision: 1,
        mediaRevision: 1,
        leadMs: 500,
    });

    const guestState = await guest.waitFor('playback.state');
    const hostState = await host.waitFor('playback.state');
    const playback = guestState.payload.playback as { paused: boolean; positionMs: number; effectiveAtServerMs: number; updatedAtServerMs: number };
    assert.equal(playback.paused, false);
    assert.equal(playback.effectiveAtServerMs - playback.updatedAtServerMs, 500);
    assert.deepEqual(hostState.payload.playback, guestState.payload.playback);

    // Give any duplicate broadcast a chance to arrive before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(guest.received.filter((envelope) => envelope.type === 'playback.state').length, 1);
});

test('buffering: a guest report freezes playback for the whole room', async (t) => {
    const { harness, host, guest } = await setUpStartedRoom();
    t.after(() => harness.stop());

    host.send('playback.command', {
        commandId: 'p1',
        action: 'play',
        expectedRevision: 1,
        mediaRevision: 1,
        leadMs: 0,
    });
    await host.waitFor(
        (envelope) => envelope.type === 'playback.state' && (envelope.payload.playback as { paused: boolean }).paused === false,
    );
    await guest.waitFor(
        (envelope) => envelope.type === 'playback.state' && (envelope.payload.playback as { paused: boolean }).paused === false,
    );

    await guest.ready(1, { buffering: true });
    const hostPause = await host.waitFor(
        (envelope) =>
            envelope.type === 'playback.state' &&
            envelope.payload.reason === 'participant_buffering',
    );
    const guestPause = await guest.waitFor(
        (envelope) =>
            envelope.type === 'playback.state' &&
            envelope.payload.reason === 'participant_buffering',
    );

    assert.equal((hostPause.payload.playback as { paused: boolean }).paused, true);
    assert.deepEqual(guestPause.payload.playback, hostPause.payload.playback);
});

test('barrier: the host cannot start until every participant is ready', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const host = await harness.connect();
    await host.hello();
    await host.createRoom();
    const guest = await harness.connect();
    await guest.hello();
    await guest.joinRoom(host.roomId as string, host.inviteSecret as string);
    await host.ready();

    const blocked = await host.request('playback.command', {
        commandId: 'p1', action: 'play', expectedRevision: 1, mediaRevision: 1,
    });
    assert.equal(blocked.payload.code, 'READINESS_BARRIER');

    await guest.ready();
    host.send('playback.command', { commandId: 'p2', action: 'play', expectedRevision: 1, mediaRevision: 1 });
    // The rejected command above also produced a resynchronizing `playback.state`,
    // so match on the running state rather than on the next frame of that type.
    const state = await host.waitFor(
        (envelope) => envelope.type === 'playback.state' && (envelope.payload.playback as { paused: boolean }).paused === false,
    );
    assert.equal((state.payload.playback as { paused: boolean }).paused, false);
});

test('barrier: a rejected command hands back the current canonical state', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const host = await harness.connect();
    await host.hello();
    await host.createRoom();
    host.send('playback.command', { commandId: 'p1', action: 'play', expectedRevision: 1, mediaRevision: 1 });
    await host.waitFor('error');
    const state = await host.waitFor('playback.state');
    assert.equal((state.payload.playback as { paused: boolean }).paused, true);
});

test('presence: a joining guest appears to the host and a leaving guest disappears', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const host = await harness.connect();
    await host.hello();
    await host.createRoom();

    const guest = await harness.connect();
    await guest.hello();
    await guest.joinRoom(host.roomId as string, host.inviteSecret as string);

    const joined = await host.waitFor('participant.updated');
    assert.equal((joined.payload.participant as { displayName: string }).displayName, 'Guest');
    assert.equal((joined.payload.participant as { deviceLabel: string }).deviceLabel, 'TV');

    await guest.request('room.leave', {});
    const left = await host.waitFor('participant.left');
    assert.equal(left.payload.participantId, guest.participantId);
});

test('presence: an explicit host departure ends the room for everyone', async (t) => {
    const { harness, host, guest } = await setUpStartedRoom();
    t.after(() => harness.stop());

    await host.request('room.leave', {});
    const closed = await guest.waitFor('room.closed');
    assert.equal(closed.payload.reason, 'host_ended');
    assert.equal(harness.server.service.rooms.size, 0);
});

test('rooms: a session cannot be in two rooms at once', async (t) => {
    const { harness, host, guest } = await setUpStartedRoom();
    t.after(() => harness.stop());

    const error = await guest.request('room.join', {
        roomId: host.roomId,
        inviteSecret: host.inviteSecret,
        displayName: 'Guest',
    });
    assert.equal(error.payload.code, 'ALREADY_IN_ROOM');
});

test('clock: pong echoes the nonce and carries two server timestamps', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const client = await harness.connect();
    await client.hello();
    const pong = await client.request('clock.ping', { nonce: 'n1', clientSentMs: 42 }, 'clock.pong');
    assert.equal(pong.type, 'clock.pong');
    assert.equal(pong.payload.nonce, 'n1');
    assert.equal(pong.payload.clientSentMs, 42);
    assert.equal(typeof pong.payload.serverRecvMs, 'number');
    assert.equal(typeof pong.payload.serverSendMs, 'number');
});

test('limits: an oversized frame is refused without touching room state', async (t) => {
    const harness = await startHarness({ WATCH_PARTY_MAX_MESSAGE_BYTES: '2048' });
    t.after(() => harness.stop());

    const client = await harness.connect();
    await client.hello();
    client.sendRaw(JSON.stringify({ v: 1, type: 'clock.ping', payload: { nonce: 'x'.repeat(3000), clientSentMs: 1 } }));
    const error = await client.waitFor('error');
    assert.equal(error.payload.code, 'MESSAGE_TOO_LARGE');
});

test('limits: rate limiting drops messages without mutating canonical state', async (t) => {
    const { harness, host } = await setUpStartedRoom();
    t.after(() => harness.stop());

    const room = harness.server.service.rooms.get(host.roomId as string);
    assert.ok(room !== undefined);

    // The clock is frozen, so no tokens are refilled during the burst.
    for (let index = 0; index < 20; index += 1) {
        host.send('playback.command', {
            commandId: `burst${index}`,
            action: 'seek',
            expectedRevision: room.playback.revision,
            mediaRevision: 1,
            positionMs: 1000 * index,
        });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const rateLimited = host.received.filter(
        (envelope) => envelope.type === 'error' && envelope.payload.code === 'RATE_LIMITED',
    );
    const applied = host.received.filter((envelope) => envelope.type === 'playback.state');
    assert.ok(rateLimited.length > 0, 'expected some commands to be rate limited');
    assert.ok(applied.length <= 10, `expected at most the burst size to apply, saw ${applied.length}`);
    assert.equal(harness.metrics.rateLimitedTotal.get({ bucket: 'command' }) > 0, true);
});

test('limits: repeated invalid messages close the connection', async (t) => {
    const harness = await startHarness({ WATCH_PARTY_MAX_INVALID_MESSAGES: '3' });
    t.after(() => harness.stop());

    const client = await harness.connect();
    await client.hello();
    const closed = new Promise<void>((resolve) => client.socket.once('close', () => resolve()));
    for (let index = 0; index < 5; index += 1) {
        client.sendRaw('{"not":"an envelope"}');
    }
    await closed;
    assert.equal(client.isClosed, true);
});

test('limits: a rate-limited burst does not close a healthy connection', async (t) => {
    const { harness, host } = await setUpStartedRoom();
    t.after(() => harness.stop());

    for (let index = 0; index < 30; index += 1) {
        host.send('clock.ping', { nonce: `n${index}`, clientSentMs: index });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(host.isClosed, false);
});

test('limits: an invalid payload never crashes the process', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const client = await harness.connect();
    await client.hello();
    client.sendRaw(JSON.stringify({ v: 1, type: 'participant.ready', payload: { ready: 'yes' } }));
    const error = await client.waitFor('error');
    assert.equal(error.payload.code, 'VALIDATION_FAILED');
    // The socket is still usable afterwards.
    const pong = await client.request('clock.ping', { nonce: 'still-alive', clientSentMs: 1 }, 'clock.pong');
    assert.equal(pong.payload.nonce, 'still-alive');
});

test('origin: a disallowed browser origin is rejected at upgrade', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    await assert.rejects(() => TestClient.connect(harness.url, { origin: 'https://evil.example' }));
    assert.equal(harness.metrics.connectionsRejectedTotal.get({ reason: 'bad_origin' }), 1);
});

test('origin: an unrelated path is not upgraded', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    await assert.rejects(() => TestClient.connect(harness.url.replace('/v1/ws', '/nope')));
    assert.equal(harness.metrics.connectionsRejectedTotal.get({ reason: 'bad_path' }), 1);
});

test('observability: secrets, auth keys and stream urls stay out of the logs', async (t) => {
    const harness = await startHarness({}, { logLevel: 'debug' });
    t.after(() => harness.stop());

    const host = await harness.connect();
    await host.hello();
    await host.createRoom({
        source: sampleSource({
            authKey: 'super-secret-auth-key',
            streamTransportUrl: 'https://addon.example/SECRET-CONFIG/manifest.json',
        }),
    });
    await host.ready();

    const logs = harness.logLines.join('\n');
    assert.ok(logs.length > 0, 'expected the service to have logged something');
    assert.equal(logs.includes('super-secret-auth-key'), false);
    assert.equal(logs.includes('SECRET-CONFIG'), false);
    assert.equal(logs.includes(host.inviteSecret as string), false);
});

test('observability: health, readiness and metrics endpoints report state', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const base = `http://127.0.0.1:${harness.server.publicPort}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    assert.equal((await fetch(`${base}/metrics`)).status, 404);

    const host = await harness.connect();
    await host.hello();
    await host.createRoom();

    const metricsText = await (await fetch(`http://127.0.0.1:${harness.server.metricsPort}/metrics`)).text();
    assert.match(metricsText, /watch_party_rooms_created_total 1/);
    assert.match(metricsText, /watch_party_connections_total 1/);
    assert.match(metricsText, /# TYPE watch_party_guest_drift_ms histogram/);
});

test('shutdown: closing the server tells clients the room is gone', async (t) => {
    const { harness, guest } = await setUpStartedRoom();
    const closed = guest.waitFor('room.closed');
    await harness.server.close();
    assert.equal((await closed).payload.reason, 'server_shutdown');
    t.after(() => harness.stop());
});
