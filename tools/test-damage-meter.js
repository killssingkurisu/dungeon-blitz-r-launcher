#!/usr/bin/env node
'use strict';

/**
 * Drives the damage meter (flashbrowser/damageMeter) without Electron, a game or a game server: the
 * combat feed against a mock of `/api/combat/outbound` (no feed, no game session yet, a refused
 * sign-in, a failing or odd server, a backlog, live packets), the playback clock and the pace
 * packets play at, what is and is not counted, a new level's connection, which game data it
 * will fetch, and the meter window's commands (export, copy, settings).
 *
 * The meter's arithmetic, the packet readers and the export format are tested where they are
 * maintained, in DB DPS Launcher (github.com/killssingkurisu/db-dpsmod, test/run.js); the checks
 * here make sure the copies in flashbrowser/damageMeter read what the feed carries.
 *
 * Usage: node tools/test-damage-meter.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { DamageMeter } = require('../flashbrowser/damageMeter');
const { CombatFeed, decodePacket, requestJson } = require('../flashbrowser/damageMeter/feed');

/* ---------- packets, written the way the game client writes them ---------- */

class BitWriter {
    constructor() {
        this.bits = [];
    }

    raw(value, n) {
        for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / Math.pow(2, i)) % 2);
        return this;
    }

    bool(b) {
        return this.raw(b ? 1 : 0, 1);
    }

    uint(v) {
        const need = v > 0 ? Math.floor(Math.log2(v)) + 1 : 1;
        const use = Math.max(2, (need + 1) & ~1);
        this.raw(use / 2 - 1, 4);
        return this.raw(v, use);
    }

    sint(v) {
        this.bool(v < 0);
        return this.uint(Math.abs(v));
    }

    sint3(v) {
        this.bool(v < 0);
        const a = Math.abs(v);
        const need = a > 0 ? Math.floor(Math.log2(a)) + 1 : 1;
        const use = Math.max(2, (need + 1) & ~1);
        this.raw(use / 2 - 1, 3);
        return this.raw(a, use);
    }

    str(s) {
        const b = Buffer.from(s, 'utf8');
        this.raw(b.length, 16);
        for (const x of b) this.raw(x, 8);
        return this;
    }

    buffer() {
        const bits = this.bits.slice();
        while (bits.length % 8) bits.push(0);
        const out = Buffer.alloc(bits.length / 8);
        for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
        return out;
    }
}

// Each is [packet id, payload]: what the feed carries for one packet.
const pkt = {
    // 0x08, client -> server: an entity the client runs; isPlayer marks its own character.
    fullUpdate: (id, name, { isPlayer = false, team = 1, summoner = 0, power = 0 } = {}) => {
        const w = new BitWriter().uint(id).sint(1200).sint(-40).sint(0).str(name).raw(team, 2).bool(isPlayer).sint3(0).bool(false);
        w.bool(Boolean(summoner));
        if (summoner) w.uint(summoner);
        w.bool(Boolean(power));
        if (power) w.uint(power);
        return [0x08, w.raw(0, 2).bool(true).bool(false).bool(false).bool(false).bool(false).buffer()];
    },
    cast: (source, power) => [0x09, new BitWriter().uint(source).uint(power).bool(true).bool(false).bool(false).bool(false).bool(false).bool(false).buffer()],
    hit: (target, source, damage, power, crit = false) =>
        [0x0a, new BitWriter().uint(target).uint(source).sint(damage).uint(power).bool(false).bool(false).bool(crit).buffer()],
    dot: (target, source, power, amount) => [0x79, new BitWriter().uint(target).uint(source).uint(power).sint(amount).raw(0, 5).buffer()],
    // 0x0F, server -> client: an entity coming into view.
    spawn: (id, name, isPlayer, team) => {
        const w = new BitWriter().uint(id).str(name).raw(isPlayer ? 1 : 0, 1);
        if (isPlayer) w.str('Rogue');
        else w.sint(500).sint(20).sint(0).raw(team, 2);
        return [0x0f, w.buffer()];
    },
    gold: (amount) => [0x35, new BitWriter().uint(amount).bool(false).buffer()],
    // 0x87, server -> client: Level Complete.
    levelComplete: () => [0x87, new BitWriter().uint(97).uint(40).buffer()],
    // 0x21, server -> client: go on to the next level, on another connection.
    enterWorld: (level) =>
        [0x21, new BitWriter().uint(4321).uint(0).str('').bool(false).str('dungeonblitzr.theminesa.studio').uint(8080)
            .str('LevelsHome.swf/a_Level_Home').raw(50, 6).raw(50, 6).str(level).str('').str('').bool(false).bool(false).bool(false).buffer()]
};

