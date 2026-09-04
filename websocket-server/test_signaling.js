#!/usr/bin/env node
/**
 * Signaling tests for relay_server.js (WebRTC P2P mode).
 *
 * Verifies the signaling-only protocol used by webrtc_mesh_peer.gd:
 *   - host creates a room (id 1), clients join with ascending ids
 *   - offer/answer/candidate are forwarded with server-stamped "from"
 *   - malformed signals are rejected (BAD_SIGNAL_TARGET / BAD_SIGNAL_KIND /
 *     SIGNAL_TARGET_GONE / NOT_IN_ROOM)
 *   - only the host can seal (set_joinable) or kick; sealed rooms reject joins
 *   - kick notifies the target ("kicked") and the rest ("left")
 *
 * Run with:  node test_signaling.js
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const PORT = process.env.TEST_PORT || '8972';
const URL = `ws://127.0.0.1:${PORT}`;

let failures = 0;
/** All open clients, closed in the finally block so the loop can drain. */
const allClients = [];

function check(name, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
    }
}

function waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() > deadline) {
                    reject(new Error('port never opened'));
                } else {
                    setTimeout(attempt, 100);
                }
            });
        };
        attempt();
    });
}

function connect(label) {
    const ws = new WebSocket(URL);
    ws.binaryType = 'arraybuffer';
    const client = { label, ws, controls: [], waiters: [], ready: false };
    ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
            return;
        }
        const msg = JSON.parse(event.data);
        client.controls.push(msg);
        for (let i = client.waiters.length - 1; i >= 0; i--) {
            if (client.waiters[i].test()) {
                client.waiters[i].resolve();
                client.waiters.splice(i, 1);
            }
        }
    };
    ws.onopen = () => {
        client.ready = true;
    };
    allClients.push(client);
    return client;
}

function waitFor(client, test, description, timeoutMs = 3000) {
    if (test()) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const waiter = { test, resolve };
        client.waiters.push(waiter);
        setTimeout(() => {
            const idx = client.waiters.indexOf(waiter);
            if (idx !== -1) {
                client.waiters.splice(idx, 1);
                reject(new Error(`${client.label}: timed out waiting for ${description}`));
            }
        }, timeoutMs);
    });
}

function send(client, obj) {
    client.ws.send(JSON.stringify(obj));
}

function last(client, type) {
    const found = client.controls.filter((m) => m.t === type);
    return found.length > 0 ? found[found.length - 1] : null;
}

