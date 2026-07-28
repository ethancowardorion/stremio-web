# Hosting a watch party on your tailnet

Setup notes for running the fork for yourself and a friend over Tailscale,
without exposing anything to the internet.

This is the simplest deployment that still gets real HTTPS. Tailscale issues and
renews a certificate for your machine's MagicDNS name, so there are no
certificate warnings, no domain to buy, no ports to forward, and no public
attack surface.

## How it fits together

```
friend's browser ─┐
                  ├─ tailnet (WireGuard) ─► tailscale serve :443  (TLS terminates here)
your browser ─────┘                                │
                                                   ▼  plain HTTP, loopback only
                                          127.0.0.1:8123  Caddy
                                                   ├─ /                 static Stremio Web build
                                                   └─ /watch-party/ws ► room service :8787
```

Media never touches any of this. You and your friend each fetch the video
independently through your own addons and streaming server; only small JSON
frames cross the tailnet.

## Before the first run

1. **Tailscale running on both machines**, both signed in.
2. **HTTPS certificates enabled for the tailnet.** Admin console → Settings →
   Features → enable *HTTPS Certificates*. Without this `tailscale serve` cannot
   get a certificate and the URL will not load. This is a one-time,
   tailnet-wide switch.
3. **MagicDNS enabled** (it is by default, and is what gives you the
   `machine.tailnet.ts.net` name).
4. **Docker running.**
5. **A build:** `pnpm install && pnpm build` at the repository root. This
   produces `build/`, which Caddy serves.

## Running it

```sh
cd watch-party-server/tailscale
./setup.sh
```

That derives the origin from Tailscale, writes `.env`, brings up the stack, and
publishes it with `tailscale serve`. It prints the URL when it is up.

The origin is derived rather than typed on purpose: `WATCH_PARTY_ALLOWED_ORIGINS`
has to match what the browser sends *exactly*, scheme included. Get it wrong and
every WebSocket upgrade is rejected with a bare 403 and nothing useful in the
interface.

## Giving your friend access

In the Tailscale admin console, **share this machine** with them (Machines →
your machine → Share). They accept the share, and the URL then resolves for them
too. They need Tailscale running, nothing else — no ports open, no account on
your tailnet beyond the share.

Then send them the URL, and separately the room invitation link once you start a
party.

## Ports

| Port | Who can reach it | Notes |
|---|---|---|
| 443 on your `.ts.net` name | tailnet only | the only thing anyone connects to |
| 8123 | loopback only | Caddy; `tailscale serve` forwards to it |
| 8787 | container network only | room service |
| 11470 | each person's own machine | their Stremio streaming server |

Nothing is published to the internet. There is no inbound firewall rule to add,
on either side.

## Watching something

Both of you need to be able to play the same source independently:

- **Direct HTTPS URLs** are the easy case. Paste one into the search bar —
  pasting is what triggers playback; typing and pressing enter runs a search.
- **Torrents** need Stremio Desktop (or Stremio Service) running locally on
  *each* machine, providing the streaming server on `127.0.0.1:11470`.
- **Addons** are per-person. If your friend does not have the addon that
  resolved your stream, they get an explicit source-mismatch error rather than
  quietly falling out of sync.

### The one thing most likely to break

The page is HTTPS and the streaming server is `http://127.0.0.1:11470`. Chrome
and Firefox both treat `127.0.0.1` as a trustworthy origin, so this normally
works, but **I have not verified it over real TLS** — it is the outstanding item
from the deployment plan. Safari is the likely failure.

If torrent playback fails while direct URLs work, that is this. The fix is
Stremio's own mechanism: in the streaming server settings, enable
`ENABLE_REMOTE_HTTPS_CONN`, which is what Stremio's hosted web client relies on
for exactly this problem.

## After changing the code

```sh
pnpm build                                   # repository root
cd watch-party-server/tailscale
docker compose up -d --build                 # picks up service changes
```

Caddy serves `build/` from a bind mount, so a rebuild is picked up without
restarting anything. Only changes to the room service need the `--build`.

Note that the protocol version is shared: if you change the protocol, both
browsers need to reload before they can talk to each other again.

## Stopping

```sh
tailscale serve --https 443 off              # take it off the tailnet
docker compose down                          # from watch-party-server/tailscale
```

On macOS the CLI is not on `PATH`; use
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

## If something does not work

**The URL does not load at all.** Check HTTPS certificates are enabled for the
tailnet (step 2 above) — that is the usual cause. Then `tailscale serve status`.

**The page loads but the watch party button says "Disconnected".** The origin
allowlist does not match. Compare `WATCH_PARTY_ORIGIN` in `.env` against what the
browser address bar shows, and check the service logs:
`docker compose logs watch-party`. A rejected upgrade logs `upgrade_rejected`
with reason `bad_origin`.

**Your friend cannot reach the URL.** They need the machine shared with them and
Tailscale running. `tailscale status` on their machine should list yours.

**Playback stutters or jumps between frames.** That was a real bug, fixed in
`89ae54c3`. If you see it again, capture `docker compose logs watch-party` and
check whether the browser is issuing repeated seeks.

## What has and has not been verified

Verified locally: the Caddy routing in this directory (static assets, the
`/watch-party/ws` upgrade, and a full two-client host/guest flow through it), the
origin allowlist rejecting a foreign origin through Caddy, `/metrics` not being
routed, the stack binding to loopback only, and the service container running
read-only as a non-root user.

Not verified: the `tailscale serve` step itself, since that needs Tailscale up
and the tailnet HTTPS switch enabled; a real two-person session across the
tailnet; and the HTTPS-to-`127.0.0.1` streaming server path described above.