const ME = 12;
const GOBLIN = 301;
const POISON_STRIKE = 993; // PoisonStrike10 in the bundled game data

/** One entry of the feed's `packets`. */
function entry(seq, at, dir, [id, payload]) {
    return { seq, at, dir, id, data: payload.toString('base64') };
}

/** The first things a level's connection carries: who the player is, and a goblin. */
function arrival(seq, at) {
    return [entry(seq, at, 'up', pkt.fullUpdate(ME, 'ksq', { isPlayer: true })), entry(seq + 1, at, 'down', pkt.spawn(GOBLIN, 'GoblinBrute', false, 2))];
}

function ok(body) {
    return { ok: true, status: 200, body, error: '' };
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'damage-meter-test-'));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A meter whose feed has its HTTP request and its clock replaced: the test queues the server's
 * answers, moves the clock and polls by hand (start() makes the first poll itself).
 */
function fakeMeter({ delayMs = 1000 } = {}) {
    const clock = { t: 1760000000000 }; // Unix epoch ms, like the server's
    const requests = [];
    // Each is a result, or a function that makes one (and can move the clock: a slow answer).
    const answers = [];
    const feed = new CombatFeed({
        request: async (method, url, headers) => {
            requests.push({ method, url, headers });
            const next = answers.shift();
            if (typeof next === 'function') return next();
            return next || { ok: false, status: 0, body: null, error: 'no answer queued' };
        },
        pollMs: 1e9,
        delayMs,
        now: () => clock.t
    });
    const dataDir = tempDir();
    const meter = new DamageMeter({ dataDir, version: 'test', log: () => {}, feed });
    const begin = async () => {
        meter.attach({ serverUrl: 'http://game.test/', getLauncherToken: () => 'launcher-token' });
        meter.watch(true);
        await sleep(20);
    };
    const advance = (ms) => {
        clock.t += ms;
        feed.play();
    };
    const totals = () => meter.meter.snapshot().totals;
    return { meter, feed, clock, requests, answers, begin, advance, totals, dataDir };
}

async function check(name, fn) {
    await fn();
    console.log(`[test-damage-meter] ${name}: OK`);
}

/* ---------- a mock game server, for the checks over real HTTP ---------- */

function startMockServer({ token = 'launcher-token' } = {}) {
    const state = { requests: [], live: [], served: 0, backlog: [] };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        state.requests.push({ path: url.pathname, since: url.searchParams.get('since'), token: req.headers['x-launcher-token'] || '' });
        const respond = (code, body) => {
            res.statusCode = code;
            res.setHeader('Content-Type', 'application/json');
            res.end(typeof body === 'string' ? body : JSON.stringify(body));
        };
        if (url.pathname === '/broken') {
            respond(200, 'not json');
            return;
        }
        if (url.pathname.startsWith('/maintenance/')) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end('<!DOCTYPE html><title>Back soon</title>');
            return;
        }
        if (url.pathname !== '/api/combat/outbound') {
            respond(404, { ok: false, reason: 'not-found' });
            return;
        }
        if (req.headers['x-launcher-token'] !== token) {
            respond(404, { reason: 'no-game-session' });
            return;
        }
        const now = Date.now();
        const since = url.searchParams.get('since');
        if (since === null) {
            respond(200, { cursor: String(state.served), now, level: 'GoblinRiverDungeon', backlog: true, packets: state.backlog });
            return;
        }
        const packets = state.live.filter((p) => p.seq > Number(since));
        if (packets.length) state.served = packets[packets.length - 1].seq;
        respond(200, { cursor: String(Math.max(state.served, Number(since))), now, level: 'GoblinRiverDungeon', packets });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ state, url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) });
        });
    });
}

