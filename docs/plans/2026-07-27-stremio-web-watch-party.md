# Stremio Web Watch Party Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add host-authoritative, low-latency watch parties to a maintained Stremio Web fork while each participant independently retrieves and plays the media.

**Architecture:** A persistent React watch-party provider connects the Stremio Web client to a separate WebSocket room service. The provider owns room, presence, clock and connection state; a narrow player adapter observes and controls the existing `stremio-video` abstraction. The server stores ephemeral authoritative room/playback state but never proxies media.

**Tech Stack:** Existing React 18/Stremio Web stack; browser `WebSocket`; Node.js 22 + TypeScript + `ws` + schema validation for the room service; Jest for client unit tests; Vitest or Node test runner for the server; Playwright for two-browser end-to-end tests; Docker and Caddy/Nginx for deployment.

---

## 1. Research verdict

This is feasible in Stremio Web without changing `stremio-core` or the Stremio add-on protocol.

The correct implementation seam is the existing `@stremio/stremio-video` abstraction, not the DOM `<video>` element and not the Stremio Addon SDK. A normal add-on can return catalogs, metadata, streams and subtitles, but it cannot observe or issue play/pause/seek commands. A client modification can.

The recommended product is therefore:

1. A maintained fork of Stremio Web.
2. A small real-time room service.
3. An optional launcher add-on only after the native client feature works; such an add-on could expose an `externalUrl`, but it would not perform synchronization.

Research fork:

- `https://github.com/ethancowardorion/stremio-web`
- Upstream: `https://github.com/Stremio/stremio-web`
- Research branch: `research/watch-party-plan`
- Upstream baseline inspected: `development` at `70532d627394045ce750776a6086e64deb0b020e`

No production feature code has been written as part of this research phase.

## 2. Evidence from the current codebase

### 2.1 Player observation and control already exist

`src/routes/Player/useVideo.js` wraps `@stremio/stremio-video` and exposes the required state and commands:

- State: `loaded`, `paused`, `time`, `duration`, `buffering`, `buffered`, `playbackSpeed`, `stream`.
- Commands: `setPaused`, `setTime`, `setPlaybackSpeed`.
- Events: `propChanged`, `ended`, `implementationChanged`.

Relevant code:

- `src/routes/Player/useVideo.js:13-44` — local observed state.
- `src/routes/Player/useVideo.js:46-57` — dispatch into the selected player implementation.
- `src/routes/Player/useVideo.js:95-117` — pause, time and playback-rate setters.
- `src/routes/Player/useVideo.js:198-224` — observation of player implementation properties.

The time unit is integer milliseconds throughout `stremio-video`. The watch-party protocol must use milliseconds as well.

The current `stremio-video` implementations expose these properties across HTML video, desktop shell/mpv, Chromecast sender, YouTube and supported TV implementations. That makes the abstraction substantially safer than manipulating an HTML media element directly.

### 2.2 Player integration points are concentrated in `Player.js`

`src/routes/Player/Player.js` already centralizes all meaningful playback intents:

- `onPlayRequested` at approximately `Player.js:240`.
- `onPauseRequested` at approximately `Player.js:248`.
- `commitSeek` at approximately `Player.js:265`.
- `onNextVideoRequested` at approximately `Player.js:352`.
- Core/library time and pause updates at approximately `Player.js:533-543`.
- Video loading at approximately `Player.js:492-531`.
- Keyboard, gamepad, media-session and shell media-key handlers all eventually call the same intent functions.
- The player UI and `ControlBar` are assembled at approximately `Player.js:940-1132`.

This means a watch-party bridge can intercept a small number of intent functions instead of patching every control individually. Remote commands must call the underlying `video` setters directly, while local user intents pass through authority checks and the room service. This separation prevents command echo loops.

### 2.3 The provider can persist across route transitions

`src/App/App.js` owns the long-lived provider tree and renders `ProtectedRoutes`. A `WatchPartyProvider` should be mounted above `ProtectedRoutes`, beside the existing `DiscordProvider`, so that WebSocket and room state survive transitions between join, details and player routes.

Stremio uses a `HashRouter` in `src/index.js:44-56`. Routes are declared in `src/router/routerPaths.tsx`; the player route is:

```text
/player/:stream/:streamTransportUrl?/:metaTransportUrl?/:type?/:id?/:videoId?
```

A dedicated invitation route such as `/watch-party/:roomId` is appropriate. It can join the room, perform source negotiation, and navigate to the locally constructed player route.

### 2.4 Media identity is available, but source handoff is the main product risk

`src/core/types/models/Player.d.ts` exposes:

- selected stream;
- stream request and metadata request;
- media `type`, metadata ID and video/episode ID;
- next-video deep links.

`src/core/types/Stream.d.ts` includes direct URLs, YouTube IDs, torrent `infoHash` and `fileIdx`.

The current player URL contains an encoded stream and can also contain add-on transport URLs. Sharing the complete player URL blindly is unsafe because a configured add-on URL may embed user-specific credentials. The implementation must never send `profile.auth.key`, and it must not assume that every transport URL is safe to disclose.

Source negotiation therefore needs its own spike and must be treated independently from playback synchronization.

### 2.5 Existing build and test baseline

The research checkout was installed with Node `v22.22.3` and pnpm `11.8.0`.

Verified baseline:

- `pnpm exec jest --runInBand` — 3 suites, 70 tests passed.
- `pnpm lint` — passed.
- `pnpm build` — passed with the upstream bundle-size warnings only.

