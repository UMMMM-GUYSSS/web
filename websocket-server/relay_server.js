#!/usr/bin/env node
/**
 * Machine Party - WebSocket signaling server for web (HTML5) multiplayer.
 *
 * Zero dependencies. Run with:
 *   node relay_server.js
 *
 * Why this exists
 * ---------------
 * A browser cannot open a listening socket, so Godot's ENetMultiplayerPeer (raw
 * UDP) is unavailable in a web export, and Steam's GDExtension is not part of
 * the web template. Peers therefore establish direct P2P WebRTC data channels
 * (Godot WebRTCMultiplayerPeer, full mesh) and use this server ONLY for
 * signalling/room-lobby service: room codes, peer IDs, and SDP/ICE forwarding.
 * No game traffic flows through this server.
 *
 * Legacy note: versions before WebRTC routed opaque game packets through the
 * server (10-byte binary header). That path is still accepted below so old
 * builds fail soft during the transition, but new clients never send game
 * frames here -- they send them over WebRTC data channels.
 *
 * Protocol
 * --------
 * Control frames are UTF-8 JSON text frames. (Legacy game frames were binary
 * frames with a 10 byte header; still forwarded if received.)
 *
 * Client -> server control:
 *   {"t":"create","name":"...","max":5}
 *   {"t":"create","name":"...","max":5,"code":"ABC123"}   (host-chosen code:
 *       6 letters/digits, uppercased by the server; omitted = auto-generate)
 *   {"t":"join","code":"ABC123","name":"..."}
 *   {"t":"signal","to":2,"kind":"offer","sdp":"v=0..."}
 *   {"t":"signal","to":1,"kind":"answer","sdp":"v=0..."}
 *   {"t":"signal","to":3,"kind":"candidate","mid":"0","index":0,"candidate":"..."}
 *   {"t":"set_joinable","joinable":false}          (host only)
 *   {"t":"kick","id":3}                            (host only)
 *   {"t":"leave"}
 *   {"t":"ping"}
 *
 * Server -> client control:
 *   {"t":"welcome","id":0,"v":2,"mode":"webrtc-signaling"}
 *   {"t":"created","code":"ABC123","id":1}
 *   {"t":"joined","code":"ABC123","id":2,"peers":[1,3]}
 *   {"t":"peer","id":3}
 *   {"t":"left","id":3}
 *   {"t":"kicked"}                                 (sent to a kicked peer)
 *   {"t":"sealed","joinable":false}                (room joinability changed)
 *   {"t":"signal","from":2,"kind":"offer","sdp":"v=0..."}
 *   {"t":"signal","from":1,"kind":"candidate","mid":"0","index":0,"candidate":"..."}
 *   {"t":"error","code":"ROOM_NOT_FOUND","message":"..."}
 *
 * Configuration (environment variables)
 * -------------------------------------
 *   PORT              HTTP/WebSocket port                     (default 8787)
 *   HOST              Bind address                             (default 0.0.0.0)
 *   TLS_CERT          Path to PEM certificate. Enables wss://.
 *   TLS_KEY           Path to PEM private key. Enables wss://.
 *   TLS_PORT          Port for wss://                          (default PORT + 1)
 *   MAX_PEERS         Max peers per room                       (default 8)
 *   PEER_TIMEOUT_MS   Drop a peer after this long without pong (default 45000)
 */

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8787', 10);
const TLS_PORT = parseInt(process.env.TLS_PORT || String(PORT + 1), 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PEERS = Math.max(2, parseInt(process.env.MAX_PEERS || '8', 10));
const PEER_TIMEOUT_MS = parseInt(process.env.PEER_TIMEOUT_MS || '45000', 10);
const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'relay_server.log');