async function main() {
    const serverPath = path.join(__dirname, 'relay_server.js');
    const server = spawn(process.execPath, [serverPath], {
        env: { ...process.env, PORT, LOG_FILE: path.join(__dirname, 'test_signaling.log') },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

    try {
        await waitForPort(PORT, 10000);
        console.log(`signaling server up on ${URL}\n`);

        // --- lobby ------------------------------------------------------
        const host = connect('host');
        await waitFor(host, () => host.ready, 'socket open');
        send(host, { t: 'create', name: 'Host', max: 4 });
        await waitFor(host, () => last(host, 'created'), 'created');
        const code = last(host, 'created').code;
        const welcome = host.controls.find((m) => m.t === 'welcome');
        check('welcome advertises signaling v3', !!welcome && welcome.v === 3, JSON.stringify(welcome));
        check('host gets a room code', typeof code === 'string' && code.length === 6, code);
        check('host is peer id 1', last(host, 'created').id === 1);

        const alice = connect('alice');
        await waitFor(alice, () => alice.ready, 'socket open');
        send(alice, { t: 'join', code });
        await waitFor(alice, () => last(alice, 'joined'), 'joined');
        check('client joins as peer 2', last(alice, 'joined').id === 2);
        await waitFor(host, () => host.controls.some((m) => m.t === 'peer' && m.id === 2), 'peer notify');

        // --- offer/answer/candidate forwarding ---------------------------
        send(alice, { t: 'signal', to: 1, kind: 'offer', sdp: 'v=alice-offer' });
        await waitFor(host, () => host.controls.some((m) => m.t === 'signal' && m.kind === 'offer'), 'offer forward');
        const offer = host.controls.find((m) => m.t === 'signal' && m.kind === 'offer');
        check('offer reaches the host', !!offer);
        check('offer "from" is stamped by the server', offer && offer.from === 2, JSON.stringify(offer));
        check('offer sdp is preserved', offer && offer.sdp === 'v=alice-offer');

        send(host, { t: 'signal', to: 2, kind: 'answer', sdp: 'v=host-answer' });
        await waitFor(alice, () => alice.controls.some((m) => m.t === 'signal' && m.kind === 'answer'), 'answer forward');
        const answer = alice.controls.find((m) => m.t === 'signal' && m.kind === 'answer');
        check('answer reaches the client with server-stamped from', !!answer && answer.from === 1, JSON.stringify(answer));

        send(host, { t: 'signal', to: 2, kind: 'candidate', mid: '0', index: 0, candidate: 'candidate:1' });
        await waitFor(
            alice,
            () => alice.controls.some((m) => m.t === 'signal' && m.kind === 'candidate'),
            'candidate forward',
        );
        const candidate = alice.controls.find((m) => m.t === 'signal' && m.kind === 'candidate');
        check(
            'ICE candidate fields survive',
            !!candidate && candidate.mid === '0' && candidate.index === 0 && candidate.candidate === 'candidate:1',
            JSON.stringify(candidate),
        );

        // --- validation --------------------------------------------------
        send(alice, { t: 'signal', to: 99, kind: 'offer', sdp: 'v=x' });
        await waitFor(alice, () => alice.controls.some((m) => m.t === 'error' && m.code === 'SIGNAL_TARGET_GONE'), 'gone error');
        check('signal to absent peer is rejected', true);

        send(alice, { t: 'signal', to: 1, kind: 'prank', sdp: 'v=x' });
        await waitFor(alice, () => alice.controls.some((m) => m.t === 'error' && m.code === 'BAD_SIGNAL_KIND'), 'kind error');
        check('unknown signal kind is rejected', true);

        send(alice, { t: 'signal', to: 1, kind: 'offer' });
        await waitFor(alice, () => alice.controls.some((m) => m.t === 'error' && m.code === 'BAD_SIGNAL'), 'sdp error');
        check('offer without sdp is rejected', true);

        const stranger = connect('stranger');
        await waitFor(stranger, () => stranger.ready, 'socket open');
        send(stranger, { t: 'signal', to: 1, kind: 'offer', sdp: 'v=x' });
        await waitFor(stranger, () => stranger.controls.some((m) => m.t === 'error' && m.code === 'NOT_IN_ROOM'), 'room error');
        check('signal before joining is rejected', true);
        stranger.ws.close();

        // --- seal (host-only) --------------------------------------------
        send(alice, { t: 'set_joinable', joinable: false });
        await waitFor(alice, () => alice.controls.some((m) => m.t === 'error' && m.code === 'NOT_HOST'), 'not-host error');
        check('non-host cannot seal the room', true);

        send(host, { t: 'set_joinable', joinable: false });
        await waitFor(host, () => host.controls.some((m) => m.t === 'sealed'), 'sealed broadcast');
        check('host seal is broadcast', last(host, 'sealed').joinable === false);

        const bob = connect('bob');
        await waitFor(bob, () => bob.ready, 'socket open');
        send(bob, { t: 'join', code });
        await waitFor(bob, () => bob.controls.some((m) => m.t === 'error'), 'sealed join error');
        check('sealed room rejects joins', last(bob, 'error').code === 'ROOM_SEALED', JSON.stringify(last(bob, 'error')));
        bob.ws.close();

        send(host, { t: 'set_joinable', joinable: true });
        await waitFor(host, () => host.controls.filter((m) => m.t === 'sealed').length >= 2, 'unseal');
        check('host can reopen the room', true);

        // --- kick (host-only) --------------------------------------------
        const carol = connect('carol');
        await waitFor(carol, () => carol.ready, 'socket open');
        send(carol, { t: 'join', code });
        await waitFor(carol, () => last(carol, 'joined'), 'carol joined');
        const carolId = last(carol, 'joined').id;
        await waitFor(host, () => host.controls.some((m) => m.t === 'peer' && m.id === carolId), 'carol notify');

        send(alice, { t: 'kick', id: carolId });
        await waitFor(alice, () => alice.controls.some((m) => m.t === 'error' && m.code === 'NOT_HOST'), 'kick not-host');
        check('non-host cannot kick', true);

        send(host, { t: 'kick', id: carolId });
        await waitFor(carol, () => carol.controls.some((m) => m.t === 'kicked'), 'kicked notify');
        check('kicked peer is told', true);
        await waitFor(host, () => host.controls.some((m) => m.t === 'left' && m.id === carolId), 'left notify');
        check('room is told when a peer is kicked', true);

        // --- host-chosen room codes --------------------------------------
        const coder = connect('coder');
        await waitFor(coder, () => coder.ready, 'socket open');
        send(coder, { t: 'create', name: 'Coder', max: 4, code: 'GAME42' });
        await waitFor(coder, () => last(coder, 'created'), 'custom created');
        check('host-chosen code is used', last(coder, 'created').code === 'GAME42', JSON.stringify(last(coder, 'created')));

        const squatter = connect('squatter');
        await waitFor(squatter, () => squatter.ready, 'socket open');
        send(squatter, { t: 'create', name: 'Squatter', max: 4, code: 'GAME42' });
        await waitFor(squatter, () => squatter.controls.some((m) => m.t === 'error'), 'taken error');
        check('duplicate custom code is rejected', last(squatter, 'error').code === 'ROOM_TAKEN', JSON.stringify(last(squatter, 'error')));
        squatter.ws.close();

        const lower = connect('lower');
        await waitFor(lower, () => lower.ready, 'socket open');
        send(lower, { t: 'create', name: 'Lower', max: 4, code: 'abc123' });
        await waitFor(lower, () => last(lower, 'created'), 'lowercase created');
        check('lowercase custom code is uppercased', last(lower, 'created').code === 'ABC123', JSON.stringify(last(lower, 'created')));

        const bad = connect('bad');
        await waitFor(bad, () => bad.ready, 'socket open');
        send(bad, { t: 'create', name: 'Bad', max: 4, code: 'AB!@#4' });
        await waitFor(bad, () => bad.controls.some((m) => m.t === 'error'), 'symbol error');
        check('code with symbols is rejected', last(bad, 'error').code === 'BAD_CODE', JSON.stringify(last(bad, 'error')));
        send(bad, { t: 'create', name: 'Bad', max: 4, code: 'AB12' });
        await waitFor(bad, () => bad.controls.filter((m) => m.t === 'error').length >= 2, 'short error');
        check('short code is rejected', bad.controls.filter((m) => m.t === 'error')[1].code === 'BAD_CODE');
        bad.ws.close();

        console.log('');
    } finally {
        for (const client of allClients) {
            try {
                client.ws.close();
            } catch (err) {
                /* already gone */
            }
        }
        server.kill();
        // Let sockets close so the event loop drains; stdout flushes on a
        // natural exit (process.exit would truncate piped output).
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    if (failures > 0) {
        console.log(`${failures} check(s) failed`);
        process.exitCode = 1;
        return;
    }
    console.log('all signaling checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