The current repository has no browser end-to-end suite and only a small Jest unit-test surface. Watch-party work needs substantially stronger isolated and multi-client tests.

## 3. Existing precedent: Peario

Stremio previously pointed users requesting watch parties to Peario:

- `https://github.com/Stremio/stremio-features/issues/151`
- Related requests: issues `26`, `278` and `1020` in `Stremio/stremio-features`.

Open-source Peario components still exist:

- `https://github.com/tymmesyde/peario-client`
- `https://github.com/tymmesyde/peario-server`
- `https://github.com/tymmesyde/peario-stremio-addon`

Peario validates the broad architecture: a Stremio launcher add-on, a browser player and a WebSocket room server. Its owner sends a player snapshot every second, and guests hard-seek when drift exceeds one second.

It should not be copied as the production design. Its public implementation lacks protocol versioning, clock-offset estimation, sequence/revision checks, robust reconnect/resume, input validation and meaningful authorization. It also reimplements the player outside Stremio, which loses the compatibility already present in `stremio-video`. The new design should retain Stremio Web's player and improve the synchronization protocol.

## 4. Architecture decision

### Chosen: native feature in a Stremio Web fork

Advantages:

- Uses all current Stremio stream resolution and `stremio-video` implementations.
- Can observe buffering, time, pause and playback rate through a stable internal abstraction.
- Can integrate room state and authority into every input path.
- Can eventually be proposed upstream if the feature proves maintainable.

Costs:

- The fork must track upstream `development`.
- GPL-2.0 source obligations apply when distributing the modified client.
- Official mobile/Android-native clients are not covered.

### Rejected as primary approach: browser extension

A browser extension would depend on DOM or bundled React internals, would not naturally run in the desktop shell, and would be more sensitive to upstream UI changes. It may be useful as an experiment, but it is a weak production architecture.

### Rejected as primary approach: separate player website

This repeats Peario's largest limitation: stream/player compatibility must be rebuilt outside Stremio. It also creates a separate subtitle/audio/player UX and complicates protected streams.

### Rejected: add-on-only synchronization

The Addon SDK has no playback event or control surface. An add-on may later act as a launcher by returning an `externalUrl`, but it cannot own synchronization.

### Upstream strategy

Assume a maintained fork initially. Historical Stremio responses described the feature as out of scope/manpower-heavy. Keep the implementation modular, avoid `stremio-core` changes, document the protocol and build a strong test suite so that an upstream proposal remains possible later.

## 5. Scope

### MVP

- Desktop Stremio Web in current Chrome, Chromium and Firefox.
- Host creates a room from an active player.
- Guest joins through an opaque invitation URL or typed room code.
- Host is the only participant allowed to play, pause, seek or advance episodes while guests follow.
- Presence and per-user ready/buffering indicators.
- Event-driven play/pause/seek plus periodic authoritative snapshots.
- Reconnect and resume within a grace period.
- Hard-seek drift correction.
- Safe torrent source handoff (`infoHash` + `fileIdx`) and manual source selection fallback.
- Ephemeral rooms, in memory, on one server process.
- Docker deployment behind TLS.

### Phase 2

- Soft drift correction with temporary playback-rate changes.
- Safe local re-resolution and automatic matching of direct/debrid streams.
- Host transfer.
- Optional “pause for participant buffering” policy.
- Reactions and minimal chat.
- Better mobile/PWA layout.
- Chromecast and desktop shell validation.

### Explicitly out of scope initially

- Relaying, proxying or redistributing video.
- Voice/video chat.
- Permanent room history.
- Stremio account authentication or sending Stremio auth keys to the room service.
- Android-native, iOS-native and TV-native Stremio clients.
- Arbitrary external players.
- Multi-region/high-availability deployment.
- DRM license sharing.

## 6. User experience

### 6.1 Create room

1. Host starts a stream normally.
2. Host opens the watch-party control in the player.
3. Client pauses playback and captures media identity, safe source identity and current position.
4. Client creates a room and receives an opaque invitation URL plus optional human-readable code.
5. Host sees participant readiness and can copy the invitation.
6. Host cannot start synchronized playback until its own player is loaded and ready. Whether to require all guests to be ready is a room policy.

### 6.2 Join room

1. Guest opens `/#/watch-party/{roomId}`.
2. Client connects, performs protocol/version negotiation and joins using the bearer invitation secret.
3. Join route shows title, host, participant list and source compatibility.
4. Client obtains the same stream safely or asks the guest to choose a source.
5. Player loads with party autoplay disabled and seeks to the authoritative position.
6. Guest clicks **Ready**. That click is also used to satisfy browser media-activation requirements.
7. On host start, all ready clients schedule playback against server time.

### 6.3 During playback

- Host controls behave normally and publish authoritative commands.
- Guest play, pause, seek and next-video controls are visibly disabled while following.
- Volume, mute, subtitles, audio track, fullscreen and video scale remain local.
- A guest can leave the room rather than silently diverging.
- Connection state and excessive drift are visible but not intrusive.

### 6.4 Episode change

1. Host's next-video action first resolves the new media identity and pauses room state.
2. Server increments `mediaRevision` and broadcasts `media.changed`.
3. Guests navigate/load independently.
4. Ready barrier resets for the new episode.
5. Host starts after the desired readiness policy is met.

## 7. Component responsibilities

