#!/usr/bin/env node
// Copyright (C) 2017-2026 Smart code 203358507

// One-command local watch party demo.
//
// Starts the room service in Docker, serves a generated test clip, and runs the
// web app in development over plain HTTP so two browsers can join the same room
// without a TLS certificate to click through.
//
// The clip is deliberately generated rather than downloaded: it needs no addon,
// no Stremio account and no torrent, so the demo exercises the synchronization
// path and nothing else.

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIR = join(REPO_ROOT, '.watch-party-demo');
const CLIP_NAME = 'watch-party-demo.mp4';
const CLIP_PATH = join(ASSET_DIR, CLIP_NAME);

// Deliberately not 8080: that port is heavily contested (kubectl port-forward,
// code-server, countless dev servers), and a process that grabs 127.0.0.1:8080
// after this one started would silently shadow it for `localhost` requests.
const WEB_PORT = Number(process.env.WATCH_PARTY_DEMO_WEB_PORT ?? 8123);
const SERVICE_PORT = Number(process.env.WATCH_PARTY_DEMO_SERVICE_PORT ?? 8787);
const ASSET_PORT = Number(process.env.WATCH_PARTY_DEMO_ASSET_PORT ?? 8099);

const IMAGE = 'stremio-watch-party-server:demo';
const CONTAINER = 'stremio-watch-party-demo';

const CLIP_SECONDS = Number(process.env.WATCH_PARTY_DEMO_CLIP_SECONDS ?? 300);

const bold = (text) => `\u001b[1m${text}\u001b[0m`;
const dim = (text) => `\u001b[2m${text}\u001b[0m`;
const green = (text) => `\u001b[32m${text}\u001b[0m`;
const red = (text) => `\u001b[31m${text}\u001b[0m`;

const log = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => {
    process.stderr.write(`${red('demo:')} ${message}\n`);
    process.exit(1);
};

const has = (command) => spawnSync('which', [command], { stdio: 'ignore' }).status === 0;

const portFree = (port) =>
    new Promise((resolvePort) => {
        const socket = createConnection({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
            socket.destroy();
            resolvePort(false);
        });
        socket.once('error', () => resolvePort(true));
        socket.setTimeout(500, () => {
            socket.destroy();
            resolvePort(true);
        });
    });

// --------------------------------------------------------------- test clip

const generateClip = () => {
    if (existsSync(CLIP_PATH)) {
        log(`${green('ok')}    test clip already present ${dim(CLIP_PATH)}`);
        return;
    }
    if (!has('ffmpeg')) {
        fail('ffmpeg is required to generate the demo clip. Install it, or drop your own mp4 at\n      ' + CLIP_PATH);
    }
    mkdirSync(ASSET_DIR, { recursive: true });
    log(`      generating a ${CLIP_SECONDS}s test clip, this takes a moment…`);

    // testsrc2 renders a running frame counter and timestamp, so the two windows
    // can be compared frame by frame. The sine tone matters: browsers only block
    // autoplay for media with audio, so a silent clip would not exercise the
    // activation path at all.
    const result = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${CLIP_SECONDS}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${CLIP_SECONDS}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        CLIP_PATH,
    ], { stdio: 'inherit' });

    if (result.status !== 0) {
        fail('ffmpeg failed to generate the demo clip');
    }
    log(`${green('ok')}    generated ${dim(CLIP_PATH)}`);
};

// ------------------------------------------------------------ asset server

// Range support is not optional here: without it the browser cannot seek, and
// seeking is half of what this demo is meant to show.
const startAssetServer = () =>
    new Promise((resolveServer, rejectServer) => {
        const server = createServer((request, response) => {
            if (!request.url?.startsWith(`/${CLIP_NAME}`)) {
                response.writeHead(404).end();
                return;
            }
            let stats;
            try {
                stats = statSync(CLIP_PATH);
            } catch {
                response.writeHead(404).end();
                return;
            }

            const headers = {
                'content-type': 'video/mp4',
                'accept-ranges': 'bytes',
                'access-control-allow-origin': '*',
                'cache-control': 'no-store',
            };

            const range = request.headers.range;
            const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
            if (match === null) {
                response.writeHead(200, { ...headers, 'content-length': stats.size });
                if (request.method === 'HEAD') {
                    response.end();
                    return;
                }
                createReadStream(CLIP_PATH).pipe(response);
                return;
            }

            const start = match[1] === '' ? Math.max(0, stats.size - Number(match[2])) : Number(match[1]);
            const end = match[2] === '' || match[1] === '' ? stats.size - 1 : Math.min(Number(match[2]), stats.size - 1);
            if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stats.size) {
                response.writeHead(416, { ...headers, 'content-range': `bytes */${stats.size}` }).end();
                return;
            }

            response.writeHead(206, {
                ...headers,
                'content-range': `bytes ${start}-${end}/${stats.size}`,
                'content-length': end - start + 1,
            });
            if (request.method === 'HEAD') {
                response.end();
                return;
            }
            createReadStream(CLIP_PATH, { start, end }).pipe(response);
        });

        server.once('error', rejectServer);
        server.listen(ASSET_PORT, '127.0.0.1', () => resolveServer(server));
    });

