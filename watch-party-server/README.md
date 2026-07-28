# Stremio watch party room service

Host-authoritative room service for watch parties in this Stremio Web fork.

It owns room membership, authorization and the canonical playback state, and it
relays the host's exact source context to guests. **It never proxies, relays or
stores video.** Every participant independently retrieves and plays the media
through their own Stremio add-ons and streaming server, and every participant
must independently have lawful access to it.

## Design

- One process, all state in memory, every room ephemeral.
- One runtime dependency (`ws`). Envelope validation, rate limiting, metrics and
  the Prometheus exposition format are implemented locally rather than pulled in.
- Only the host mutates playback. Guests are rejected at the protocol layer, not
  merely hidden in the interface.
- Time is injectable throughout, so every test is deterministic and no test
  sleeps on a real clock.

Rooms are deliberately not persisted. They are short-lived, and silently
restoring a stale room after a restart is worse than ending it. If restart
survival becomes a requirement, SQLite is the first adapter to add: persist the
latest room snapshot plus a bounded authoritative-event ring, then prove that
reconstruction preserves the sequence and idempotency invariants covered in
`tests/synchronization.test.ts`.

## Layout

```
src/
  index.ts               entrypoint, signals, graceful shutdown
  config.ts              every tunable, read from the environment
  http/server.ts         health/readiness, metrics listener, WebSocket upgrade
  protocol/              envelopes, schemas, validator, error codes
  rooms/                 Room, RoomStore, policy, id and secret generation
  sessions/              session store and hashed resume tokens
  sync/                  canonical position arithmetic and command application
  ws/                    connection, handlers, rate limiting, upgrade admission
  observability/         redacting logger, metrics registry
tests/                   protocol, rooms, synchronization, authorization, reconnect
```

## Running

Requires Node 22.18 or newer (native TypeScript type stripping).

```sh
npm install
npm test          # node:test, 122 tests
npm run typecheck
npm run build     # emits dist/
npm start
```

For development, `npm run dev` runs the TypeScript sources directly with
`--watch`.

## Endpoints

| Path | Listener | Purpose |
|---|---|---|
| `GET /healthz` | public | liveness |
| `GET /readyz` | public | readiness; 503 while starting or shutting down |
| `GET /v1/ws` | public | WebSocket upgrade |
| `GET /metrics` | internal | Prometheus exposition |

`/metrics` is on a separate listener bound to `127.0.0.1` by default so it is not
reachable from the internet. Set `WATCH_PARTY_METRICS_PORT=-1` to disable it.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `WATCH_PARTY_HOST` | `0.0.0.0` | |
| `WATCH_PARTY_PORT` | `8787` | `0` requests an ephemeral port |
| `WATCH_PARTY_METRICS_HOST` | `127.0.0.1` | |
| `WATCH_PARTY_METRICS_PORT` | `9091` | `-1` disables the listener |
| `WATCH_PARTY_ALLOWED_ORIGINS` | *(empty)* | Comma-separated. **Empty rejects every browser origin.** `*` disables the check |
| `WATCH_PARTY_TRUST_PROXY` | `false` | Honour `X-Forwarded-For`; enable only behind a proxy you control |
| `WATCH_PARTY_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |
| `WATCH_PARTY_MAX_MESSAGE_BYTES` | `262144` | Sized for complete encoded source bundles |
| `WATCH_PARTY_MAX_ROOMS` | `200` | |
| `WATCH_PARTY_MAX_PARTICIPANTS` | `20` | Per room |
| `WATCH_PARTY_MAX_DISPLAY_NAME_LENGTH` | `48` | |
| `WATCH_PARTY_ROOM_TTL_MS` | `43200000` | Absolute room lifetime (12 h) |
| `WATCH_PARTY_ROOM_IDLE_TTL_MS` | `1800000` | Lifetime after the last activity with nobody connected |
| `WATCH_PARTY_RESUME_GRACE_MS` | `120000` | How long a dropped participant may resume |
| `WATCH_PARTY_HOST_GRACE_MS` | `20000` | How long playback keeps running after the host drops |
| `WATCH_PARTY_DEFAULT_LEAD_MS` | `750` | Scheduled lead time for transitions that start playback |
| `WATCH_PARTY_HOST_OBSERVATION_TOLERANCE_MS` | `250` | Host observations closer than this are not rebroadcast |
| `WATCH_PARTY_SWEEP_INTERVAL_MS` | `15000` | Expiry and host-grace maintenance |
| `WATCH_PARTY_HEARTBEAT_INTERVAL_MS` | `30000` | Socket liveness ping |
| `WATCH_PARTY_COMMAND_HISTORY_SIZE` | `256` | Idempotency window for command ids |
| `WATCH_PARTY_MAX_INVALID_MESSAGES` | `5` | Protocol violations before the socket is closed |
| `WATCH_PARTY_RATE_*` | see `src/config.ts` | Per-bucket token-bucket limits |

Rate-limited messages are dropped **before** validation and can never mutate
canonical state.

## Deployment

`compose.example.yml` and `Caddyfile.example` show the intended topology: one TLS
origin serving the static web build, with `/watch-party/ws` proxied to this
service. Same-origin avoids CORS entirely and lets the client derive its endpoint
from `window.location` with no build-time configuration.

An nginx equivalent of the WebSocket location:

```nginx
location /watch-party/ws {
    proxy_pass http://watch-party:8787/v1/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
}
```

`proxy_read_timeout` matters: the default 60 s would drop idle party sockets
mid-film.

The container runs as `node`, drops all capabilities and needs no writable
filesystem. It shuts down on `SIGTERM` by telling every client the room is
closing, then closing sockets.

## Security and privacy

The service is allowed to *process* Stremio auth material, raw stream objects and
configured add-on transport URLs — exact-source handoff is the point. It is not
allowed to *leak* them:

- The logger redacts by key name and truncates long strings, so a careless
  `logger.info('x', { stream })` cannot leak. This is covered by a test that
  fails if an auth key, a configured add-on URL or an invitation secret ever
  appears in the log stream.
- Room ids and invitation secrets are separate values; the secret is transmitted
  exactly once, to the creating host, and never appears in a snapshot.
- Resume tokens are stored hashed. Missing session, wrong token and expired
  window all return the same `RESUME_REJECTED` code.
- Room lookup failures all return `ROOM_NOT_FOUND`, so invitation guessing cannot
  be distinguished from an expired room.
- No media URLs or message payloads are written to logs at any level.

## Extracting to its own repository

This lives inside the fork so the protocol and its two implementations stay
reviewable together. It has no dependency on the web build and can be split out
whenever that becomes useful:

```sh
git subtree split --prefix=watch-party-server -b watch-party-server
```
