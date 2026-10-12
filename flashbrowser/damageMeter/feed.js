'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { EventEmitter } = require('events');

/**
 * The game server's combat feed: the packets of the caller's own game session that the damage
 * meter reads, played back in order at the pace they happened.
 *
 * The launcher never sees the game's traffic -- FlashBrowser and Flash Player talk to the server
 * themselves -- so, as with chat (lib/chatRelay.js), the game server publishes what the meter
 * needs and the launcher polls it:
 *
 *   GET /api/combat/outbound[?since=<cursor>]        X-Launcher-Token: <launcher token>
 *     200 { cursor, now, level, backlog, data, packets: [{ seq, at, dir, id, data }] }
 *     404 { "reason": "no-game-session" }   the feed works; no game session behind this caller yet
 *     404 (anything else)                   this server has no combat feed
 *
 * Each packet is one the game client sent (`dir: "up"`) or was sent (`"down"`), over any of the
 * session's connections, in order: `id` is the packet type (the 16-bit number in its header),
 * `data` its payload in base64 (the bytes after the 4-byte header), `at` the server's clock when
 * it passed and `now` the server's clock as it answers (both Unix epoch ms), `seq` a number that
 * only goes up over the whole session. `cursor` (a string) comes back as `since` next time.
 *
 * The answer to a request without `since` has `backlog: true`, the level the player is in
 * (`level`, its LevelTypes name, e.g. "GoblinRiverDungeon") and its packets so far: they tell
 * the meter who the player is and what is around them, but happened before it was watching, so
 * they are not counted. After that, "enter world" (0x21) in the stream says when the level
 * changes. `data`, when present, names the game's data files ({ game: "/p/cbq/Game.swz",
 * login: ... }). README.md ("Damage meter") lists which packets the meter needs.
 *
 * Packets are released `delayMs` behind the server's clock, so a batch that arrives at once
 * still plays back with its own spacing, and the meter, which runs on clock(), times every hit
 * as it happened.
 */

const POLL_MS = 500;
const DELAY_MS = 1000;
const PLAY_MS = 50;
const REQUEST_TIMEOUT_MS = 8000;
// The feed exists but has no game session behind the caller yet: the game is still loading,
// or the character has not spawned. That fixes itself, so retry soon.
const NO_SESSION_RETRY_MS = 5000;
// A server that cannot do this will not start being able to mid-session.
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;
// The server would not take this launcher's sign-in, or sent more than the meter reads at once.
const REFUSED_RETRY_MS = 60 * 1000;
const ERROR_RETRY_MS = 5000;
const MAX_QUEUE = 50000;
// One answer is a few hundred packets at most; a backlog, a few thousand.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// A reading of the server's clock taken over a slow round trip says little about its time.
const MAX_SAMPLE_RTT_MS = 2000;
// How far one answer may move the playback clock, once it is set.
const MAX_SLEW_MS = 25;
// Unix epoch milliseconds (2001 to 2286): seconds, or a clock counting from boot, are refused.
const MIN_EPOCH_MS = 1e12;
const MAX_EPOCH_MS = 1e13;
// How long a read of the launcher token is used before it is read again.
const TOKEN_TTL_MS = 30 * 1000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

class CombatFeed extends EventEmitter {
    /**
     * @param {{ request?: Function, pollMs?: number, delayMs?: number, now?: () => number }} [options]
     *   request(method, url, headers, timeoutMs) -> Promise<{ ok, status, body, error }>
     */
    constructor({ request, pollMs, delayMs, now } = {}) {
        super();
        this.request = request || requestJson;
        this.pollMs = pollMs || POLL_MS;
        this.delayMs = delayMs === undefined ? DELAY_MS : delayMs;
        this.now = now || (() => Date.now());
        // The server's clock minus this machine's, set by the first good reading and steered after.
        this.offset = 0;
        this.synced = false;
        this.lastClock = -Infinity;
        this.queue = [];
        this.lastSeq = -1;
        this.serverUrl = '';
        this.getLauncherToken = null;
        this.token = '';
        this.tokenAt = 0;
        this.cursor = null;
        this.dataKey = '';
        this.running = false;
        // Changes on every start() and stop(), so an answer to an older request is dropped.
        this.generation = 0;
        this.pollTimer = null;
        this.playTimer = null;
        this.state = { running: false, supported: null, session: false, packets: 0, lastPacketAt: 0, lastError: '' };
    }

    snapshot() {
        return { ...this.state };
    }

    patch(patch) {
        this.state = { ...this.state, ...patch };
        this.emit('state', this.snapshot());
    }

    /** The playback clock, in the server's time (ms): what the meter runs on. Once set, it never runs backwards. */
    clock() {
        const t = this.now() + this.offset - this.delayMs;
        if (!this.synced) return t;
        if (t > this.lastClock) this.lastClock = t;
        return this.lastClock;
    }

    isRunning() {
        return this.running;
    }