```text
Stremio Web
├── WatchPartyProvider (connection, room, clock, presence, commands)
├── WatchParty join route and room UI
└── Player adapter
    ├── observes stremio-video state
    ├── forwards host intents
    ├── blocks guest-controlled timeline changes
    └── applies authoritative remote state

Room service
├── WebSocket connection/session management
├── room membership and host authorization
├── authoritative media/playback state
├── sequence/revision validation
├── clock responses and scheduled transitions
├── TTL/rate limits/input validation
└── health/metrics/log redaction

Media delivery
└── remains Stremio/add-on/streaming-server responsibility per client
```

The room service must never receive Stremio account keys and must not proxy video bytes.

## 8. Protocol design

### 8.1 Transport

Use secure WebSockets in production. Prefer the browser's native `WebSocket` and a small Node service using `ws`. Socket.IO is not required: the protocol needs explicit revisions, resumable sessions and validation regardless, and native WebSockets avoid coupling the client and server to another framing protocol.

Expose:

- `GET /healthz`
- `GET /readyz`
- `GET /metrics` on an internal/admin listener or protected path
- `GET /v1/ws` with WebSocket upgrade

Every envelope must contain:

```json
{
  "v": 1,
  "type": "playback.command",
  "requestId": "01J...",
  "roomId": "...",
  "payload": {}
}
```

Rules:

- Validate every incoming message and reject unknown fields where practical.
- Cap message size, display-name length and event frequency.
- Use monotonically increasing server room revisions.
- Make command IDs idempotent for reconnect/retry.
- Never trust client timestamps as server time.
- Return structured error codes rather than free-form protocol errors.

The initial `session.hello` must also advertise player capabilities rather than assuming every Stremio target behaves identically:

```json
{
  "protocolVersion": 1,
  "clientVersion": "...",
  "capabilities": {
    "scheduledActions": true,
    "observeBuffering": true,
    "setPlaybackRate": true,
    "navigateNext": true,
    "playerImplementation": "HTMLVideo"
  }
}
```

The server includes negotiated room requirements in `session.welcome`. A client that lacks a required capability may join only as unsupported/observer; it must not claim to be synchronized. This is particularly important for shell, cast, YouTube and future TV player implementations.

### 8.2 Core client messages

- `session.hello` — protocol/client version and optional resume token.
- `clock.ping` — timestamp sample nonce.
- `room.create` — display name, initial media and initial player observation.
- `room.join` — room ID, invitation secret and display name.
- `room.leave`.
- `participant.ready` — ready, loaded, buffering, duration and media revision.
- `playback.command` — host play/pause/seek/rate command with expected revision.
- `playback.observation` — sampled player state; authoritative only when sent by host.
- `media.change` — host requests a new movie/episode/source.
- `host.transfer` — later phase.

### 8.3 Core server messages

- `session.welcome` — session ID, resume token, supported protocol and server time.
- `clock.pong` — echoed nonce plus server receive/send timestamps.
- `room.snapshot` — complete current room state.
- `room.updated` — membership/policy changes.
- `participant.updated`.
- `playback.state` — new canonical state and room revision.
- `media.changed` — canonical media descriptor and new media revision.
- `error` — machine-readable code and matching request ID.

### 8.4 Canonical playback state

```json
{
  "revision": 184,
  "mediaRevision": 3,
  "paused": false,
  "positionMs": 1432800,
  "rate": 1,
  "updatedAtServerMs": 1785181325000,
  "effectiveAtServerMs": 1785181325750
}
```

`positionMs` is the media position at `updatedAtServerMs`. While playing, expected position is:

```text
positionMs + (serverNowMs - updatedAtServerMs) * rate
```

Clamp positions to `[0, durationMs]` when duration is known.

### 8.5 Room state

Store:

- opaque room ID and separate invitation secret;
- host participant ID;
- creation/expiry times;
- room and media revisions;
- media descriptor and source fingerprint;
- canonical playback state;
- participant readiness/buffering/connection state;
- room policy;
- recently applied command IDs for idempotency.

Do not persist raw direct-stream or configured add-on URLs in logs. In-memory room data expires automatically.

## 9. Synchronization algorithm

### 9.1 Clock estimate

At connect, collect five ping samples and choose the lowest-RTT sample for the initial server offset. Refresh periodically, for example every 30 seconds, and after reconnect. Track uncertainty as half the selected RTT.

Use `performance.now()` for local elapsed-time calculations and map scheduled server timestamps through the current offset estimate. Wall-clock jumps must not cause local playback jumps.

### 9.2 Event handling

- Host **play**: publish current position and a start time roughly 500-1000 ms in the future.
- Host **pause**: publish measured position immediately; guests pause and then align.
- Host **seek**: publish target position, paused/running state and scheduled effective time.
- Periodic host observation: every two seconds while playing and on important state changes.
- Server snapshot: sent on join/reconnect and when a stale revision is detected.

Guests only apply a message when both room revision and media revision are newer/compatible. Old packets must never rewind playback.

### 9.3 Drift correction

Initial safe policy:

- Absolute drift below 250 ms: do nothing.
- 250-1000 ms: initially do nothing until soft correction is implemented; monitor it.
- Above 1000 ms, or after an explicit seek: hard seek to canonical position.
- On reconnect or media load: hard align before becoming ready.

Phase 2 soft correction:

- For moderate drift, temporarily use `baseRate * 0.95` or `baseRate * 1.05`.
- Restore the authoritative/user base rate when drift is below 150-250 ms or after a timeout.
- Never let correction overwrite the host-selected playback rate.
- Disable soft correction for implementations that fail the playback-rate capability spike.