const HEADER_SIZE = 10;
const MAX_CONTROL_BYTES = 32 * 1024;
const MAX_GAME_BYTES = 1 * 1024 * 1024;
const MAX_SDP_BYTES = 24 * 1024;
// Bump when the signaling protocol changes incompatibly. Clients check this
// in the "welcome" message and refuse to run against anything older.
//   v2 = WebRTC offer/answer/candidate relay, seal, kick
//   v3 = host-chosen room codes in "create"
const SIGNALING_VERSION = 3;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Opcode constants.
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// Ambiguous glyphs (0/O, 1/I/L) are excluded so codes survive being read aloud
// or copied off a screenshot.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// ---------------------------------------------------------------------------
// Room + peer bookkeeping
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} code -> room */
const rooms = new Map();
/** @type {Map<number, Peer>} numeric id -> peer (diagnostics only) */
let nextPeerSerial = 1;

class Peer {
    constructor(socket) {
        this.serial = nextPeerSerial++;
        this.socket = socket;
        this.room = null;
        this.id = 0;
        this.lastSeen = Date.now();
        this.alive = true;
        this.awaitingPong = false;
        this.heartbeatTimer = null;
    }
}

class Room {
    constructor(code, maxPeers) {
        this.code = code;
        this.maxPeers = maxPeers;
        /** @type {Map<number, Peer>} peer id -> peer */
        this.peers = new Map();
        this.createdAt = Date.now();
        this.joinable = true;
    }

    get size() {
        return this.peers.size;
    }

    /** Lowest unused positive peer id. The host always claims 1 first. */
    nextId() {
        let id = 1;
        while (this.peers.has(id)) {
            id++;
        }
        return id;
    }
}

function generateRoomCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
        let code = '';
        for (let i = 0; i < CODE_LENGTH; i++) {
            const bytes = crypto.randomBytes(1);
            code += CODE_ALPHABET[bytes[0] % CODE_ALPHABET.length];
        }
        if (!rooms.has(code)) {
            return code;
        }
    }
    throw new Error('Unable to allocate a free room code');
}

// ---------------------------------------------------------------------------
// Framing helpers
// ---------------------------------------------------------------------------