    /** @param {{ serverUrl: string, getLauncherToken?: () => string }} options */
    start({ serverUrl = '', getLauncherToken = null } = {}) {
        const base = normalizeBaseUrl(serverUrl);
        if (!base) {
            this.patch({ running: false, supported: false, lastError: 'No server to read the combat feed from.' });
            return { started: false, reason: 'no-server' };
        }
        const tokenGetter = typeof getLauncherToken === 'function' ? getLauncherToken : null;
        if (this.running && this.serverUrl === base) {
            this.getLauncherToken = tokenGetter;
            this.tokenAt = 0;
            return { started: true };
        }
        this.stop();
        this.generation += 1;
        this.serverUrl = base;
        this.getLauncherToken = tokenGetter;
        this.tokenAt = 0;
        this.cursor = null;
        this.lastSeq = -1;
        this.queue = [];
        this.dataKey = '';
        this.running = true;
        this.patch({ running: true, supported: null, session: false, lastError: '' });
        this.playTimer = setInterval(() => this.play(), PLAY_MS);
        if (typeof this.playTimer.unref === 'function') this.playTimer.unref();
        this.schedule(0);
        return { started: true };
    }

    stop() {
        this.generation += 1;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.playTimer) {
            clearInterval(this.playTimer);
            this.playTimer = null;
        }
        // What was already fetched still happened: play it out.
        this.flushQueue();
        this.running = false;
        this.cursor = null;
        if (this.state.running || this.state.session) this.patch({ running: false, session: false });
    }

    schedule(delayMs) {
        if (!this.running) return;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            void this.poll();
        }, delayMs);
        if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    }

    /** The launcher token, read again every TOKEN_TTL_MS: a sign-in inside the game can replace it. */
    launcherToken() {
        if (!this.getLauncherToken) return '';
        const now = this.now();
        if (!this.tokenAt || now - this.tokenAt > TOKEN_TTL_MS) {
            this.token = String(this.getLauncherToken() || '');
            this.tokenAt = now;
        }
        return this.token;
    }

    async poll() {
        if (!this.running) return;
        const generation = this.generation;
        const headers = { Accept: 'application/json' };
        const token = this.launcherToken();
        if (token) headers['X-Launcher-Token'] = token;
        const query = this.cursor !== null ? `?since=${encodeURIComponent(this.cursor)}` : '';
        const sentAt = this.now();
        const result = await this.request('GET', `${this.serverUrl}/api/combat/outbound${query}`, headers, REQUEST_TIMEOUT_MS);
        // Stopped, or started again for another session, while the request was out: not ours.
        if (!this.running || generation !== this.generation) return;
        const gotAt = this.now();

        if (!result.ok) {
            this.failed(result);
            return;
        }
        const body = result.body;
        if (!body || typeof body !== 'object' || !Array.isArray(body.packets)) {
            // JSON that is not this feed's (a site's catch-all page): the same as no feed.
            this.unsupported();
            return;
        }
        const cursor = typeof body.cursor === 'string' || (typeof body.cursor === 'number' && Number.isFinite(body.cursor)) ? String(body.cursor) : null;
        if (cursor === null) {
            this.patch({ lastError: 'The combat feed answered without a cursor.' });
            this.schedule(ERROR_RETRY_MS);
            return;
        }

        this.noteServerClock(Number(body.now), sentAt, gotAt);
        const backlog = body.backlog === true || this.cursor === null;
        this.cursor = cursor;
        const packets = body.packets.map(decodePacket).filter(Boolean);
        if (backlog) {
            // A new session, or a gap the server could not fill: start over from what the server
            // knows, without counting any of it. What was already fetched happened before it.
            this.flushQueue();
            this.dataKey = ''; // the data files are named again, and a failed fetch gets another go
            this.emit('backlog');
            if (typeof body.level === 'string' && body.level) this.emit('level', body.level);
            let last = -1;
            for (const p of packets) {
                last = Math.max(last, p.seq);
                this.emit('packet', Object.assign(p, { backlog: true }));
            }
            // Numbering goes on from the backlog, even if the server started it over.
            this.lastSeq = last;
        } else {
            // No packet passed later than the server's own clock; one stamped so would hold up
            // every packet behind it.
            const latest = this.clock() + this.delayMs;
            for (const p of packets) {
                if (p.seq <= this.lastSeq) continue;
                this.lastSeq = p.seq;
                if (!Number.isFinite(p.at) || p.at > latest) p.at = latest;
                this.queue.push(p);
            }
            if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
        }
        if (body.data && typeof body.data === 'object') {
            const key = JSON.stringify(body.data);
            if (key !== this.dataKey) {
                this.dataKey = key;
                this.emit('data', body.data);
            }
        }
        const last = packets.length ? packets[packets.length - 1] : null;
        this.patch({
            supported: true,
            session: true,
            packets: this.state.packets + packets.length,
            lastPacketAt: last && Number.isFinite(last.at) ? last.at : this.state.lastPacketAt,
            lastError: ''
        });
        this.schedule(this.pollMs);
    }

    /** A request that did not bring packets: why, and when to ask again. */
    failed(result) {
        const status = result.status;
        if (status === 404 && result.body && result.body.reason === 'no-game-session') {
            this.cursor = null;
            this.tokenAt = 0;
            this.patch({ supported: true, session: false, lastError: '' });
            this.schedule(NO_SESSION_RETRY_MS);
        } else if (status === 404 || (status >= 200 && status < 300)) {
            // No such route, or a page that is not JSON where the feed would be.
            this.unsupported();
        } else if (status === 401 || status === 403) {
            this.cursor = null;
            this.tokenAt = 0;
            this.patch({ supported: true, session: false, lastError: "The server did not accept this launcher's sign-in." });
            this.schedule(REFUSED_RETRY_MS);
        } else if (result.error === 'too-large') {
            this.patch({ lastError: 'The combat feed sent more at once than the meter reads.' });
            this.schedule(REFUSED_RETRY_MS);
        } else {
            this.patch({ lastError: `Combat feed unreachable (${status || result.error || 'no answer'}).` });
            this.schedule(ERROR_RETRY_MS);
        }
    }

    unsupported() {
        this.cursor = null;
        this.patch({ supported: false, session: false, lastError: 'This server does not publish a combat feed yet.' });
        this.schedule(UNSUPPORTED_RETRY_MS);
    }

    /** Steers the playback clock by the server's clock in an answer asked for at sentAt and heard at gotAt. */
    noteServerClock(serverNow, sentAt, gotAt) {
        const rtt = gotAt - sentAt;
        if (!Number.isFinite(serverNow) || serverNow < MIN_EPOCH_MS || serverNow > MAX_EPOCH_MS) return;
        if (!(rtt >= 0) || rtt > MAX_SAMPLE_RTT_MS) return;
        // The server answered somewhere between asking and hearing back.
        const sample = serverNow - (sentAt + gotAt) / 2;
        if (!this.synced) {
            this.offset = sample;
            this.synced = true;
            return;
        }
        // From then on it is steered, not set: each reading is off by up to half a round trip,
        // and the clock under the meter must neither jump nor run backwards.
        this.offset += Math.max(-MAX_SLEW_MS, Math.min(MAX_SLEW_MS, sample - this.offset));
    }

    /** Hands the meter every packet whose moment has come on the playback clock. */
    play() {
        const t = this.clock();
        while (this.queue.length && this.queue[0].at <= t) {
            this.emit('packet', this.queue.shift());
        }
    }

    flushQueue() {
        while (this.queue.length) this.emit('packet', this.queue.shift());
    }
}