Do not chase every `timeupdate`; shell implementations may report time only once per second.

### 9.4 Feedback-loop prevention

Keep local intent and remote application as separate APIs:

```text
requestPlay/requestPause/requestSeek
    -> authority check
    -> host sends command; guest is blocked

applyRemoteState
    -> direct video.setPaused/setTime/setPlaybackSpeed
    -> does not publish a new command
```

Observed state still flows into Stremio core for library/progress tracking. A short-lived suppression flag may be used for telemetry deduplication, but correctness must rely on command IDs/revisions rather than timing alone.

## 10. Buffering and readiness policy

Buffering signals are noisy and a malicious/slow guest must not be able to lock the room indefinitely.

MVP policy:

- Show each participant's `loading`, `ready` and `buffering` state.
- Require the host to be ready.
- Let the host choose whether to wait for all guests before the first start.
- Do not automatically pause the entire room for every guest buffer event.
- A rebuffering guest catches up through normal drift correction when playback resumes locally.

Later optional policy:

- “Pause for buffering participants” with debounce (for example, buffering continuously for >1.5 seconds), a maximum pause timeout, and host override.
- Server records the participant responsible for the pause.

## 11. Media/source identity and safe handoff

This is the largest unresolved implementation risk and must be spiked before production work.

### 11.1 Media identity

Use:

- metadata `type`;
- metadata ID;
- video/episode ID;
- expected duration when known;
- `mediaRevision`.

### 11.2 Source fingerprint

Preferred fingerprints:

1. Torrent: lowercase `infoHash` + numeric `fileIdx`.
2. YouTube: `ytId`.
3. Direct URL: a client-generated fingerprint over a carefully normalized URL, without sending the URL merely to compare it.
4. Unknown source: explicit `unknown`, requiring manual confirmation.

A matching movie/episode does not guarantee the same timeline. Different cuts, intros and frame rates can diverge. Compare duration and warn or refuse auto-follow when duration differs beyond a tolerance such as two seconds or 0.5%, whichever is larger.

### 11.3 Handoff modes

Implement in this order:

1. **Safe torrent handoff:** send only `infoHash`/`fileIdx` plus media metadata. Each client uses its own Stremio streaming service.
2. **Manual local source selection:** guest opens the correct title/episode and chooses a source; synchronization activates after media identity and duration checks.
3. **Local automatic re-resolution:** query streams through the guest's installed add-ons and match a safe fingerprint.
4. **Exact direct-stream sharing, opt-in:** only after threat review; never send configured add-on transport URLs or Stremio auth keys. Warn that signed/debrid URLs may be bearer credentials.

Do not serialize and share the host's full `/player/...` path by default. It may contain encoded add-on configuration or user-specific URLs.

## 12. Browser, player and platform constraints

### Autoplay

Browsers may reject remote `play()` with audio until the guest interacts with the page. The join/ready action must deliberately unlock playback and provide a fallback “Click to begin synchronized playback” overlay when `play()` is rejected.

The current player loads with `autoplay: true` in `Player.js`. Party participants must load paused or have autoplay suppressed until the ready barrier completes.

### Casting and external devices

Although Chromecast exposes many player properties, timing and command latency differ substantially. Desktop `PlayingOnDevice` also pauses the local player and may not provide a complete remote timeline.

MVP must disable starting/joining a party while casting or playing on an external device. Add adapter-specific support only after dedicated tests.

### Live streams

Live media has no stable finite timeline and may expose null duration. Exclude live streams from MVP.

### Different playback rates

Playback rate is part of canonical room state. Guest-local rate changes are disabled while following. Subtitle/audio/volume settings remain local.

## 13. Security and privacy

- Invitation URL is a bearer credential. Use at least 128 bits of random secret in the URL.
- If a short human code is provided, keep it separate from the room ID, use enough entropy, rate-limit guesses and expire it.
- Generate separate participant resume tokens and host capability tokens.
- Do not use a Stremio auth key as room authentication.
- Do not expose `profile.auth.key` or add-on configuration URLs.
- Allowlist production web origins during WebSocket upgrade.
- Enforce TLS/WSS, message-size limits, room-size limits and per-IP/session rate limits.
- Start with explicit conservative limits and tune from metrics: 32 KiB maximum message size, 20 participants per room, status updates at 2/s sustained with burst 5, host commands at 2/s sustained with burst 10, and clock pings at 1/s. Rate-limited messages must never mutate canonical state.
- Escape display names/chat; never render user strings as HTML.
- Redact stream URLs, invite secrets and tokens from logs, Sentry and analytics.
- Keep rooms ephemeral with a bounded lifetime and idle TTL.
- Close connections on repeated invalid messages.
- Return generic errors for room lookup failures to reduce code enumeration.
- Document that every participant must independently have lawful access to the media.

## 14. Failure modes

| Failure | Required behavior |
|---|---|
| Guest loses WebSocket | Continue or pause locally according to policy; show disconnected; reconnect with backoff and resume token |
| Host disconnects | Freeze canonical position and pause room after short grace period; allow host resume; later permit host transfer |
| Stale/out-of-order command | Ignore by revision and request ID |
| Client joins during playback | Load paused, hard-align, become ready, then join at a scheduled boundary |
| Guest source differs | Warn/block automatic following based on fingerprint/duration |
| Browser rejects play | Show explicit activation overlay; do not claim the guest is synchronized |
| Guest buffers | Mark unsynchronized/buffering; catch up when playable; no automatic room lock in MVP |
| Server restarts | MVP rooms expire; clients receive room-lost and can create a new room |
| Protocol mismatch | Reject with minimum/supported versions and a clear upgrade message |
| New episode fails for one guest | Keep that guest unready; do not report synchronized |
| Duplicate command after reconnect | Deduplicate using command ID |
| Clock uncertainty is high | Increase scheduled lead time and prefer hard alignment |
| Service worker serves old client | Handshake version detects incompatibility; deployment keeps at least one compatible protocol version |

