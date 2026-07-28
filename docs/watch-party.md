# Watch parties in this Stremio Web fork

Implements the plan in [`plans/2026-07-27-stremio-web-watch-party.md`](plans/2026-07-27-stremio-web-watch-party.md).

A watch party keeps several people's playback synchronized while each of them
independently retrieves and plays the media through their own Stremio add-ons and
streaming server. Nothing about the video passes through the room service.

Every participant must independently have lawful access to what they are
watching.

## How it fits together

```
Stremio Web (this fork)                     Room service (watch-party-server/)
├── WatchPartyProvider ─── WebSocket ─────► ├── sessions, rooms, host authority
│   connection, room, clock, presence       ├── canonical playback state
├── /watch-party/:roomId join route         ├── revisions and idempotency
└── useWatchPartyPlayer                     └── TTL, rate limits, metrics
    ├── observes stremio-video
    ├── forwards host intents
    ├── blocks guest timeline changes
    └── applies canonical state

Media delivery: unchanged. Each client resolves and plays its own stream.
```

The provider is mounted above the routes in `src/App/App.js`, so the socket, the
room and the clock estimate all survive navigation between the join screen, meta
details and the player.

The player bridge is a single interception point. Every timeline intent — seek
bar, keyboard, gamepad, media keys, video click — already funnels through
`onPlayRequested`, `onPauseRequested`, `commitSeek`, `onPlaybackSpeedChanged` and
`onNextVideoRequested` in `Player.js`, so the party only had to intercept those.

## Authority model

Only the host changes canonical play, pause, seek, rate and media. This is
enforced in three independent places, so a failure in one is not a failure of the
feature:

1. Guest timeline controls are visibly disabled, not silently ignored.
2. `routeTimelineIntent` refuses guest intents before they become commands.
3. The service rejects `playback.command` from a non-host with `NOT_HOST`, so a
   crafted raw WebSocket message changes nothing.

The host is intercepted too. It publishes a command and then follows canonical
state like everyone else, rather than applying the change locally — otherwise it
would start playing a scheduled lead time before every guest.

Volume, mute, subtitles, audio track, fullscreen and video scale stay local and
untouched.

## Synchronization

- Server time is estimated from five ping samples at connect and refreshed every
  30 s, keeping the lowest-round-trip sample. Offsets are measured against
  `performance.now()`, so a wall-clock correction mid-film cannot make playback
  jump.
- Canonical state carries `positionMs` at `effectiveAtServerMs`. Transitions that
  start playback are scheduled ~750 ms ahead so every ready client begins at the
  same server instant instead of on message arrival.
- Correction thresholds (`src/services/WatchParty/drift.js`): under 250 ms do
  nothing; 250–1000 ms monitor only; over 1000 ms hard seek. Soft rate correction
  is implemented and tested but **off by default** until the Phase 0 drift spike
  produces real numbers.
- Ordering comes from revisions, never from arrival time. A replayed or
  out-of-order frame cannot rewind playback, and a duplicate command id is a
  no-op.

## Exact source handoff

The host publishes the raw Stremio context needed to reproduce its player route:
the encoded `stream` parameter, the stream and meta add-on transport URLs, the
media identity, a source fingerprint and the host's player path as a debug
fallback.

The guest rebuilds *its own* player route from those raw parameters. It never
reuses a host-resolved runtime URL, so torrents and raw streams are resolved by
the guest's own local streaming server. A guest that ends up on a different file,
or on a copy whose duration differs by more than two seconds or 0.5%, is reported
as incompatible and never claims to be synchronized.

Two devices signed into the same Stremio account are two participants. The room
has no notion of account identity at all, so they cannot be deduplicated or
merged; the device label is what tells them apart in the interface.

The protocol carries an optional `authKey` field for source flows that need one.
**This fork does not populate it.** The plumbing exists because the plan calls
for it, but sending an account credential by default is a real cost with no
demonstrated benefit yet; wire it up only if a specific debrid or configured
add-on flow proves it necessary.

## Deployment

See [`../watch-party-server/README.md`](../watch-party-server/README.md) for the
service's configuration, endpoints and container. The intended topology is one
TLS origin:

```
https://stremio.example.com/            -> static Stremio Web build
https://stremio.example.com/watch-party/ws -> room service :8787 /v1/ws
```