/** One packet off the feed, or null when it can't be read. */
function decodePacket(p) {
    if (!p || typeof p !== 'object') return null;
    const id = Number(p.id);
    if (!Number.isInteger(id) || id < 0 || id > 0xffff) return null;
    const dir = p.dir === 'down' ? 'down' : p.dir === 'up' ? 'up' : '';
    if (!dir) return null;
    const seq = Number(p.seq);
    if (!Number.isFinite(seq)) return null;
    const data = typeof p.data === 'string' ? p.data : '';
    if (!BASE64.test(data)) return null;
    return { seq, at: Number(p.at), dir, id, payload: Buffer.from(data, 'base64') };
}

function normalizeBaseUrl(value) {
    try {
        const url = new URL(String(value || ''));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return url.origin;
    } catch {
        return '';
    }
}

function requestJson(method, url, headers, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        let tooLarge = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            resolve(tooLarge ? { ok: false, status: 0, body: null, error: 'too-large' } : result);
        };
        let request = null;
        try {
            const parsed = new URL(url);
            const client = parsed.protocol === 'https:' ? https : http;
            request = client.request(parsed, { method, headers: headers || {}, timeout: timeoutMs }, (response) => {
                const chunks = [];
                let size = 0;
                response.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        tooLarge = true;
                        request.destroy(new Error('too-large'));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    let body = null;
                    try {
                        body = text ? JSON.parse(text) : null;
                    } catch {
                        body = null;
                    }
                    const ok = response.statusCode >= 200 && response.statusCode < 300;
                    finish({ ok: ok && body !== null, status: response.statusCode, body, error: ok && body === null ? 'invalid-json' : '' });
                });
                response.on('aborted', () => finish({ ok: false, status: 0, body: null, error: 'aborted' }));
                response.on('error', (error) => finish({ ok: false, status: 0, body: null, error: error.message }));
            });
            request.on('timeout', () => request.destroy(new Error('timed out')));
            request.on('error', (error) => finish({ ok: false, status: 0, body: null, error: error.message }));
            request.end();
        } catch (error) {
            finish({ ok: false, status: 0, body: null, error: (error && error.message) || String(error) });
        }
    });
}

module.exports = { CombatFeed, decodePacket, normalizeBaseUrl, requestJson, POLL_MS, DELAY_MS };