## 15. Backend design and deployment

### 15.1 Initial service

Create a separate repository, proposed name:

```text
ethancowardorion/stremio-watch-party-server
```

Suggested layout:

```text
src/
  index.ts
  config.ts
  protocol/
    envelopes.ts
    schemas.ts
    errors.ts
  rooms/
    Room.ts
    RoomStore.ts
    RoomPolicy.ts
  sessions/
    Session.ts
    ResumeToken.ts
  sync/
    canonicalPosition.ts
    commands.ts
  ws/
    upgrade.ts
    connection.ts
    handlers.ts
  observability/
    logger.ts
    metrics.ts
tests/
  protocol.test.ts
  room-store.test.ts
  authorization.test.ts
  synchronization.test.ts
  reconnect.test.ts
Dockerfile
compose.example.yml
README.md
```

Use one process and an in-memory `Map` for MVP. Add Redis only when multiple service instances or restart persistence are actually required. If Redis is introduced, use it for room state plus pub/sub and keep command updates atomic by revision.

This is a deliberate MVP decision rather than an unexamined omission. Rooms are ephemeral, and silently restoring a stale room after a media/service restart can be worse than ending it. If restart survival becomes a requirement, add SQLite as the first persistence adapter: persist the latest room snapshot plus a bounded authoritative-event ring, then prove that reconstruction preserves sequence/idempotency invariants. Do not add SQLite merely because hosting capacity is available.

### 15.2 Production topology

```text
Internet :443
    -> Caddy/Nginx
       -> static Stremio Web build
       -> /watch-party/ws -> party service :8787
       -> /watch-party/healthz -> party service :8787
```

Same-origin reverse proxying avoids unnecessary CORS complexity. HTTPS pages must use WSS.

Deployment requirements:

- Docker image runs as non-root.
- Read-only filesystem where practical.
- Environment variables for origin allowlist, TTL, room limit, log level and trusted proxy settings.
- Health check and graceful shutdown.
- Structured logs with secret redaction.
- Prometheus counters/gauges: connections, rooms, joins, reconnects, invalid messages, command latency and drift buckets.
- No media URLs or message payload dumps in production logs.

### 15.3 Client configuration

Modify `webpack.config.js` to inject a `WATCH_PARTY_WS_URL` default. In production, prefer deriving `wss://<current-origin>/watch-party/ws` when no explicit URL is configured.

The existing PWA service worker uses content-hashed assets and `skipWaiting`, but protocol compatibility must still be maintained during deployment.

### 15.4 Hosted-fork compatibility checks

The current `http_server.js` is only an Express static server. It does not set CSP, HSTS, compression or reverse-proxy behavior. Production security headers and WebSocket proxying belong at Caddy/Nginx initially.

Before making the hosted fork the user-facing deployment, verify all of the following from the final HTTPS origin:

- Stremio username/password and social-login flows. Apple and Facebook login helpers currently interact with hard-coded `https://www.strem.io` endpoints, so origin/CORS behavior must be tested rather than assumed.
- Add-on catalog and stream requests across the set of real add-on origins.
- Playback through the default local Stremio streaming server at `http://127.0.0.1:11470/`. HTTPS-to-loopback mixed-content handling differs by browser and must be checked in Chrome, Firefox and Safari.
- The core Web Worker at `/<COMMIT_HASH>/scripts/worker.js`, WASM loading, Chromecast's external script and Apple login's external script.
- PWA installation, service-worker registration and upgrade from one protocol-compatible build to the next.

If introducing CSP, deploy `Content-Security-Policy-Report-Only` first. The eventual policy must account for the core worker/WASM, Stremio APIs, arbitrary user-installed add-on origins, localhost/remote streaming servers, media/blob/data sources, Chromecast, Apple login and the watch-party WSS endpoint. A narrow static allowlist is unlikely to work without empirical violation data.

## 16. Client change map

Proposed new domain module:

```text
src/services/WatchParty/
  index.js
  WatchPartyContext.js
  WatchPartyProvider.js
  WatchPartyClient.js
  protocol.js
  reducer.js
  clock.js
  drift.js
  mediaIdentity.js
  storage.js
```

Proposed UI:

```text
src/routes/WatchParty/
  index.js
  WatchParty.js
  styles.less
src/routes/Player/WatchPartyMenu/
  index.js
  WatchPartyMenu.js
  styles.less
src/routes/Player/useWatchPartyPlayer.js
```

Expected existing modifications:

- `src/App/App.js` — mount `WatchPartyProvider` above routes and render global connection/error UI.
- `src/routes/index.js` — export the join route.
- `src/router/routerPaths.tsx` — add `/watch-party/:roomId`.
- `src/common/routesRegexp.js` and `tests/routesRegexp.spec.js` — only if regexp-based consumers need to recognize the route.
- `src/routes/Player/Player.js` — connect player state/intents to the adapter; suppress party autoplay; gate host/guest controls; synchronize episode changes.
- `src/routes/Player/ControlBar/ControlBar.js` and styles — party button and explicit disabled timeline controls.
- `src/routes/Player/useVideo.js` — only if a stable event subscription or capability helper is missing; avoid exposing raw internals globally.
- `src/index.js` — merge fork-local watch-party translation strings until/unless they are accepted into `stremio-translations`.
- `webpack.config.js` — endpoint/build configuration.
- `package.json` — test tooling only if needed; prefer native WebSocket and no large runtime dependency.

