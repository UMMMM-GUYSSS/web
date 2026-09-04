#!/usr/bin/env node
/**
 * Smoke test for relay_server.js.
 *
 * Spins up the relay, connects a host and two clients, verifies:
 *   - the host gets peer id 1 and a room code
 *   - clients get ascending ids and see each other
 *   - broadcast (target 0) reaches everyone but the sender
 *   - unicast (target N) reaches only N
 *   - the server rewrites the sender id (spoofing is ignored)
 *   - a full room rejects a newcomer
 *   - leaving notifies the remaining peers
 *
 * Run with:  node test_relay.js
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const PORT = process.env.TEST_PORT || '8971';
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

/** Minimal promise wrapper that collects control messages and game packets. */
function connect(label) {
    const ws = new WebSocket(URL);
    ws.binaryType = 'arraybuffer';
    const client = {
        label,
        ws,
        controls: [],
        packets: [],
        waiters: [],
        ready: false,
    };

    ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
            const msg = JSON.parse(event.data);
            client.controls.push(msg);
            pump(client, msg);
        } else {
            const view = new DataView(event.data);
            client.packets.push({
                mode: view.getUint8(0),
                channel: view.getUint8(1),
                target: view.getInt32(2, true),
                sender: view.getInt32(6, true),
                payload: Buffer.from(event.data).subarray(10),
            });
            // Wake any waiter that may be satisfied by this packet.
            pump(client, null);
        }
    };

    ws.onopen = () => {
        client.ready = true;
    };

    allClients.push(client);
    return client;
}

