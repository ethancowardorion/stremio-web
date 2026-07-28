// Copyright (C) 2017-2026 Smart code 203358507

import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../src/protocol/types.ts';
import { capabilities, startHarness, type Envelope, type Harness, type TestClient } from './helpers/harness.ts';

/**
 * Reconnect, resume and expiry behaviour (plan sections 14 and 17.3).
 *
 * The clock is injected and the sweep loop is driven explicitly, so grace
 * periods and TTLs are exercised without any real waiting.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

const startPlayingRoom = async (harness: Harness) => {
    const host = await harness.connect();
    await host.hello();
    await host.createRoom();
    const guest = await harness.connect();
    await guest.hello();
    await guest.joinRoom(host.roomId as string, host.inviteSecret as string);
    await host.ready();
    await guest.ready();

    host.send('playback.command', { commandId: 'p1', action: 'play', expectedRevision: 1, mediaRevision: 1, leadMs: 0 });
    await guest.waitFor('playback.state');
    return { host, guest };
};

const resumeAs = async (harness: Harness, previous: TestClient): Promise<{ client: TestClient; welcome: Envelope }> => {
    const client = await harness.connect();
    const welcome = await client.request(
        'session.hello',
        {
            protocolVersion: PROTOCOL_VERSION,
            clientVersion: 'test',
            capabilities: capabilities(),
            resume: { sessionId: previous.sessionId, resumeToken: previous.resumeToken },
        },
        'session.welcome',
    );
    if (welcome.type === 'session.welcome') {
        client.sessionId = welcome.payload.sessionId as string;
        client.resumeToken = previous.resumeToken;
        client.participantId = previous.participantId;
        client.roomId = previous.roomId;
    }
    return { client, welcome };
};

test('reconnect: a resumed guest receives a current snapshot without host intervention', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    await guest.close();
    await settle();

    harness.clock.advance(30_000);
    const { client, welcome } = await resumeAs(harness, guest);
    assert.equal(welcome.payload.resumed, true);
    // The resume token is not reissued; the client keeps the one it already has.
    assert.equal(welcome.payload.resumeToken, null);

    const snapshot = await client.waitFor('room.snapshot');
    const room = snapshot.payload.room as {
        playback: { paused: boolean; positionMs: number; effectiveAtServerMs: number };
        serverTimeMs: number;
        participants: { participantId: string; connected: boolean }[];
    };
    assert.equal(room.playback.paused, false);
    assert.equal(snapshot.payload.selfParticipantId, guest.participantId);
    // 30 s of wall time elapsed, so canonical position must have advanced.
    assert.equal(room.serverTimeMs - room.playback.effectiveAtServerMs, 30_000);

    const self = room.participants.find((participant) => participant.participantId === guest.participantId);
    assert.equal(self?.connected, true);
    assert.equal(harness.metrics.reconnectsTotal.get(), 1);
    await host.close();
});

test('reconnect: the host sees a returning guest come back online', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    await guest.close();

    const wentOffline = await host.waitFor(
        (envelope) =>
            envelope.type === 'participant.updated' &&
            (envelope.payload.participant as { participantId: string; connected: boolean }).participantId === guest.participantId &&
            (envelope.payload.participant as { connected: boolean }).connected === false,
    );
    assert.ok(wentOffline);
    // A dropped participant must stop satisfying anyone else's ready barrier.
    assert.equal((wentOffline.payload.participant as { ready: boolean }).ready, false);

    await resumeAs(harness, guest);
    const cameBack = await host.waitFor(
        (envelope) =>
            envelope.type === 'participant.updated' &&
            (envelope.payload.participant as { participantId: string }).participantId === guest.participantId &&
            (envelope.payload.participant as { connected: boolean }).connected === true,
    );
    assert.ok(cameBack);
});

test('reconnect: a resume after the grace window is refused', async (t) => {
    const harness = await startHarness({ WATCH_PARTY_RESUME_GRACE_MS: '60000' });
    t.after(() => harness.stop());

    const { guest } = await startPlayingRoom(harness);
    await guest.close();
    await settle();

    harness.clock.advance(120_000);
    const client = await harness.connect();
    const error = await client.request('session.hello', {
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: 'test',
        capabilities: capabilities(),
        resume: { sessionId: guest.sessionId, resumeToken: guest.resumeToken },
    });
    assert.equal(error.type, 'error');
    assert.equal(error.payload.code, 'RESUME_REJECTED');
});

test('reconnect: one participant cannot resume another participant session', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    await guest.close();
    await settle();

    const attacker = await harness.connect();
    const error = await attacker.request('session.hello', {
        protocolVersion: PROTOCOL_VERSION,
        clientVersion: 'test',
        capabilities: capabilities(),
        // The attacker holds the host's token but names the guest's session.
        resume: { sessionId: guest.sessionId, resumeToken: host.resumeToken },
    });
    assert.equal(error.payload.code, 'RESUME_REJECTED');
});

test('reconnect: resuming into a room that has since gone reports it, once', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    await guest.close();
    await settle();
    await host.request('room.leave', {});
    await settle();

    const { client } = await resumeAs(harness, guest);
    const closed = await client.waitFor('room.closed');
    assert.equal(closed.payload.reason, 'expired');
    // The session is unbound, so it can create a fresh room straight away.
    const created = await client.createRoom();
    assert.equal(created.type, 'room.created');
});

test('reconnect: a command replayed after reconnect is applied only once', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const { host } = await startPlayingRoom(harness);
    const room = harness.server.service.rooms.get(host.roomId as string);
    assert.ok(room !== undefined);

    host.send('playback.command', { commandId: 'seek-1', action: 'seek', expectedRevision: room.playback.revision, mediaRevision: 1, positionMs: 90_000 });
    await host.waitFor((envelope) => envelope.type === 'playback.state' && (envelope.payload.playback as { positionMs: number }).positionMs === 90_000);
    const revisionAfterFirst = room.playback.revision;

    // The client did not see the acknowledgement and retries the same command.
    const replay = await host.request('playback.command', {
        commandId: 'seek-1',
        action: 'seek',
        expectedRevision: revisionAfterFirst,
        mediaRevision: 1,
        positionMs: 90_000,
    }, 'playback.state');
    assert.equal(replay.type, 'playback.state');
    assert.equal(room.playback.revision, revisionAfterFirst);
    assert.equal(room.playback.positionMs, 90_000);
});

test('host grace: playback freezes for everyone after the host stays away', async (t) => {
    const harness = await startHarness({ WATCH_PARTY_HOST_GRACE_MS: '20000' });
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    await host.close();
    await settle();

    harness.clock.advance(10_000);
    harness.server.service.sweep();
    await settle();
    assert.equal(
        guest.received.some((envelope) => envelope.type === 'playback.state' && (envelope.payload.playback as { paused: boolean }).paused),
        false,
        'playback must keep running inside the grace period',
    );

    harness.clock.advance(15_000);
    harness.server.service.sweep();
    const frozen = await guest.waitFor(
        (envelope) => envelope.type === 'playback.state' && (envelope.payload.playback as { paused: boolean }).paused === true,
    );
    // The canonical position is pinned to where playback actually reached.
    assert.equal((frozen.payload.playback as { positionMs: number }).positionMs, 25_000);
});

test('host grace: a host that returns in time keeps the room running', async (t) => {
    const harness = await startHarness({ WATCH_PARTY_HOST_GRACE_MS: '20000' });
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    await host.close();
    await settle();

    harness.clock.advance(5_000);
    await resumeAs(harness, host);
    harness.clock.advance(60_000);
    harness.server.service.sweep();
    await settle();

    assert.equal(
        guest.received.some((envelope) => envelope.type === 'playback.state' && (envelope.payload.playback as { paused: boolean }).paused),
        false,
    );
});

test('host grace: when the host resume window closes, the room ends', async (t) => {
    const harness = await startHarness({ WATCH_PARTY_RESUME_GRACE_MS: '30000' });
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    await host.close();
    await settle();

    harness.clock.advance(60_000);
    harness.server.service.sweep();

    const closed = await guest.waitFor('room.closed');
    assert.equal(closed.payload.reason, 'host_left');
    assert.equal(harness.server.service.rooms.size, 0);
});

test('expiry: an idle room is swept and its members are told', async (t) => {
    const harness = await startHarness({ WATCH_PARTY_ROOM_IDLE_TTL_MS: '60000', WATCH_PARTY_RESUME_GRACE_MS: '3600000' });
    t.after(() => harness.stop());

    const host = await harness.connect();
    await host.hello();
    await host.createRoom();
    await host.close();
    await settle();

    harness.clock.advance(120_000);
    harness.server.service.sweep();
    assert.equal(harness.server.service.rooms.size, 0);

    // A resume into the swept room is told the room is gone rather than failing.
    const { client } = await resumeAs(harness, host);
    const closed = await client.waitFor('room.closed');
    assert.equal(closed.payload.reason, 'expired');
});

test('mid-playback join: a late guest gets the running canonical state', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const { host } = await startPlayingRoom(harness);
    harness.clock.advance(45_000);

    const latecomer = await harness.connect();
    await latecomer.hello();
    const snapshot = await latecomer.joinRoom(host.roomId as string, host.inviteSecret as string, { displayName: 'Late' });
    const room = snapshot.payload.room as {
        playback: { paused: boolean; positionMs: number; effectiveAtServerMs: number };
        serverTimeMs: number;
    };
    assert.equal(room.playback.paused, false);
    assert.equal(room.serverTimeMs - room.playback.effectiveAtServerMs, 45_000);
    // The late guest joins unready, so it cannot claim to be synchronized yet.
    const participants = (snapshot.payload.room as { participants: { participantId: string; ready: boolean }[] }).participants;
    assert.equal(participants.find((p) => p.participantId === latecomer.participantId)?.ready, false);
});

test('media change: a new episode resets readiness for everyone', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    host.send('media.change', {
        mediaChangeId: 'm1',
        media: { type: 'series', metaId: 'tt0903747', videoId: 'tt0903747:1:2', title: 'Cat in the Bag', expectedDurationMs: 2_800_000, live: false },
        source: {
            streamParam: 'next-episode',
            stream: { infoHash: 'def', fileIdx: 1 },
            streamTransportUrl: 'https://addon.example/manifest.json',
            metaTransportUrl: null,
            playerPath: '/player/next-episode',
            kind: 'torrent',
            fingerprint: 'torrent:def:1',
            authKey: null,
        },
    });

    const changed = await guest.waitFor('media.changed');
    assert.equal(changed.payload.mediaRevision, 2);
    assert.equal((changed.payload.playback as { paused: boolean; positionMs: number }).paused, true);
    assert.equal((changed.payload.playback as { positionMs: number }).positionMs, 0);
    assert.equal((changed.payload.media as { videoId: string }).videoId, 'tt0903747:1:2');
    assert.equal((changed.payload.source as { fingerprint: string }).fingerprint, 'torrent:def:1');

    const room = harness.server.service.rooms.get(host.roomId as string);
    assert.equal(room?.listParticipants().every((participant) => !participant.ready), true);

    // A command for the previous revision must not resurrect the old episode.
    const stale = await host.request('playback.command', {
        commandId: 'stale-1', action: 'play', expectedRevision: 1, mediaRevision: 1,
    });
    assert.equal(stale.payload.code, 'STALE_MEDIA_REVISION');
});

test('source refresh: the host can rebroadcast an expired source bundle', async (t) => {
    const harness = await startHarness();
    t.after(() => harness.stop());

    const { host, guest } = await startPlayingRoom(harness);
    host.send('source.refresh', {
        source: {
            streamParam: 'refreshed',
            stream: { url: 'https://debrid.example/refreshed' },
            streamTransportUrl: 'https://addon.example/manifest.json',
            metaTransportUrl: null,
            playerPath: '/player/refreshed',
            kind: 'url',
            fingerprint: 'url:refreshed',
            authKey: null,
        },
    });

    const updated = await guest.waitFor('source.updated');
    assert.equal(updated.payload.mediaRevision, 1);
    assert.equal((updated.payload.source as { fingerprint: string }).fingerprint, 'url:refreshed');
    // Refreshing the source must not disturb playback or readiness.
    const room = harness.server.service.rooms.get(host.roomId as string);
    assert.equal(room?.playback.paused, false);
    assert.equal(room?.mediaRevision, 1);
});