Do not put room state into `stremio-core` or Stremio profile settings for MVP.

New JSX copy must go through translations: `tests/i18nScan.test.js` rejects hard-coded interface strings. If `stremio://watch-party/...` links are added later, also update `src/App/DeepLinkHandler.js`/the shell deep-link handling; the initial HTTPS hash invitation does not require that change.

## 17. Test strategy

### 17.1 Pure client unit tests

Add Jest tests for:

- protocol envelope validation;
- reducer revision ordering and idempotency;
- clock offset selection under asymmetric/high latency;
- canonical position calculation;
- hard/soft drift decisions;
- source fingerprinting and redaction;
- reconnect backoff;
- media/duration compatibility;
- host versus guest authority.

Suggested files:

```text
tests/watchPartyProtocol.spec.js
tests/watchPartyReducer.spec.js
tests/watchPartyClock.spec.js
tests/watchPartyDrift.spec.js
tests/watchPartyMediaIdentity.spec.js
```

Use injected clocks and fake timers. No synchronization test should depend on real wall-clock sleeps.

### 17.2 Player adapter tests

Build a fake video adapter exposing the same state/setter shape as `useVideo`. Verify:

- host play emits one command;
- guest play intent is blocked;
- remote play/seek applies locally without echo;
- stale remote states are ignored;
- local volume/subtitle controls remain enabled;
- player load is paused until ready;
- autoplay rejection produces activation-required state;
- unmount removes listeners/timers.

### 17.3 Server tests

Use an in-process WebSocket server and multiple clients with injected clocks:

- only host can mutate playback;
- command revisions are monotonic;
- duplicate command IDs are harmless;
- reconnect returns a current snapshot;
- resume token cannot take over another participant;
- room and invitation secrets are distinct;
- host disconnect pauses after grace period;
- room TTL cleanup works;
- rate and size limits work;
- invalid payloads never crash the process.

### 17.4 Two-browser end-to-end tests

Add Playwright in a later task with two browser contexts and a deterministic local media fixture. Do not depend on a public torrent or third-party add-on for CI.

Scenarios:

1. Host creates room; guest joins and becomes ready.
2. Play/pause arrives within latency budget.
3. Host seek aligns guest within tolerance.
4. Guest timeline controls cannot alter canonical state.
5. Guest reconnects and catches up.
6. Guest joins mid-playback.
7. New episode/media revision resets readiness.
8. Artificial 200 ms latency and jitter do not cause oscillation.
9. Browser autoplay rejection is recoverable.
10. Source mismatch is clearly reported.

### 17.5 Manual platform matrix

- Chrome/Chromium desktop with direct HTTP/HLS stream.
- Firefox desktop.
- Torrent through local Stremio Service.
- Desktop shell/mpv if the fork can be loaded there.
- Chromecast only after MVP.
- PWA install/update behavior.
- Hosted-origin authentication, add-on CORS, and HTTPS-to-`127.0.0.1:11470` streaming-server behavior.

## 18. Implementation phases and tasks

The following tasks are intentionally ordered so that the highest-risk assumptions are tested before feature code grows.

### Phase 0: disposable validation spikes

#### Task 1: Validate the player-control bridge

**Objective:** Prove that observed `paused/time/buffering` state and remote `setPaused/setTime` work through the existing abstraction without feedback loops.

**Files:**

- Create: `spikes/001-watch-party-player-bridge/README.md`
- Create disposable code only under that spike directory.

**Steps:**

1. Add a fake room event source to a disposable local player harness.
2. Exercise play, pause and seek through `useVideo`, not direct DOM access.
3. Verify HTMLVideo and shell capability manifests expose required properties.
4. Record timing, event ordering and echo behavior.
5. Mark `VALIDATED`, `PARTIAL` or `INVALIDATED` and delete/disregard spike code before production implementation.

#### Task 2: Validate source handoff and secret boundaries

**Objective:** Determine the safest workable handoff for torrent, public direct and configured/debrid streams.

**Files:**

- Create: `spikes/002-watch-party-source-handoff/README.md`

**Steps:**

1. Capture decoded stream and route structures for representative sources.
2. Identify credentials or user-specific configuration in every field.
3. Prove a second profile/browser can load `infoHash/fileIdx` without host transport URLs.
4. Test manual and automatic local source matching.
5. Define the exact allowlist/denylist and document unsupported source types.

Stop implementation if safe handoff cannot support the intended real-world source set.

#### Task 3: Validate browser activation and scheduled playback

**Objective:** Prove a guest can click Ready once and later respond to a synchronized remote play command.

**Files:**

- Create: `spikes/003-watch-party-autoplay/README.md`

**Steps:**

1. Run two real browser contexts against a local media fixture.
2. Test Chrome and Firefox with sound enabled.
3. Test play scheduled against estimated server time.
4. Record fallback behavior when `play()` rejects.
5. Establish the required ready/unlock UX.

#### Task 4: Validate drift policy under network impairment

**Objective:** Select correction thresholds from evidence rather than guesswork.

**Files:**

- Create: `spikes/004-watch-party-drift/README.md`

**Steps:**