// ---------------------------------------------------------------- service

const startService = () => {
    if (!has('docker')) {
        fail('docker is required to run the room service');
    }
    // A container left behind by an earlier run would hold the port.
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });

    log('      building the room service image…');
    const build = spawnSync('docker', ['build', '-q', '-t', IMAGE, join(REPO_ROOT, 'watch-party-server')], {
        stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (build.status !== 0) {
        fail('docker build failed');
    }

    const run = spawnSync('docker', [
        'run', '-d', '--name', CONTAINER,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
        // Both spellings, because the two browsers may be pointed at either host.
        '-e', `WATCH_PARTY_ALLOWED_ORIGINS=http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
        '-e', 'WATCH_PARTY_LOG_LEVEL=debug',
        '-p', `${SERVICE_PORT}:8787`,
        IMAGE,
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (run.status !== 0) {
        fail('docker run failed');
    }
    log(`${green('ok')}    room service on ${dim(`http://127.0.0.1:${SERVICE_PORT}`)}`);
};

const waitForService = async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${SERVICE_PORT}/readyz`);
            if (response.ok) {
                return;
            }
        } catch {
            // Not up yet.
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    fail('the room service did not become ready; try: docker logs ' + CONTAINER);
};

// ------------------------------------------------------------- dev server

const startWebServer = () => {
    // Invoked directly rather than through pnpm: package.json requires pnpm 11,
    // and this sidesteps the version check entirely.
    const child = spawn(join(REPO_ROOT, 'node_modules', '.bin', 'webpack'), [
        'serve',
        '--mode', 'development',
        '--port', String(WEB_PORT),
        // Plain HTTP avoids a self-signed certificate warning in two browsers,
        // and lets the page reach the local streaming server without mixed
        // content complaints.
        '--env', 'DEV_SERVER_TYPE=http',
        '--env', `WATCH_PARTY_PROXY_TARGET=http://127.0.0.1:${SERVICE_PORT}`,
    ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] });

    let announced = false;
    child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        process.stdout.write(dim(text));
        if (!announced && /compiled|successfully/i.test(text)) {
            announced = true;
            printInstructions();
        }
    });
    return child;
};

const printInstructions = () => {
    const clipUrl = `http://127.0.0.1:${ASSET_PORT}/${CLIP_NAME}`;
    const appUrl = `http://localhost:${WEB_PORT}`;
    log('');
    log(bold('  Watch party demo is ready'));
    log('');
    log(`  ${bold('1.')} Open ${green(appUrl)} in ${bold('Chrome')} (this is the host).`);
    log('     Skip or complete the intro; no account is needed.');
    log('');
    log(`  ${bold('2.')} Click the search bar at the top and ${bold('paste')} this url:`);
    log(`     ${green(clipUrl)}`);
    log(`     ${dim('Pasting is what triggers playback — typing and pressing enter runs a search.')}`);
    log('     The player opens on a test clip with a running timecode.');
    log('');
    log(`  ${bold('3.')} In the player control bar, open the ${bold('person icon')} → ${bold('Start watch party')}.`);
    log('     Playback pauses and an invitation link appears. Copy it.');
    log('');
    log(`  ${bold('4.')} Open ${bold('Firefox')}, paste the invitation into the address bar, press enter,`);
    log(`     then click ${bold('Join')}. Firefox lands on the same clip, paused at the same spot.`);
    log('');
    log(`  ${bold('5.')} In Firefox, click ${bold('Start synchronized playback')} when prompted.`);
    log(`     ${dim('This is the gesture browsers require before audio may play.')}`);
    log('');
    log(`  ${bold('6.')} Press play in ${bold('Chrome')}. Both windows start together on the same frame.`);
    log('     Seek in Chrome and Firefox follows. Try Firefox\'s controls: they are disabled,');
    log('     because only the host drives the timeline.');
    log('');
    log(dim(`  Room service logs:  docker logs -f ${CONTAINER}`));
    log(dim('  Stop everything:    Ctrl-C'));
    log('');
};

// -------------------------------------------------------------------- main

const main = async () => {
    log(bold('Starting the local watch party demo'));

    for (const [port, what] of [[WEB_PORT, 'web app'], [SERVICE_PORT, 'room service'], [ASSET_PORT, 'test clip']]) {
        if (!(await portFree(port))) {
            fail(`port ${port} (${what}) is already in use. Free it, or set a different port with\n      WATCH_PARTY_DEMO_${what === 'web app' ? 'WEB' : what === 'room service' ? 'SERVICE' : 'ASSET'}_PORT`);
        }
    }

    generateClip();
    const assetServer = await startAssetServer();
    log(`${green('ok')}    test clip on ${dim(`http://127.0.0.1:${ASSET_PORT}/${CLIP_NAME}`)}`);

    startService();
    await waitForService();

    const web = startWebServer();
    log('      starting the web app, first build takes ~30s…');

    let closing = false;
    const shutdown = () => {
        if (closing) {
            return;
        }
        closing = true;
        log('\n      stopping…');
        web.kill('SIGTERM');
        assetServer.close();
        spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    web.on('exit', shutdown);
};

main().catch((error) => fail(String(error)));