Same-origin means the client derives `wss://<origin>/watch-party/ws` from
`window.location` with no build-time configuration and no CORS. Override with
`WATCH_PARTY_WS_URL` at build time for development or a split deployment.

Verified against the built container: it runs read-only as a non-root user, its
health check reports healthy, two clients complete a full host/guest flow through
it, a guest command is refused, and no auth key or add-on URL appears in its
logs.

## Trying it locally

```sh
node scripts/watch-party-demo.mjs
```

That starts the room service in Docker, generates a five-minute test clip with a
burnt-in timecode, serves it, and runs the web app in development over plain
HTTP. It prints step-by-step instructions and tears everything down on Ctrl-C.

The clip is generated rather than downloaded on purpose: the demo needs no
Stremio account, no addon and no torrent, so it exercises the synchronization
path and nothing else. It carries an audio tone because browsers only block
autoplay for media with sound — a silent clip would never exercise the
activation overlay.

Two details make it work without friction:

- **Plain HTTP.** The dev server normally serves HTTPS with a self-signed
  certificate, which would mean clicking through a warning in each of two
  browsers. `DEV_SERVER_TYPE=http` overrides that for the demo only.
- **A dev-server WebSocket proxy** at `/watch-party/ws`, mirroring the
  production Caddy mapping. The client therefore derives its endpoint from
  `window.location` in development exactly as it does in production, with no
  build-time configuration and no cross-origin socket.

Ports are `8123` (app), `8787` (service) and `8099` (clip), each overridable via
`WATCH_PARTY_DEMO_*_PORT`. 8080 is deliberately avoided: it is contested enough
that another process binding `127.0.0.1:8080` later can silently shadow a server
already listening on the wildcard address.

To play real content instead, paste any direct video URL into the search bar, or
use your own addons as usual — the watch party button appears on any player.

## What is not done

These are known gaps, not oversights.

**Phase 0 spikes are unresolved.** The plan's four validation spikes need real
browsers, real devices and real Stremio accounts. They have not been run, so the
following remain assumptions rather than evidence:

- whether a single Ready interaction reliably unlocks later scheduled playback in
  Chrome, Firefox and Safari;
- final hard-seek and soft-rate thresholds per player implementation (the current
  values come from the plan, not from measurement);
- exact-source behaviour for expiring or IP-bound debrid links;
- whether the desktop shell should be in MVP.

The implementation is built so these can be settled without redesign: the
thresholds are constants in one pure module, and the activation path is a single
piece of state.

**No two-browser end-to-end tests.** Plan Task 21 needs Playwright, a
deterministic local media fixture and CI wiring. The protocol and room logic are
covered end to end at the WebSocket level with two in-process clients, and the
player bridge is covered against a fake player, but nothing yet drives two real
browsers against a real video.

**No soak test.** Plan Task 23's two-hour run with jitter and reconnect injection
has not been performed.

**Not validated:** Chromecast, the desktop shell, mobile layout, and PWA
install/upgrade across a protocol change. Starting or joining a party while
casting is refused rather than left to behave unpredictably.

**Not implemented, by design for MVP:** host transfer, reactions and chat,
automatic re-resolution of a failed source, and pausing the room for a buffering
guest.

## Tests

```sh
pnpm exec jest          # 215 tests: protocol, reducer, clock, drift, media
                        # identity, client, intents, player adapter
pnpm lint
pnpm build

cd watch-party-server
npm test                # 122 tests: protocol, rooms, synchronization,
                        # authorization, reconnect
npm run typecheck
```

Every synchronization test injects its clock; none sleeps on real time.

CI runs both: the existing `Build` workflow covers the web build, and
`.github/workflows/watch-party-server.yml` typechecks, tests and builds the room
service, then builds its image and verifies the container reports ready. The
service workflow is path-filtered, so web-only changes do not trigger it.

## Upstream and licensing

Stremio Web is GPL-2.0. Distributing this modified client carries the
corresponding source obligations.

The changes are kept modular to keep an upstream proposal possible: no
`stremio-core` changes, no room state in the Stremio profile, one new provider,
one new route, one new player hook, and small edits to `App.js`, `Player.js`,
`ControlBar.js` and the router. The room service is self-contained and can be
split out with `git subtree split --prefix=watch-party-server`.