1. Inject latency, jitter, packet reordering and reconnects.
2. Measure natural drift for HTMLVideo and shell/mpv.
3. Compare hard-seek-only and temporary-rate correction.
4. Record thresholds that avoid visible oscillation.
5. Produce a recommendation table by player implementation.

### Phase 1: protocol and room service

#### Task 5: Create the server repository and verification baseline

**Objective:** Establish a separate tested TypeScript service with Docker support.

**Files:** Create the server layout from section 15.1.

**Verification:** Lint, typecheck, unit test and container health check must pass before networking logic is added.

**Commit:** `chore: scaffold watch party room service`

#### Task 6: Define protocol schemas first

**Objective:** Create versioned, validated client/server envelopes and error codes.

**TDD:** Write rejection tests for malformed, oversized, unknown-version and unknown-type messages before implementing schemas.

**Commit:** `feat: define versioned watch party protocol`

#### Task 7: Implement canonical playback calculations

**Objective:** Provide pure functions for expected position, command application and clamping.

**TDD:** Test paused/running state, rates, duration bounds, stale revisions and duplicate IDs.

**Commit:** `feat: add canonical playback state`

#### Task 8: Implement ephemeral room and session stores

**Objective:** Create/join/leave/resume rooms with host capability and TTL.

**TDD:** Cover invite secrecy, room limits, resume ownership, host grace and expiry.

**Commit:** `feat: add ephemeral room lifecycle`

#### Task 9: Add WebSocket handlers

**Objective:** Connect validated protocol messages to sessions and room state.

**TDD:** Use two in-process clients; prove guest commands are rejected and host commands are broadcast exactly once.

**Commit:** `feat: expose watch party websocket service`

#### Task 10: Add health, metrics, limits and graceful shutdown

**Objective:** Make the service deployable and diagnosable without logging secrets.

**TDD:** Verify health state, rate limits, max payload, cleanup and log redaction.

**Commit:** `feat: harden watch party service operations`

### Phase 2: client connection and room state

#### Task 11: Add pure client protocol, reducer and clock modules

**Objective:** Parse messages and maintain authoritative room state independently of React.

**Files:**

- Create: `src/services/WatchParty/protocol.js`
- Create: `src/services/WatchParty/reducer.js`
- Create: `src/services/WatchParty/clock.js`
- Tests: corresponding `tests/watchParty*.spec.js` files.

**TDD:** Verify malformed-message rejection, revision ordering, snapshots and lowest-RTT clock selection.

**Commit:** `feat: add watch party client state core`

#### Task 12: Add reconnecting WebSocket client

**Objective:** Provide connect, request/ack, heartbeat, backoff, resume and clean teardown.

**Files:**

- Create: `src/services/WatchParty/WatchPartyClient.js`
- Create: `src/services/WatchParty/storage.js`
- Test with a fake WebSocket implementation.

**Commit:** `feat: add resumable watch party connection`

#### Task 13: Add persistent React provider

**Objective:** Expose room actions/state across route transitions.

**Files:**

- Create context/provider/index files under `src/services/WatchParty/`.
- Modify: `src/App/App.js`.

**TDD:** Render provider with a fake client and verify create/join/leave/reconnect transitions and cleanup under React Strict Mode.

**Commit:** `feat: provide watch party state to the app`

#### Task 14: Add join route and invitation UX

**Objective:** Join by opaque URL, collect display name, show compatibility/readiness and handle errors.

**Files:**

- Create: `src/routes/WatchParty/*`.
- Modify: `src/routes/index.js`.
- Modify: `src/router/routerPaths.tsx`.
- Modify regexp/test files only if required.

**TDD:** Route tests cover valid, expired, incompatible and rate-limited invitations.

**Commit:** `feat: add watch party invitation route`

### Phase 3: player integration

#### Task 15: Build a pure drift and authority layer

**Objective:** Decide whether to ignore, seek or rate-correct without touching React/player code.

**Files:**

- Create: `src/services/WatchParty/drift.js`.
- Test: `tests/watchPartyDrift.spec.js`.

**TDD:** Boundary tests for every threshold, base rates, null state and stale media revisions.

**Commit:** `feat: add watch party drift decisions`

#### Task 16: Build the player adapter

**Objective:** Translate player observations/intents to room commands and apply remote state without echo.

**Files:**

- Create: `src/routes/Player/useWatchPartyPlayer.js`.
- Add fake-player tests.

**TDD:** Host and guest authority, remote seek/play, no echo, teardown and reconnect alignment.

**Commit:** `feat: bridge watch party state to player`

#### Task 17: Integrate player loading and controls

**Objective:** Disable party autoplay, wire centralized intents and preserve local-only controls.

**Files:**

- Modify: `src/routes/Player/Player.js`.
- Modify: `src/routes/Player/ControlBar/ControlBar.js`.
- Modify relevant styles.

**TDD:** Guest timeline input paths are blocked across buttons, video click, keyboard, gamepad and media keys; host input emits one command; volume/subtitle/audio remain local.

**Commit:** `feat: synchronize player timeline controls`

#### Task 18: Add party menu, presence and ready state

**Objective:** Let hosts create/share/end rooms and participants inspect connection/readiness.

**Files:** Create `src/routes/Player/WatchPartyMenu/*`; wire through `Player.js` and `ControlBar.js`.

**TDD:** UI states for disconnected, creating, waiting, ready, buffering, reconnecting and ended.

**Commit:** `feat: add in-player watch party controls`

#### Task 19: Implement safe source negotiation

