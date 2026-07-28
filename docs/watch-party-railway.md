# Hosting a watch party on Railway

Deploying the fork and its room service to Railway, so you and a friend can use
it from anywhere without running anything at home.

## Shape of the deployment

Two Railway services in one project, but only **one public domain**:

```
browser ──► Railway edge (TLS)
                │
                ▼  HTTP on $PORT
           web service — Caddy
                ├─ /                  static Stremio Web build
                └─ /watch-party/ws ─► watch-party.railway.internal:8787
                                        (private network, no public domain)
```

The room service deliberately has **no public domain**. It is reachable only
from the web service over Railway's private network.

Serving both from one origin matters: the client then derives
`wss://<origin>/watch-party/ws` from `window.location`, so there is no
build-time endpoint to configure, no cross-origin WebSocket, and no
origin-mismatch failure mode. Media never touches either service — you and your
friend each fetch the video independently.

## Cost

Two small containers. The room service idles at a few MB of RAM and passes only
small JSON frames; the web service serves static files. This sits comfortably in
Railway's cheapest paid tier. Bandwidth is negligible because no video flows
through Railway.

## Deploying

### 1. Create the project

Point Railway at your fork (`ethancowardorion/stremio-web`), branch
`feat/watch-party`.

### 2. Room service

Add a service from the same repo, then in its settings:

| Setting | Value |
|---|---|
| Root directory | `watch-party-server` |
| Networking | **no public domain** — remove it if Railway adds one |

Name it `watch-party`. The name matters: it becomes the private DNS name.

Variables:

```
WATCH_PARTY_HOST=::
WATCH_PARTY_PORT=8787
WATCH_PARTY_METRICS_PORT=-1
WATCH_PARTY_TRUST_PROXY=true
WATCH_PARTY_ALLOWED_ORIGINS=https://<your-web-domain>
WATCH_PARTY_MAX_ROOMS=20
WATCH_PARTY_MAX_PARTICIPANTS=10
```

`WATCH_PARTY_HOST=::` is required, not optional. Railway's private network is
IPv6-only, and the default `0.0.0.0` binds IPv4 only — the web service would
never reach it.

You will not know the web domain until step 3, so set
`WATCH_PARTY_ALLOWED_ORIGINS` after generating it and redeploy.

### 3. Web service

Add a second service from the same repo, with root directory `/`. It picks up
`railway.json`, which builds `railway/Dockerfile.web` and health-checks
`/watch-party/healthz`.

Generate a domain for this service — this is the URL you and your friend use.

Variables:

```
WATCH_PARTY_UPSTREAM=watch-party.railway.internal:8787
```

If you named the room service something other than `watch-party`, use that name
here instead.

`PORT` is injected by Railway; do not set it.

### 4. Close the loop

Go back to the room service and set `WATCH_PARTY_ALLOWED_ORIGINS` to the web
domain you just generated, including `https://` and with no trailing slash.
Redeploy it.

An origin that does not match exactly is the single most common failure: every
WebSocket upgrade is rejected with a bare 403 and the interface only shows
"Disconnected".

## Checking it works

```sh
curl https://<your-web-domain>/watch-party/healthz     # {"status":"ok"}
```

That request goes through Caddy to the room service over the private network, so
a healthy response proves the whole chain. Then open the site, start something
playing, and use the person icon in the player control bar.

## Watching together

Both of you need to be able to play the same source independently:

- **Direct HTTPS URLs** are the easy case. Paste one into the search bar —
  pasting triggers playback; typing and pressing enter runs a search.
- **Torrents** need Stremio Desktop (or Stremio Service) running locally on
  *each* machine, providing a streaming server on `127.0.0.1:11470`.
- **Addons** are per-person. If your friend lacks the addon that resolved your
  stream, they get an explicit source-mismatch error rather than quietly
  desyncing.

### The thing most likely to bite you

The page is HTTPS and the streaming server is `http://127.0.0.1:11470`. Chrome
and Firefox treat `127.0.0.1` as a trustworthy origin so this normally works,
but **it has not been verified over real TLS** — it is the outstanding item from
the deployment plan, and Safari is the likely failure.

If torrent playback fails while direct URLs work, that is this. Stremio's
streaming server has an `ENABLE_REMOTE_HTTPS_CONN` setting, which is the
mechanism Stremio's own hosted client uses for exactly this problem.

## Access control

There is none beyond the invitation link. Anyone who reaches the domain can
create a room, and anyone with an invitation can join one. Invitations carry 192
bits of entropy and rooms expire (12 h absolute, 30 min idle), but the site
itself is public.

If that matters, either put Railway's edge behind an authentication proxy, or
use the Tailscale deployment in
[`watch-party-tailscale.md`](watch-party-tailscale.md), where nothing is exposed
to the internet at all.

## Updating

Push to the branch. Railway rebuilds both services. Only the service whose files
changed needs redeploying, but rebuilding both is harmless.

If you change the protocol, both browsers must reload before they can talk to
each other again — the handshake refuses a version mismatch rather than
half-working.

## If something does not work

**Build fails on `pnpm install`.** The build needs `git`, and one transitive
dependency (`vtt.js`) is pinned to an `ssh://` GitHub URL. `railway/Dockerfile.web`
installs git and rewrites SSH GitHub URLs to anonymous HTTPS. If you build the
web app in some other image, you need both.

**Health check fails / "Disconnected" in the interface.** Almost always one of:
`WATCH_PARTY_HOST` is not `::`; `WATCH_PARTY_UPSTREAM` does not match the room
service's name; or `WATCH_PARTY_ALLOWED_ORIGINS` does not match the domain
exactly. The room service logs `upgrade_rejected` with reason `bad_origin` for
the last one.

**Private networking not resolving right after deploy.** Railway initialises it
during container startup; a service that resolves the name at boot can miss it.
Caddy resolves per request, so this affects the first request at most.

## What has and has not been verified

Verified locally, with both images built and run in the Railway topology (room
service private with no published port, Caddy as the public edge on `$PORT`):
the web image builds from a clean context, static assets and commit-hashed
bundles serve, `/watch-party/healthz` proxies over the private network, a full
two-client host and guest flow completes through the edge, a foreign origin is
refused with 403, and the commit-hash fallback works when git is unavailable.

Not verified: Railway itself. The topology and configuration are exercised
locally, but no deployment to Railway has been made, so the private-network DNS
name, `$PORT` injection and health-check behaviour are as documented by Railway
rather than observed.