function pump(client, _msg) {
    for (let i = client.waiters.length - 1; i >= 0; i--) {
        if (client.waiters[i].test()) {
            client.waiters[i].resolve();
            client.waiters.splice(i, 1);
        }
    }
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

function sendControl(client, obj) {
    client.ws.send(JSON.stringify(obj));
}

/** Build a game frame exactly the way the Godot peer does. */
function gameFrame(target, senderClaim, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const buf = Buffer.alloc(10 + body.length);
    buf.writeUInt8(2, 0); // mode = reliable
    buf.writeUInt8(0, 1); // channel 0
    buf.writeInt32LE(target, 2);
    buf.writeInt32LE(senderClaim, 6);
    body.copy(buf, 10);
    return buf;
}

async function main() {
    const serverPath = path.join(__dirname, 'relay_server.js');
    const server = spawn(process.execPath, [serverPath], {
        env: { ...process.env, PORT },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

    try {
        await waitForPort(PORT, 10000);
        console.log(`relay up on ${URL}\n`);

        // --- host + two clients --------------------------------------------
        const host = connect('host');
        await waitFor(host, () => host.ready, 'socket open');
        sendControl(host, { t: 'create', name: 'Host', max: 3 });
        await waitFor(host, () => host.controls.some((m) => m.t === 'created'), 'created');

        const created = host.controls.find((m) => m.t === 'created');
        check('host receives a room code', typeof created.code === 'string' && created.code.length === 6, JSON.stringify(created));
        check('host is peer id 1', created.id === 1, `id=${created.id}`);

        const code = created.code;

        const alice = connect('alice');
        await waitFor(alice, () => alice.ready, 'socket open');
        sendControl(alice, { t: 'join', code });
        await waitFor(alice, () => alice.controls.some((m) => m.t === 'joined'), 'joined');

        const aliceJoined = alice.controls.find((m) => m.t === 'joined');
        check('first client is peer id 2', aliceJoined.id === 2, `id=${aliceJoined.id}`);
        check('first client sees the host', JSON.stringify(aliceJoined.peers) === '[1]', JSON.stringify(aliceJoined.peers));
        await waitFor(host, () => host.controls.some((m) => m.t === 'peer' && m.id === 2), 'peer_joined broadcast');
        check('host is told about the new client', true);

        const bob = connect('bob');
        await waitFor(bob, () => bob.ready, 'socket open');
        sendControl(bob, { t: 'join', code });
        await waitFor(bob, () => bob.controls.some((m) => m.t === 'joined'), 'joined');

        const bobJoined = bob.controls.find((m) => m.t === 'joined');
        check('second client is peer id 3', bobJoined.id === 3, `id=${bobJoined.id}`);
        check('second client sees both existing peers', JSON.stringify(bobJoined.peers) === '[1,2]', JSON.stringify(bobJoined.peers));

        // --- routing --------------------------------------------------------
        host.ws.send(gameFrame(0, 999, 'hello everyone'));
        await waitFor(alice, () => alice.packets.length > 0, 'broadcast');
        await waitFor(bob, () => bob.packets.length > 0, 'broadcast');
        check('broadcast reaches client 2', alice.packets.length === 1 && alice.packets[0].payload.toString() === 'hello everyone');
        check('broadcast reaches client 3', bob.packets.length === 1 && bob.packets[0].payload.toString() === 'hello everyone');
        check('broadcast does not echo to the sender', host.packets.length === 0, `host got ${host.packets.length}`);
        check('sender id is rewritten by the server, not spoofed', alice.packets[0].sender === 1, `sender=${alice.packets[0].sender}`);

        alice.ws.send(gameFrame(3, 111, 'psst'));
        await waitFor(bob, () => bob.packets.length > 1, 'unicast');
        check('unicast reaches the intended peer', bob.packets[1].payload.toString() === 'psst');
        check('unicast sender is rewritten', bob.packets[1].sender === 2, `sender=${bob.packets[1].sender}`);
        check('unicast does not reach the host', host.packets.length === 0, `host got ${host.packets.length}`);

        // Negative target = everyone except sender and except |target|.
        host.ws.send(gameFrame(-3, 1, 'not for bob'));
        await waitFor(alice, () => alice.packets.length > 1, 'exclusion broadcast');
        check('negative target reaches the non-excluded peer', alice.packets.length === 2 && alice.packets[1].payload.toString() === 'not for bob');
        check('negative target skips the excluded peer', bob.packets.length === 2, `bob got ${bob.packets.length}`);

        // --- full room ------------------------------------------------------
        const dave = connect('dave');
        await waitFor(dave, () => dave.ready, 'socket open');
        sendControl(dave, { t: 'join', code });
        await waitFor(dave, () => dave.controls.some((m) => m.t === 'error'), 'room full error');
        check('a full room rejects newcomers', dave.controls.find((m) => m.t === 'error').code === 'ROOM_FULL');

        // --- unknown room ---------------------------------------------------
        const eve = connect('eve');
        await waitFor(eve, () => eve.ready, 'socket open');
        sendControl(eve, { t: 'join', code: 'ZZZZZZ' });
        await waitFor(eve, () => eve.controls.some((m) => m.t === 'error'), 'unknown room error');
        check('an unknown room code is rejected', eve.controls.find((m) => m.t === 'error').code === 'ROOM_NOT_FOUND');

        // --- leaving --------------------------------------------------------
        bob.ws.close();
        await waitFor(alice, () => alice.controls.some((m) => m.t === 'left' && m.id === 3), 'leave notification');
        check('remaining peers are notified when someone leaves', true);

        // --- a freed slot can be reused ------------------------------------
        const frank = connect('frank');
        await waitFor(frank, () => frank.ready, 'socket open');
        sendControl(frank, { t: 'join', code });
        await waitFor(frank, () => frank.controls.some((m) => m.t === 'joined'), 'rejoin');
        check('a freed slot is reused by the next client', frank.controls.find((m) => m.t === 'joined').id === 3);

        // --- large binary payload + fragmentation sanity -------------------
        const big = Buffer.alloc(200000, 7);
        alice.ws.send(gameFrame(1, 2, big));
        await waitFor(host, () => host.packets.length > 0, 'large payload');
        check('large binary payloads survive intact', host.packets[0].payload.length === big.length && host.packets[0].payload.every((b) => b === 7));

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
    console.log('all checks passed');
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