function buildFrame(opcode, payload) {
    const length = payload.length;
    let header;

    if (length < 126) {
        header = Buffer.allocUnsafe(2);
        header[0] = 0x80 | opcode; // FIN + opcode
        header[1] = length;
    } else if (length < 65536) {
        header = Buffer.allocUnsafe(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.allocUnsafe(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeUInt32BE(Math.floor(length / 0x100000000), 2);
        header.writeUInt32BE(length % 0x100000000, 6);
    }

    return Buffer.concat([header, payload]);
}

function send(peer, opcode, payload) {
    if (!peer.alive || !peer.socket) {
        return false;
    }
    try {
        if (peer.socket.writableEnded || peer.socket.destroyed) {
            return false;
        }
        peer.socket.write(buildFrame(opcode, payload));
        return true;
    } catch (err) {
        return false;
    }
}

function sendJson(peer, obj) {
    return send(peer, OP_TEXT, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function sendServerPing(peer) {
    if (!peer.alive || !peer.socket || peer.socket.destroyed) {
        return false;
    }
    peer.awaitingPong = true;
    peer.lastSeen = Date.now();
    return send(peer, OP_PING, Buffer.alloc(0));
}

function sendError(peer, code, message) {
    return sendJson(peer, { t: 'error', code: code, message: message });
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

/**
 * LEGACY fallback: forward a game packet. Pre-WebRTC builds sent binary game
 * frames here; current builds use WebRTC data channels instead and never hit
 * this path. Kept so mixed-version rooms degrade gracefully (old peers keep
 * working until everyone updates).
 */
function routeGamePacket(peer, payload) {
    const room = peer.room;
    if (!room || payload.length < HEADER_SIZE) {
        return;
    }

    const target = payload.readInt32LE(2);
    payload.writeInt32LE(peer.id, 6);

    if (target === 0) {
        // Broadcast: everyone in the room except the sender.
        for (const other of room.peers.values()) {
            if (other !== peer) {
                send(other, OP_BINARY, payload);
            }
        }
        return;
    }

    if (target < 0) {
        // Send to everyone except the sender and except |target|.
        const skip = -target;
        for (const other of room.peers.values()) {
            if (other !== peer && other.id !== skip) {
                send(other, OP_BINARY, payload);
            }
        }
        return;
    }

    const destination = room.peers.get(target);
    if (destination && destination !== peer) {
        send(destination, OP_BINARY, payload);
    }
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

function leaveRoom(peer, notifyCode) {
    const room = peer.room;
    if (!room) {
        return;
    }

    peer.room = null;
    const vacatedId = peer.id;
    peer.id = 0;
    room.peers.delete(vacatedId);

    if (notifyCode) {
        for (const other of room.peers.values()) {
            sendJson(other, { t: 'left', id: vacatedId });
        }
    }

    if (room.peers.size === 0) {
        rooms.delete(room.code);
        log('room', `closed ${room.code}`);
    }
}

function handleCreate(peer, msg) {
    log('control', `peer ${peer.serial} requested create (max=${msg.max || MAX_PEERS})`);
    if (peer.room) {
        leaveRoom(peer, true);
    }

    const requestedMax = parseInt(msg.max, 10);
    const maxPeers = Number.isFinite(requestedMax)
        ? Math.min(MAX_PEERS, Math.max(2, requestedMax))
        : MAX_PEERS;

    // Hosts may request a specific 6-character alphanumeric room code.
    // Anything else is rejected so a typo can never squat an odd room name.
    const requestedCode = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
    let code;
    if (requestedCode !== '') {
        if (!/^[A-Z0-9]{6}$/.test(requestedCode)) {
            sendError(peer, 'BAD_CODE', 'Room code must be 6 letters or numbers');
            return;
        }
        if (rooms.has(requestedCode)) {
            sendError(peer, 'ROOM_TAKEN', `Room "${requestedCode}" is already taken`);
            return;
        }
        code = requestedCode;
    } else {
        try {
            code = generateRoomCode();
        } catch (err) {
            sendError(peer, 'ROOM_ALLOC_FAILED', 'Could not allocate a room code');
            return;
        }
    }

    const room = new Room(code, maxPeers);
    rooms.set(code, room);

    peer.room = room;
    peer.id = 1; // Host is always peer 1, matching the ENet/Steam backends.
    room.peers.set(peer.id, peer);

    log('room', `created ${code} (max ${maxPeers}) by peer 1`);
    sendJson(peer, { t: 'created', code: code, id: peer.id });
}

function handleJoin(peer, msg) {
    const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
    log('control', `peer ${peer.serial} requested join ${code || '<empty>'}`);
    const room = rooms.get(code);

    if (!room) {
        log('control', `peer ${peer.serial} join rejected: room ${code || '<empty>'} not found`);
        sendError(peer, 'ROOM_NOT_FOUND', `No room with code "${code}"`);
        return;
    }
    if (room.peers.size >= room.maxPeers) {
        log('control', `peer ${peer.serial} join rejected: room ${code} full`);
        sendError(peer, 'ROOM_FULL', `Room ${code} is full`);
        return;
    }
    if (!room.joinable) {
        log('control', `peer ${peer.serial} join rejected: room ${code} sealed`);
        sendError(peer, 'ROOM_SEALED', `Room ${code} is no longer accepting players`);
        return;
    }

    if (peer.room) {
        leaveRoom(peer, true);
    }

    const id = room.nextId();
    peer.room = room;
    peer.id = id;
    room.peers.set(id, peer);

    const peers = [...room.peers.keys()].filter((otherId) => otherId !== id);

    // Tell the newcomer who is already here...
    sendJson(peer, { t: 'joined', code: code, id: id, peers: peers });
    // ...and tell everyone else that the newcomer arrived.
    for (const other of room.peers.values()) {
        if (other !== peer) {
            sendJson(other, { t: 'peer', id: id });
        }
    }

    log('room', `${code}: peer ${id} joined (${room.size}/${room.maxPeers})`);
}

/**
 * Forward a WebRTC signaling message (offer/answer/ICE candidate) from one
 * room member to another. The sender id is stamped by the server so a
 * malicious client cannot impersonate another peer. Payloads are size-checked
 * but otherwise opaque -- the server never parses SDP.
 */
function handleSignal(peer, msg) {
    const room = peer.room;
    if (!room || !peer.id) {
        sendError(peer, 'NOT_IN_ROOM', 'Join a room before sending signals');
        return;
    }
    const to = parseInt(msg.to, 10);
    const kind = typeof msg.kind === 'string' ? msg.kind : '';
    if (!Number.isFinite(to) || to <= 0) {
        sendError(peer, 'BAD_SIGNAL_TARGET', 'Signal is missing a valid "to" peer id');
        return;
    }
    if (to === peer.id) {
        sendError(peer, 'BAD_SIGNAL_TARGET', 'Cannot signal yourself');
        return;
    }
    if (kind !== 'offer' && kind !== 'answer' && kind !== 'candidate') {
        sendError(peer, 'BAD_SIGNAL_KIND', 'Signal "kind" must be offer, answer, or candidate');
        return;
    }
    const destination = room.peers.get(to);
    if (!destination) {
        sendError(peer, 'SIGNAL_TARGET_GONE', `Peer ${to} is not in this room`);
        return;
    }

    const out = { t: 'signal', from: peer.id, kind: kind };
    if (typeof msg.sdp === 'string') {
        if (Buffer.byteLength(msg.sdp, 'utf8') > MAX_SDP_BYTES) {
            sendError(peer, 'SIGNAL_TOO_LARGE', 'SDP payload too large');
            return;
        }
        out.sdp = msg.sdp;
    }
    // Trickled ICE candidate fields (all optional except for kind=candidate).
    if (msg.mid !== undefined) {
        out.mid = String(msg.mid).slice(0, 64);
    }
    if (msg.index !== undefined) {
        const index = parseInt(msg.index, 10);
        if (Number.isFinite(index)) {
            out.index = index;
        }
    }
    if (typeof msg.candidate === 'string') {
        if (Buffer.byteLength(msg.candidate, 'utf8') > MAX_SDP_BYTES) {
            sendError(peer, 'SIGNAL_TOO_LARGE', 'ICE candidate too large');
            return;
        }
        out.candidate = msg.candidate;
    }
    if (kind === 'candidate' && !out.candidate) {
        sendError(peer, 'BAD_SIGNAL', 'Candidate signals require a "candidate" string');
        return;
    }
    if ((kind === 'offer' || kind === 'answer') && !out.sdp) {
        sendError(peer, 'BAD_SIGNAL', `${kind} signals require an "sdp" string`);
        return;
    }
    if (kind !== 'candidate') {
        log('control', `room ${room.code}: ${kind} ${peer.id} -> ${to}`);
    }
    sendJson(destination, out);
}

function handleSetJoinable(peer, msg) {
    const room = peer.room;
    if (!room || !peer.id) {
        sendError(peer, 'NOT_IN_ROOM', 'Join a room first');
        return;
    }
    if (peer.id !== 1) {
        sendError(peer, 'NOT_HOST', 'Only the host can change room joinability');
        return;
    }
    room.joinable = msg.joinable !== false;
    for (const other of room.peers.values()) {
        sendJson(other, { t: 'sealed', joinable: room.joinable });
    }
    log('room', `${room.code}: joinable=${room.joinable}`);
}

function handleKick(peer, msg) {
    const room = peer.room;
    if (!room || !peer.id) {
        sendError(peer, 'NOT_IN_ROOM', 'Join a room first');
        return;
    }
    if (peer.id !== 1) {
        sendError(peer, 'NOT_HOST', 'Only the host can remove players');
        return;
    }
    const targetId = parseInt(msg.id, 10);
    const target = room.peers.get(targetId);
    if (!target || targetId === 1) {
        sendError(peer, 'KICK_TARGET_GONE', `Peer ${msg.id} is not in this room`);
        return;
    }
    sendJson(target, { t: 'kicked' });
    leaveRoom(target, true);
    try {
        target.socket.destroy();
    } catch (err) {
        /* already gone */
    }
    log('room', `${room.code}: host kicked peer ${targetId}`);
}

function handleControl(peer, text) {
    let msg;
    try {
        msg = JSON.parse(text);
    } catch (err) {
        sendError(peer, 'BAD_JSON', 'Control frame was not valid JSON');
        return;
    }
    if (!msg || typeof msg.t !== 'string') {
        sendError(peer, 'BAD_REQUEST', 'Control frame is missing "t"');
        return;
    }

    peer.lastSeen = Date.now();

    switch (msg.t) {
        case 'create':
            handleCreate(peer, msg);
            break;
        case 'join':
            handleJoin(peer, msg);
            break;
        case 'signal':
            handleSignal(peer, msg);
            break;
        case 'set_joinable':
            handleSetJoinable(peer, msg);
            break;
        case 'kick':
            handleKick(peer, msg);
            break;
        case 'leave':
            leaveRoom(peer, true);
            peer.id = 0;
            sendJson(peer, { t: 'left', id: 0 });
            break;
        case 'ping':
            peer.lastSeen = Date.now();
            peer.awaitingPong = false;
            sendJson(peer, { t: 'pong' });
            break;
        default:
            sendError(peer, 'UNKNOWN_TYPE', `Unknown control type "${msg.t}"`);
            break;
    }
}

// ---------------------------------------------------------------------------
// Frame decoding
// ---------------------------------------------------------------------------

/**
 * Incremental WebSocket frame decoder. Returns the number of whole messages
 * pulled out of `buffer`, each as {opcode, payload}.
 */
function decodeFrames(buffer, out) {
    let offset = 0;
    let fragmentOpcode = 0;
    let fragments = [];
    let fragmentLength = 0;

    while (true) {
        if (buffer.length - offset < 2) {
            break;
        }

        const b0 = buffer[offset];
        const b1 = buffer[offset + 1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLength = b1 & 0x7f;

        let headerLength = 2;

        if (payloadLength === 126) {
            if (buffer.length - offset < 4) {
                break;
            }
            payloadLength = buffer.readUInt16BE(offset + 2);
            headerLength = 4;
        } else if (payloadLength === 127) {
            if (buffer.length - offset < 10) {
                break;
            }
            const high = buffer.readUInt32BE(offset + 2);
            const low = buffer.readUInt32BE(offset + 6);
            payloadLength = high * 0x100000000 + low;
            headerLength = 10;
            if (payloadLength > MAX_GAME_BYTES) {
                throw new Error('Frame too large');
            }
        }

        let maskKey = null;
        if (masked) {
            if (buffer.length - offset < headerLength + 4) {
                break;
            }
            maskKey = buffer.subarray(offset + headerLength, offset + headerLength + 4);
            headerLength += 4;
        }

        if (buffer.length - offset < headerLength + payloadLength) {
            break;
        }

        const payloadStart = offset + headerLength;
        let payload = Buffer.from(
            buffer.subarray(payloadStart, payloadStart + payloadLength)
        );

        if (maskKey) {
            for (let i = 0; i < payload.length; i++) {
                payload[i] ^= maskKey[i & 3];
            }
        }

        offset += headerLength + payloadLength;

        if (opcode === OP_CONTINUATION) {
            fragments.push(payload);
            fragmentLength += payload.length;
            if (fragmentLength > MAX_GAME_BYTES) {
                throw new Error('Fragmented message too large');
            }
            if (fin) {
                out.push({
                    opcode: fragmentOpcode,
                    payload: Buffer.concat(fragments, fragmentLength),
                });
                fragments = [];
                fragmentLength = 0;
                fragmentOpcode = 0;
            }
            continue;
        }

        if (opcode === OP_PING || opcode === OP_PONG || opcode === OP_CLOSE) {
            out.push({ opcode: opcode, payload: payload });
            continue;
        }

        if (!fin) {
            fragmentOpcode = opcode;
            fragments = [payload];
            fragmentLength = payload.length;
            continue;
        }

        out.push({ opcode: opcode, payload: payload });
    }

    return offset;
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function onConnection(socket, req) {
    const peer = new Peer(socket);
    /** @type {Buffer} */
    let buffer = Buffer.alloc(0);

    socket.setNoDelay(true);

    // Browser WebSocket implementations automatically answer protocol-level
    // PING frames with PONG frames. This keeps idle rooms alive even when the
    // Godot scene is paused or the browser throttles its game loop.
    peer.heartbeatTimer = setInterval(() => {
        if (!peer.alive) {
            return;
        }
        if (peer.awaitingPong && Date.now() - peer.lastSeen > PEER_TIMEOUT_MS) {
            log('timeout', `room ${peer.room ? peer.room.code : '<none>'} peer ${peer.id} (heartbeat)`);
            peer.alive = false;
            leaveRoom(peer, true);
            socket.destroy();
            return;
        }
        sendServerPing(peer);
    }, Math.max(5000, Math.floor(PEER_TIMEOUT_MS / 3)));

    sendJson(peer, { t: 'welcome', id: 0, v: SIGNALING_VERSION, mode: 'webrtc-signaling' });

    socket.on('data', (chunk) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

        let consumedTotal = 0;
        try {
            // Keep draining while complete frames remain.
            while (true) {
                const messages = [];
                const consumed = decodeFrames(buffer, messages);
                if (consumed === 0) {
                    break;
                }
                consumedTotal += consumed;
                buffer = buffer.subarray(consumed);

                for (const message of messages) {
                    if (!peer.alive) {
                        return;
                    }
                    handleMessage(peer, message);
                }
            }
        } catch (err) {
            log('error', `frame decode failed: ${err.message}`);
            socket.destroy();
            return;
        }

        if (buffer.length > MAX_GAME_BYTES * 2) {
            log('error', 'inbound buffer too large, closing');
            socket.destroy();
        }
    });

    socket.on('error', () => {
        peer.alive = false;
    });

    socket.on('close', () => {
        peer.alive = false;
        if (peer.heartbeatTimer) {
            clearInterval(peer.heartbeatTimer);
            peer.heartbeatTimer = null;
        }
        leaveRoom(peer, true);
    });

    function handleMessage(target, message) {
        switch (message.opcode) {
            case OP_BINARY:
                target.lastSeen = Date.now();
                target.awaitingPong = false;
                routeGamePacket(target, message.payload);
                break;
            case OP_TEXT:
                if (message.payload.length > MAX_CONTROL_BYTES) {
                    sendError(target, 'CONTROL_TOO_LARGE', 'Control frame too large');
                    break;
                }
                handleControl(target, message.payload.toString('utf8'));
                break;
            case OP_PING:
                send(target, OP_PONG, message.payload);
                break;
            case OP_PONG:
                target.lastSeen = Date.now();
                target.awaitingPong = false;
                break;
            case OP_CLOSE:
                target.alive = false;
                leaveRoom(target, true);
                socket.end();
                break;
            default:
                break;
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP server (handles the upgrade, plus a tiny status endpoint)
// ---------------------------------------------------------------------------

function createHttpServer() {
    const server = http.createServer((req, res) => {
        if (req.url === '/debug') {
            const body = JSON.stringify({
                ok: true,
                rooms: [...rooms.values()].map((room) => ({
                    code: room.code,
                    createdAt: new Date(room.createdAt).toISOString(),
                    joinable: room.joinable,
                    mode: 'webrtc-signaling',
                    peers: [...room.peers.values()].map((peer) => ({
                        id: peer.id,
                        serial: peer.serial,
                        lastSeen: new Date(peer.lastSeen).toISOString(),
                        awaitingPong: peer.awaitingPong,
                    })),
                })),
            }, null, 2);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Access-Control-Allow-Origin': '*',
            });
            res.end(body);
            return;
        }
        if (req.url === '/health' || req.url === '/') {
            const body = JSON.stringify({
                ok: true,
                rooms: rooms.size,
                peers: [...rooms.values()].reduce((sum, r) => sum + r.size, 0),
                maxPeers: MAX_PEERS,
            });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                // The game may be embedded in an iframe on any host; never let a
                // same-origin policy get in the way of reading relay status.
                'Access-Control-Allow-Origin': '*',
            });
            res.end(body);
            return;
        }
        res.writeHead(404);
        res.end('Not found');
    });

    server.on('upgrade', (req, socket, head) => {
        const key = req.headers['sec-websocket-key'];
        const version = req.headers['sec-websocket-version'];

        if (!key || version !== '13') {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.destroy();
            return;
        }

        const accept = crypto
            .createHash('sha1')
            .update(key + WS_GUID)
            .digest('base64');

        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
        );

        // Any data that arrived before the upgrade completed is already part of
        // the stream; push it back so the decoder sees it.
        if (head && head.length > 0) {
            socket.unshift(head);
        }

        onConnection(socket, req);
    });

    return server;
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

function log(tag, message) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const line = `[${stamp}] [${tag}] ${message}`;
    console.log(line);
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (err) {
        // Console logging must keep working even if the log file is unavailable.
    }
}

function reapStalePeers() {
    const now = Date.now();
    for (const room of rooms.values()) {
        for (const peer of [...room.peers.values()]) {
            // Heartbeat timers own liveness checks. Keep this sweep as a safety
            // net for peers whose timer was interrupted by a server restart or
            // an unusual socket state, but use a generous grace period so a
            // paused/throttled browser is not evicted prematurely.
            if (now - peer.lastSeen > PEER_TIMEOUT_MS * 2) {
                log('timeout', `room ${room.code} peer ${peer.id} (stale sweep)`);
                peer.alive = false;
                leaveRoom(peer, true);
                try {
                    peer.socket.destroy();
                } catch (err) {
                    /* already gone */
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
    const plain = createHttpServer();
    plain.listen(PORT, HOST, () => {
        log('relay', `listening on ws://${HOST}:${PORT}`);
    });

    if (TLS_CERT && TLS_KEY) {
        try {
            const options = {
                cert: fs.readFileSync(path.resolve(TLS_CERT)),
                key: fs.readFileSync(path.resolve(TLS_KEY)),
            };
            const secure = https.createServer(options);
            // Reuse the same request/upgrade handlers.
            secure.on('request', (req, res) =>
                plain.listeners('request')[0](req, res)
            );
            secure.on('upgrade', (req, socket, head) =>
                plain.listeners('upgrade')[0](req, socket, head)
            );
            secure.listen(TLS_PORT, HOST, () => {
                log('relay', `listening on wss://${HOST}:${TLS_PORT}`);
            });
        } catch (err) {
            log('error', `TLS setup failed: ${err.message}`);
        }
    } else {
        log(
            'relay',
            'TLS not configured (set TLS_CERT and TLS_KEY). ' +
                'wss:// is required when the game is hosted on an HTTPS page.'
        );
    }

    setInterval(reapStalePeers, 5000).unref();

    process.on('SIGINT', () => {
        log('relay', 'shutting down');
        process.exit(0);
    });
}

main();