**Objective:** Support the source modes validated in Phase 0, starting with torrent handoff and manual fallback.

**Files:**

- Create: `src/services/WatchParty/mediaIdentity.js`.
- Modify provider, join route and player adapter.

**TDD:** No serialized output contains auth keys/configured transport URLs; mismatch/duration tests fail closed.

**Commit:** `feat: negotiate safe watch party media sources`

#### Task 20: Synchronize media/episode transitions

**Objective:** Reset readiness and move all participants to the host's next media revision.

**Files:** Modify `Player.js`, provider and protocol handlers.

**TDD:** Duplicate/stale next-video messages do not navigate twice; guest load failure remains visible and unready.

**Commit:** `feat: synchronize watch party media changes`

### Phase 4: deployment and end-to-end verification

#### Task 21: Add deterministic two-browser test harness

**Objective:** Exercise the real provider/player bridge against a local room server and local video fixture.

**Files:** Playwright config, test fixture, `e2e/watch-party.spec.*` and CI workflow updates.

**Verification:** Run all scenarios from section 17.4 under Chromium and Firefox.

**Commit:** `test: cover watch party multi-client flows`

#### Task 22: Add production configuration and Docker deployment

**Objective:** Serve the fork and WSS service behind one TLS origin.

**Files:** Modify `webpack.config.js`; add server Docker/compose/Caddy examples and operator documentation.

**Verification:** Build images, start stack, pass health check, connect two browsers through WSS and inspect logs for secret leakage.

**Commit:** `ops: add watch party deployment stack`

#### Task 23: Add observability and soak test

**Objective:** Demonstrate stable behavior over a full film-length session.

**Verification:** Two-hour run with jitter/reconnect injection; bounded memory/listeners; drift percentiles and reconnect counts exported; no room/secret data in logs.

**Commit:** `test: add watch party soak verification`

#### Task 24: Upstream-maintenance review

**Objective:** Minimize fork divergence and decide whether to propose upstream.

**Steps:** Rebase onto current upstream `development`, isolate generic player-adapter changes, document GPL source distribution, and prepare an architecture proposal before a large upstream PR.

**Commit:** `docs: document watch party maintenance strategy`

## 19. MVP acceptance criteria

Functional:

- Two desktop browser clients can join the same room and independently play the same supported stream.
- Only the host changes canonical play/pause/seek/next-video state.
- Guest timeline controls are clearly disabled, not merely ignored invisibly.
- Local volume, mute, audio, subtitles and fullscreen remain functional.
- A reconnecting guest receives a current snapshot and catches up without host intervention.
- A mid-playback join works after load/readiness.
- Episode change resets readiness and does not accidentally play old media.

Synchronization:

- Play/pause propagation is under 500 ms on a typical low-latency connection, excluding deliberate scheduled lead time.
- After explicit seek or reconnect, guest drift falls under 1000 ms within two seconds.
- Under stable network conditions, at least 95% of sampled playback is within the chosen post-spike drift target.
- No repeated seek/rate oscillation occurs.

Safety:

- Stremio auth keys and configured add-on transport URLs are absent from protocol captures and logs.
- Guests cannot issue authoritative commands by crafting raw WebSocket messages.
- Expired/invalid invitations fail safely.
- Browser autoplay failure is visible and recoverable.

Quality:

- Existing Jest, lint and production build remain green.
- New pure logic has unit coverage for authority, revisions, clock and drift boundaries.
- Two-browser end-to-end tests pass in Chromium and Firefox.
- Docker deployment passes health and WSS verification.
- A two-hour soak has no unbounded listener, timer, room or memory growth.

## 20. Decisions still requiring spike evidence

1. Exact safe source-handoff behavior for real debrid/configured add-on streams.
2. Whether a single Ready interaction reliably unlocks later scheduled playback in target browsers.
3. Final hard-seek and soft-rate thresholds per player implementation.
4. Whether MVP should support the desktop shell in addition to browser/PWA.
5. Whether guest buffering should ever auto-pause the room.
6. Whether short room codes are worth the attack surface compared with opaque invite links only.
7. Whether direct stream URLs can be shared at all, or must always be locally re-resolved.

These are not excuses to leave behavior vague. Phase 0 must resolve them with recorded evidence before production implementation.

## 21. Recommended first implementation slice

After approval, do only the following first:

1. Complete the four Phase 0 spikes.
2. Implement a server with room create/join and host-authoritative pause/play/seek.
3. Implement the pure client reducer/clock and a fake-player adapter.
4. Integrate a hidden developer-only room control into Stremio Web.
5. Run two-browser tests using a deterministic local video.

Do not begin chat, reactions, Redis, mobile polish or broad source support until this slice demonstrates reliable synchronization and safe media handoff.

## 22. Sources

- Stremio add-on protocol: `https://stremio.github.io/stremio-addon-sdk/protocol.html`
- Stremio Addon SDK: `https://github.com/Stremio/stremio-addon-sdk`
- Stremio Web: `https://github.com/Stremio/stremio-web`
- Stremio Video: `https://github.com/Stremio/stremio-video`
- Watch-party feature request: `https://github.com/Stremio/stremio-features/issues/151`
- Related feature requests: `https://github.com/Stremio/stremio-features/issues/26`, `/278`, `/1020`
- Peario client: `https://github.com/tymmesyde/peario-client`
- Peario server: `https://github.com/tymmesyde/peario-server`
- Peario launcher add-on: `https://github.com/tymmesyde/peario-stremio-addon`