async function main() {
    await check('reads the packets the feed carries and refuses the rest', () => {
        const p = decodePacket(entry(7, 1234, 'up', pkt.hit(GOBLIN, ME, 1000, POISON_STRIKE)));
        assert.deepStrictEqual([p.seq, p.at, p.dir, p.id], [7, 1234, 'up', 0x0a]);
        assert.ok(Buffer.isBuffer(p.payload) && p.payload.length > 0);
        assert.strictEqual(decodePacket({ seq: 1, at: 1, dir: 'sideways', id: 9, data: '' }), null, 'a direction must be up or down');
        assert.strictEqual(decodePacket({ seq: 1, at: 1, dir: 'up', id: 70000, data: '' }), null, 'a packet id is 16 bits');
        assert.strictEqual(decodePacket({ seq: 1, at: 1, dir: 'up', id: 9, data: 'not base64!' }), null, 'a payload must be base64');
        assert.strictEqual(decodePacket({ at: 1, dir: 'up', id: 9, data: '' }), null, 'every packet has its seq');
        assert.strictEqual(decodePacket(null), null);
    });

    await check('a server without the feed, one with no game session yet, and one that fails, each said plainly', async () => {
        const f = fakeMeter();
        f.answers.push({ ok: false, status: 404, body: { ok: false, reason: 'not-found' }, error: '' });
        await f.begin();
        assert.strictEqual(f.feed.snapshot().supported, false);
        assert.strictEqual(f.meter.linkStatus().state, 'error');
        assert.ok(/does not publish a combat feed/.test(f.meter.linkStatus().text));
        assert.strictEqual(f.meter.summary().supported, false, 'the launcher window can tell too');

        f.answers.push({ ok: false, status: 404, body: { reason: 'no-game-session' }, error: '' });
        await f.feed.poll();
        assert.deepStrictEqual([f.feed.snapshot().supported, f.feed.snapshot().session], [true, false]);
        assert.ok(/Waiting for your character/.test(f.meter.linkStatus().text), f.meter.linkStatus().text);

        f.answers.push({ ok: false, status: 502, body: null, error: '' });
        await f.feed.poll();
        assert.ok(/unreachable \(502\)/.test(f.meter.linkStatus().text), f.meter.linkStatus().text);
        f.meter.stop();
    });

    await check('a page that is not the feed counts as no feed; a refused sign-in and an oversized answer are said plainly', async () => {
        const f = fakeMeter();
        f.answers.push({ ok: false, status: 200, body: null, error: 'invalid-json' });
        await f.begin();
        assert.strictEqual(f.feed.snapshot().supported, false, "a site's catch-all page is not a feed");
        f.answers.push(ok({ hello: 'world' }));
        await f.feed.poll();
        assert.strictEqual(f.feed.snapshot().supported, false, 'nor is JSON without packets');
        f.answers.push({ ok: false, status: 401, body: { reason: 'unknown-requester' }, error: '' });
        await f.feed.poll();
        assert.ok(/did not accept this launcher's sign-in/.test(f.meter.linkStatus().text), f.meter.linkStatus().text);
        f.answers.push({ ok: false, status: 0, body: null, error: 'too-large' });
        await f.feed.poll();
        assert.ok(/more at once than the meter reads/.test(f.meter.linkStatus().text), f.meter.linkStatus().text);
        f.answers.push(ok({ packets: [] }));
        await f.feed.poll();
        assert.ok(/without a cursor/.test(f.meter.linkStatus().text), f.meter.linkStatus().text);
        f.meter.stop();
    });

    await check('the launcher token goes in a header and the cursor in the URL', async () => {
        const f = fakeMeter();
        f.answers.push(ok({ cursor: 'c1', now: f.clock.t, backlog: true, packets: [] }));
        f.answers.push(ok({ cursor: 'c2', now: f.clock.t, packets: [] }));
        await f.begin();
        await f.feed.poll();
        assert.strictEqual(f.requests[0].url, 'http://game.test/api/combat/outbound');
        assert.strictEqual(f.requests[0].headers['X-Launcher-Token'], 'launcher-token');
        assert.strictEqual(f.requests[1].url, 'http://game.test/api/combat/outbound?since=c1');
        f.meter.stop();

        // The token is read from disk at most every 30 s, not on every poll.
        let reads = 0;
        const g = fakeMeter();
        g.answers.push(ok({ cursor: 'c1', now: g.clock.t, backlog: true, packets: [] }), ok({ cursor: 'c2', now: g.clock.t, packets: [] }), ok({ cursor: 'c3', now: g.clock.t, packets: [] }));
        g.meter.attach({ serverUrl: 'http://game.test/', getLauncherToken: () => (reads++, 'launcher-token') });
        g.meter.watch(true);
        await sleep(20);
        await g.feed.poll();
        g.clock.t += 31000;
        await g.feed.poll();
        assert.deepStrictEqual([reads, g.requests.every((r) => r.headers['X-Launcher-Token'] === 'launcher-token')], [2, true]);
        g.meter.stop();
    });

    await check('the backlog says who you are and where, and none of it counts', async () => {
        const f = fakeMeter();
        await f.meter.command('autoStart', true);
        const t = f.clock.t;
        f.answers.push(
            ok({
                cursor: '4',
                now: t,
                level: 'GoblinRiverDungeon',
                backlog: true,
                packets: [...arrival(1, t - 9000), entry(3, t - 8000, 'up', pkt.cast(ME, POISON_STRIKE)), entry(4, t - 7900, 'up', pkt.hit(GOBLIN, ME, 5000, POISON_STRIKE))]
            })
        );
        await f.begin();
        assert.strictEqual(f.meter.character, 'ksq', 'the backlog names the character');
        assert.strictEqual(f.meter.level, 'GoblinRiverDungeon');
        assert.deepStrictEqual([f.totals().damage, f.totals().casts, f.meter.meter.state], [0, 0, 'idle'], 'what happened before the meter watched is not counted');

        f.answers.push(
            ok({ cursor: '6', now: f.clock.t, packets: [entry(5, f.clock.t - 1000, 'up', pkt.cast(ME, POISON_STRIKE)), entry(6, f.clock.t - 1000, 'up', pkt.hit(GOBLIN, ME, 1000, POISON_STRIKE, true))] })
        );
        await f.feed.poll();
        f.advance(0);
        assert.deepStrictEqual([f.totals().damage, f.totals().casts, f.totals().crits], [1000, 1, 1], 'live hits count, against the goblin the backlog named');
        assert.strictEqual(f.meter.meter.report().hits[0][5], 'GoblinBrute');
        f.meter.stop();
    });

    await check('live packets play back in order, spaced as they happened, each once', async () => {
        const f = fakeMeter({ delayMs: 1000 });
        await f.meter.command('autoStart', true);
        // The server's clock runs 5 s ahead of this machine's: playback follows the server's.
        f.answers.push(ok({ cursor: '2', now: f.clock.t + 5000, backlog: true, packets: arrival(1, f.clock.t) }));
        await f.begin();
        const t = f.clock.t;
        f.answers.push(
            ok({
                cursor: '5',
                now: t + 5000,
                packets: [
                    entry(3, t + 5000 - 900, 'up', pkt.hit(GOBLIN, ME, 100, POISON_STRIKE)),
                    entry(4, t + 5000 - 500, 'up', pkt.hit(GOBLIN, ME, 200, POISON_STRIKE)),
                    entry(5, t + 5000, 'up', pkt.hit(GOBLIN, ME, 300, POISON_STRIKE))
                ]
            })
        );
        await f.feed.poll();
        f.advance(0);
        assert.strictEqual(f.totals().hits, 0, 'nothing plays before its moment, a second behind the server');
        f.advance(100);
        assert.strictEqual(f.totals().damage, 100);
        f.advance(400);
        assert.strictEqual(f.totals().damage, 300);
        f.advance(500);
        assert.strictEqual(f.totals().damage, 600);
        assert.deepStrictEqual(f.meter.meter.report().hits.map((h) => h[0]), [0, 400, 900], 'each hit is timed as it happened');

        // A packet the server sends again is not counted twice.
        f.answers.push(ok({ cursor: '6', now: f.clock.t + 5000, packets: [entry(5, t + 5000, 'up', pkt.hit(GOBLIN, ME, 300, POISON_STRIKE)), entry(6, f.clock.t + 5000 - 1000, 'down', pkt.gold(25))] }));
        await f.feed.poll();
        f.advance(0);
        assert.strictEqual(f.totals().damage, 600);
        assert.strictEqual(f.meter.meter.snapshot().dungeon, null, 'gold is kept by Dungeon mode only');
        f.meter.stop();
    });

    await check('the playback clock takes only epoch-ms readings, and jitter can neither jump it nor run it backwards', async () => {
        const f = fakeMeter({ delayMs: 1000 });
        f.answers.push(ok({ cursor: '1', now: 0, backlog: true, packets: [] }));
        await f.begin();
        assert.strictEqual(f.feed.clock(), f.clock.t - 1000, 'a clock reading of 0 is not taken');
        f.answers.push(ok({ cursor: '2', now: Math.floor(f.clock.t / 1000), packets: [] }));
        await f.feed.poll();
        assert.strictEqual(f.feed.clock(), f.clock.t - 1000, 'nor one in seconds');
        f.answers.push(ok({ cursor: '3', now: f.clock.t + 3000, packets: [] }));
        await f.feed.poll();
        assert.strictEqual(f.feed.clock(), f.clock.t + 2000, 'the first good reading sets it');
        f.answers.push(ok({ cursor: '4', now: f.clock.t + 3000 + 700, packets: [] }));
        await f.feed.poll();
        assert.strictEqual(f.feed.clock(), f.clock.t + 2025, 'later readings steer it a little at a time');
        f.answers.push(ok({ cursor: '5', now: f.clock.t - 1e9, packets: [] }));
        await f.feed.poll();
        const before = f.feed.clock();
        f.clock.t += 10;
        assert.ok(f.feed.clock() >= before, 'it never runs backwards');
        f.answers.push(() => {
            f.clock.t += 3000; // an answer that took 3 s says little about the server's time
            return ok({ cursor: '6', now: f.clock.t + 999999, packets: [] });
        });
        const offset = f.feed.offset;
        await f.feed.poll();
        assert.strictEqual(f.feed.offset, offset);
        f.meter.stop();
    });

    await check('a new numbering from the server is followed, and a packet stamped in the future holds nothing up', async () => {
        const f = fakeMeter({ delayMs: 1000 });
        await f.meter.command('autoStart', true);
        f.answers.push(ok({ cursor: 'a', now: f.clock.t, backlog: true, packets: arrival(5000, f.clock.t) }));
        await f.begin();
        f.answers.push(ok({ cursor: 'b', now: f.clock.t, packets: [entry(5002, f.clock.t - 1000, 'up', pkt.hit(GOBLIN, ME, 100, POISON_STRIKE))] }));
        await f.feed.poll();
        f.advance(0);
        assert.strictEqual(f.totals().damage, 100);
        // The server was restarted: its backlog numbers from 1 again, and so does what follows.
        f.answers.push(ok({ cursor: 'c', now: f.clock.t, backlog: true, packets: arrival(1, f.clock.t) }));
        await f.feed.poll();
        f.answers.push(ok({ cursor: 'd', now: f.clock.t, packets: [entry(3, f.clock.t - 1000, 'up', pkt.hit(GOBLIN, ME, 200, POISON_STRIKE))] }));
        await f.feed.poll();
        f.advance(0);
        assert.strictEqual(f.totals().damage, 300);
        f.answers.push(
            ok({
                cursor: 'e',
                now: f.clock.t,
                packets: [entry(4, f.clock.t + 3600000, 'up', pkt.hit(GOBLIN, ME, 400, POISON_STRIKE)), entry(5, f.clock.t - 900, 'up', pkt.hit(GOBLIN, ME, 800, POISON_STRIKE))]
            })
        );
        await f.feed.poll();
        f.advance(1000);
        assert.strictEqual(f.totals().damage, 1500, 'an hour ahead is taken as now, and the next packet plays after it');
        f.meter.stop();
    });

    await check('an answer to a request made before the feed started over is dropped', async () => {
        const pending = [];
        const feed = new CombatFeed({ request: (method, url) => new Promise((resolve) => pending.push({ url, resolve })), pollMs: 1e9 });
        const levels = [];
        feed.on('level', (level) => levels.push(level));
        feed.start({ serverUrl: 'http://a.test' });
        await sleep(15);
        feed.stop();
        feed.start({ serverUrl: 'http://b.test' });
        await sleep(15);
        assert.deepStrictEqual(pending.map((r) => r.url), ['http://a.test/api/combat/outbound', 'http://b.test/api/combat/outbound']);
        pending[0].resolve(ok({ cursor: 'A-999', now: Date.now(), level: 'A-level', backlog: true, packets: [] }));
        await sleep(5);
        assert.deepStrictEqual([feed.cursor, levels], [null, []], "server A's late answer is not B's");
        pending[1].resolve(ok({ cursor: 'B-1', now: Date.now(), level: 'B-level', backlog: true, packets: [] }));
        await sleep(5);
        assert.deepStrictEqual([feed.cursor, levels], ['B-1', ['B-level']]);
        feed.stop();
    });

    await check('a level the server names in a live answer waits for enter world: a run is not cut short', async () => {
        const f = fakeMeter({ delayMs: 1000 });
        await f.meter.command('autoStart', true);
        await f.meter.command('dungeonMode', true);
        f.answers.push(ok({ cursor: '2', now: f.clock.t, level: 'GoblinRiverDungeon', backlog: true, packets: arrival(1, f.clock.t) }));
        await f.begin();
        const t = f.clock.t;
        f.answers.push(
            ok({
                cursor: '6',
                now: t,
                // The server already counts the player in town; the packets before 0x21 are still the dungeon's.
                level: 'CraftTown',
                packets: [
                    entry(3, t - 900, 'up', pkt.hit(GOBLIN, ME, 1000, POISON_STRIKE)),
                    entry(4, t - 600, 'up', pkt.hit(GOBLIN, ME, 5000, POISON_STRIKE)),
                    entry(5, t - 300, 'down', pkt.levelComplete()),
                    entry(6, t - 100, 'down', pkt.enterWorld('CraftTown'))
                ]
            })
        );
        await f.feed.poll();
        f.advance(0);
        assert.strictEqual(f.meter.level, 'GoblinRiverDungeon', 'nothing has played yet');
        f.advance(1000);
        const d = f.meter.meter.snapshot().dungeon;
        assert.deepStrictEqual([f.totals().damage, d.phase, d.endedBy, f.meter.level], [6000, 'ended', 'complete', 'CraftTown']);
        f.meter.stop();
    });

    await check('enter world: the next level is read afresh, and the fight carries on', async () => {
        const f = fakeMeter({ delayMs: 0 });
        await f.meter.command('autoStart', true);
        f.answers.push(ok({ cursor: '2', now: f.clock.t, level: 'CraftTown', backlog: true, packets: arrival(1, f.clock.t) }));
        await f.begin();
        const at = () => f.clock.t;
        f.answers.push(
            ok({
                cursor: '9',
                now: at(),
                packets: [
                    entry(3, at(), 'up', pkt.hit(GOBLIN, ME, 1000, POISON_STRIKE)),
                    entry(4, at(), 'down', pkt.enterWorld('GoblinRiverDungeon')),
                    // The new connection numbers everything afresh: 12 is not the player any more.
                    entry(5, at(), 'up', pkt.hit(40, ME, 777, POISON_STRIKE)),
                    entry(6, at(), 'up', pkt.fullUpdate(5, 'ksq', { isPlayer: true })),
                    entry(7, at(), 'down', pkt.spawn(ME, 'GoblinShaman', false, 2)),
                    entry(8, at(), 'up', pkt.hit(ME, 5, 2000, POISON_STRIKE)),
                    entry(9, at(), 'up', pkt.dot(ME, 5, POISON_STRIKE, 250))
                ]
            })
        );
        await f.feed.poll();
        f.advance(0);
        assert.strictEqual(f.meter.level, 'GoblinRiverDungeon');
        assert.strictEqual(f.totals().damage, 3250, 'both levels count, and nothing from an id that changed hands');
        assert.strictEqual(f.meter.meter.report().hits[2][5], 'GoblinShaman');
        f.meter.stop();
    });

    await check('a gap the server could not fill starts over, without losing what was already fetched', async () => {
        const f = fakeMeter({ delayMs: 1000 });
        await f.meter.command('autoStart', true);
        f.answers.push(ok({ cursor: '2', now: f.clock.t, backlog: true, packets: arrival(1, f.clock.t) }));
        await f.begin();
        f.answers.push(ok({ cursor: '3', now: f.clock.t, packets: [entry(3, f.clock.t, 'up', pkt.hit(GOBLIN, ME, 400, POISON_STRIKE))] }));
        await f.feed.poll();
        assert.strictEqual(f.totals().damage, 0, 'still waiting for its moment');
        f.answers.push(ok({ cursor: '90', now: f.clock.t, backlog: true, packets: [...arrival(80, f.clock.t), entry(82, f.clock.t, 'up', pkt.hit(GOBLIN, ME, 9999, POISON_STRIKE))] }));
        await f.feed.poll();
        assert.strictEqual(f.totals().damage, 400, 'the fetched hit is played out; the new backlog is not counted');
        f.meter.stop();
    });

    await check('the meter starts hidden, and the feed runs only once a player has shown it', async () => {
        const f = fakeMeter();
        assert.strictEqual(f.meter.settings.hidden, true, 'hidden on first run: a small box on the page shows it');
        f.meter.attach({ serverUrl: 'http://game.test/', getLauncherToken: () => '' });
        f.meter.watch(!f.meter.settings.hidden);
        assert.strictEqual(f.feed.isRunning(), false, 'a player who never shows the meter costs the server nothing');
        await f.meter.command('show');
        assert.strictEqual(f.feed.isRunning(), true, 'shown: the feed is read');
        assert.deepStrictEqual([f.meter.summary().open, f.meter.summary().session, f.meter.summary().running], [true, true, true]);
        await f.meter.command('hide');
        assert.strictEqual(f.meter.settings.hidden, true);
        assert.strictEqual(f.feed.isRunning(), true, 'hidden again, the fight goes on being counted');
        await f.meter.command('hide');
        assert.strictEqual(f.meter.settings.hidden, false, 'F8 toggles');
        f.meter.detach();
        assert.strictEqual(f.feed.isRunning(), false, 'the game session ended: the last fight stays on the page');
        assert.ok(/No game session/.test(f.meter.linkStatus().text));
        f.meter.attach({ serverUrl: 'http://game.test/', getLauncherToken: () => '' });
        assert.strictEqual(f.feed.isRunning(), true);
        f.meter.stop();

        const again = new DamageMeter({ dataDir: f.dataDir, version: 'test', log: () => {}, feed: new CombatFeed() });
        assert.strictEqual(again.settings.hidden, false, 'shown stays shown across games');
        again.stop();
    });

    await check('Export, Copy and the settings', async () => {
        const f = fakeMeter({ delayMs: 0 });
        const out = tempDir();
        const saves = [path.join(out, 'fight.json'), path.join(out, 'fight.csv'), ''];
        let clipboard = '';
        f.meter.io = {
            documentsDir: out,
            saveDialog: async () => saves.shift(),
            writeClipboard: (text) => {
                clipboard = text;
            }
        };
        await f.meter.command('autoStart', true);
        f.answers.push(ok({ cursor: '2', now: f.clock.t, backlog: true, packets: arrival(1, f.clock.t) }));
        await f.begin();
        f.answers.push(ok({ cursor: '4', now: f.clock.t, packets: [entry(3, f.clock.t, 'up', pkt.cast(ME, POISON_STRIKE)), entry(4, f.clock.t, 'up', pkt.hit(GOBLIN, ME, 4000, POISON_STRIKE))] }));
        await f.feed.poll();
        f.advance(2000);

        const json = await f.meter.command('export');
        assert.strictEqual(json.ok, true);
        const exported = JSON.parse(fs.readFileSync(json.file, 'utf8'));
        assert.deepStrictEqual([exported.format, exported.version, exported.source], ['dbb-dps', 2, 'Dungeon Blitz: R launcher test']);
        assert.deepStrictEqual([exported.character.name, exported.fight.damage, exported.spells[0].key], ['ksq', 4000, 'PoisonStrike']);
        const csv = await f.meter.command('export');
        assert.ok(fs.readFileSync(csv.file, 'utf8').startsWith('Spell,Rank'), 'a .csv name gets the spreadsheet');
        assert.deepStrictEqual(await f.meter.command('export'), { ok: false, canceled: true });
        let shown = '';
        f.meter.io.showError = (message) => {
            shown = message;
        };
        f.meter.io.saveDialog = async () => path.join(out, 'no-such-folder', 'fight.json');
        const failed = await f.meter.command('export');
        assert.strictEqual(failed.ok, false);
        assert.ok(/Could not save fight\.json/.test(shown), 'a failed save is said, not swallowed');
        await f.meter.command('copy');
        assert.ok(clipboard.includes('Poison Strike'), clipboard);

        await f.meter.command('dungeonMode', true);
        await f.meter.command('layout', { id: 'spells', rect: { x: 10.4, y: 20, w: 300, h: 200 } });
        await f.meter.command('layout', { id: 'not-a-panel', rect: { x: 1, y: 1, w: 1, h: 1 } });
        assert.deepStrictEqual((await f.meter.command('nonsense')).ok, false);
        f.meter.stop();

        const again = new DamageMeter({ dataDir: f.dataDir, version: 'test', log: () => {}, feed: new CombatFeed() });
        assert.deepStrictEqual([again.settings.autoStart, again.settings.dungeonMode], [true, true]);
        assert.deepStrictEqual(again.settings.layout.rects, { spells: { x: 10, y: 20, w: 300, h: 200 } });
        again.stop();
    });

    await check('game data is fetched from the game server only', async () => {
        const server = await startMockServer();
        const f = fakeMeter();
        f.meter.attach({ serverUrl: server.url, getLauncherToken: () => '' });
        await f.meter.loadLiveData({ game: 'https://elsewhere.example/Game.swz', login: 'file:///etc/passwd' });
        assert.deepStrictEqual(f.meter.liveData, { game: '', login: '' }, 'another site is never asked');
        await f.meter.loadLiveData({ game: '/p/cbq/Game.swz' });
        assert.ok(server.state.requests.some((r) => r.path === '/p/cbq/Game.swz'), 'the game server was asked, at the path the feed named');
        assert.ok(/^bundled/.test(f.meter.powersInfo.source), 'without the file, the bundled spell data stays');
        assert.strictEqual(f.meter.liveData.game, '', 'a fetch that failed is tried again when the feed names the file next');
        await f.meter.loadLiveData({ game: '/p/cbq/Game.swz' });
        assert.strictEqual(server.state.requests.filter((r) => r.path === '/p/cbq/Game.swz').length, 2);
        await f.meter.loadLiveData({ game: '/maintenance/Game.swz' });
        assert.ok(/^bundled/.test(f.meter.powersInfo.source), 'a web page served under the name is not read as game data');
        f.meter.stop();
        await server.close();
    });

    await check('against a mock game server over HTTP, end to end', async () => {
        const server = await startMockServer();
        const now = Date.now();
        server.state.backlog = arrival(1, now - 10000);
        const meter = new DamageMeter({ dataDir: tempDir(), version: 'test', log: () => {}, feed: new CombatFeed({ pollMs: 25, delayMs: 50 }) });
        await meter.command('autoStart', true);
        meter.attach({ serverUrl: `${server.url}/`, getLauncherToken: () => 'launcher-token' });
        meter.watch(true);
        const until = async (test, what) => {
            for (let i = 0; i < 200 && !test(); i++) await sleep(10);
            assert.ok(test(), what);
        };
        await until(() => meter.character === 'ksq', 'the backlog arrives');
        const t = Date.now();
        server.state.live.push(entry(3, t, 'up', pkt.cast(ME, POISON_STRIKE)), entry(4, t + 10, 'up', pkt.hit(GOBLIN, ME, 1500, POISON_STRIKE)), entry(5, t + 20, 'up', pkt.dot(GOBLIN, ME, POISON_STRIKE, 300)));
        await until(() => meter.meter.snapshot().totals.damage === 1800, 'live hits arrive and count');
        assert.strictEqual(meter.linkStatus().state, 'live');
        assert.ok(server.state.requests.every((r) => r.token === 'launcher-token'), 'every request carries the launcher token');
        assert.ok(server.state.requests.some((r) => r.since !== null), 'later requests ask from the cursor');
        meter.stop();

        const notJson = await requestJson('GET', `${server.url}/broken`, {}, 2000);
        assert.deepStrictEqual([notJson.ok, notJson.error], [false, 'invalid-json']);
        const noSession = await requestJson('GET', `${server.url}/api/combat/outbound`, {}, 2000);
        assert.deepStrictEqual([noSession.ok, noSession.status, noSession.body.reason], [false, 404, 'no-game-session']);
        await server.close();
    });

    console.log('[test-damage-meter] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
