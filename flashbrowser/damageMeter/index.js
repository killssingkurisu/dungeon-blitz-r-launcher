'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const { CombatFeed } = require('./feed');
const { PKT } = require('./protocol');
const { CombatTracker } = require('./tracker');
const { DpsMeter } = require('./meter');
const { PowerTable, dataFromSwz, DATA_VERSION } = require('./powers');
const { BossTable, bossesFromSwz } = require('./entities');
const exporter = require('./exporter');

/**
 * The damage meter: a timer, DPS, damage per spell, the rotation, Dungeon mode and exports, from
 * the game server's combat feed (feed.js). It shows on the game page, in the grey gutters beside
 * the picture (overlay.js, wired up by flashbrowser/main.js); this part has no Electron in it,
 * so it runs under plain Node in tools/test-damage-meter.js, and nothing newer than Node 12 is
 * used anywhere in this folder (FlashBrowser is Electron 11).
 *
 * The meter, the packet reading and the export format are DB DPS Launcher's
 * (github.com/killssingkurisu/db-dpsmod; MIT, see LICENSE in this folder): protocol.js,
 * tracker.js, meter.js, powers.js, entities.js, swz.js and exporter.js are its files as they
 * are, so fixes can be copied across whole. Exports are `dbb-dps` version 2, which the DPS
 * Calculator imports.
 *
 * The meter starts hidden, with a small box on the page to show it, and the feed is only read
 * once a player has shown it (watch(true)): a player who never does costs the server nothing.
 * Hiding it again keeps the feed running, so a fight is not lost to a glance at the screen.
 */

const TICK_MS = 250;

class DamageMeter extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.dataDir where settings, the data cache and exports' default folder go
     * @param {string} [options.version] the launcher's version, written into exports
     * @param {(message: string) => void} [options.log]
     * @param {CombatFeed} [options.feed]
     * @param {object} [options.io] { saveDialog(defaultPath, filters), writeClipboard(text), showItemInFolder(file), showError(message), documentsDir }
     */
    constructor({ dataDir, version, log, feed, io } = {}) {
        super();
        this.dataDir = dataDir || '';
        this.version = version || 'dev';
        this.log = log || ((message) => console.log(`[Damage meter] ${message}`));
        this.io = io || {};
        this.feed = feed || new CombatFeed();
        this.meter = new DpsMeter({ now: () => this.feed.clock() });
        this.tracker = null;
        this.warming = false;
        this.session = null;
        this.watching = false;
        this.character = '';
        this.className = '';
        this.level = '';
        this.lastExport = '';
        this.powersInfo = { source: 'none', count: 0 };
        this.bosses = new BossTable(null);
        this.liveData = { game: '', login: '' };
        this.settings = { autoStart: false, dungeonMode: false, hidden: true, layout: { rects: {} } };
        this.dirty = true;
        this.lastSent = 0;
        this.lastStateKey = '';
        this.timer = null;

        this.loadSettings();
        this.meter.autoStart = Boolean(this.settings.autoStart);
        this.meter.setDungeonMode(Boolean(this.settings.dungeonMode));
        this.loadPowers();
        this.loadBosses();

        this.meter.on('change', () => this.touch());
        this.meter.on('ignored', () => this.touch());
        this.feed.on('state', () => {
            this.touch();
            this.emitState();
        });
        this.feed.on('backlog', () => this.newTracker());
        this.feed.on('packet', (p) => this.onPacket(p));
        this.feed.on('data', (data) => void this.loadLiveData(data));
        this.feed.on('level', (level) => this.enterLevel(level));
    }

    /* ---------- session and page ---------- */

    /** A game session started: where its server is. */
    attach({ serverUrl, getLauncherToken } = {}) {
        this.session = { serverUrl: String(serverUrl || ''), getLauncherToken: getLauncherToken || null };
        this.sync();
    }

    /** The game session ended. The page keeps the last fight, for a look or an export. */
    detach() {
        this.session = null;
        this.sync();
    }

    /** Whether the meter is being looked at: the feed runs only once it has been. */
    watch(on) {
        this.watching = Boolean(on);
        this.sync();
    }

    sync() {
        const want = Boolean(this.session && this.watching && this.session.serverUrl);
        if (want) {
            this.feed.start({ serverUrl: this.session.serverUrl, getLauncherToken: this.session.getLauncherToken });
        } else if (this.feed.isRunning()) {
            this.feed.stop();
        }
        if (this.watching && !this.timer) {
            this.timer = setInterval(() => {
                this.meter.tick(); // Dungeon mode's 3-second rule
                this.push();
            }, TICK_MS);
            if (typeof this.timer.unref === 'function') this.timer.unref();
        } else if (!this.watching && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.touch();
        this.emitState();
    }

    stop() {
        this.session = null;
        this.watching = false;
        this.sync();
    }

    /** Tells the launcher what changed in summary(); the feed reports every poll, this only changes. */
    emitState() {
        const summary = this.summary();
        const key = JSON.stringify(summary);
        if (key === this.lastStateKey) return;
        this.lastStateKey = key;
        this.emit('state', summary);
    }

    /** What the meter is doing, in short (the console line, and tests). */
    summary() {
        const feed = this.feed.snapshot();
        return {
            enabled: true,
            open: this.watching,
            session: Boolean(this.session),
            running: Boolean(feed.running),
            supported: feed.supported,
            live: Boolean(feed.running && feed.session),
            character: this.character,
            lastError: String(feed.lastError || '')
        };
    }

    /* ---------- packets ---------- */

    newTracker() {
        const tracker = new CombatTracker('combat feed');
        tracker.isBoss = (name) => this.bosses.has(name);
        // Who the player is and where they are count from the backlog too; the rest only live.
        tracker.on('character', ({ id, name }) => {
            if (name && name !== this.character) {
                this.character = name;
                this.className = '';
                this.log(`Your character: ${name} (entity ${id})`);
                this.touch();
                this.emitState();
            }
        });
        tracker.on('enterWorld', (w) => this.enterLevel(w && w.level));
        const live = (fn) => (...args) => {
            if (!this.warming) fn(...args);
        };
        tracker.on('cast', live((e) => this.meter.recordCast(e)));
        tracker.on('damage', live((e) => this.meter.recordDamage(e)));
        tracker.on('procApplied', live((e) => this.meter.recordProc(e)));
        tracker.on('gold', live((amount) => this.meter.recordGold(amount)));
        tracker.on('died', live(() => this.meter.playerDied()));
        tracker.on('revived', live(() => this.meter.playerRevived()));
        tracker.on('bossDied', live(({ name }) => {
            this.log(`Boss defeated: ${this.bosses.displayName(name)} (${name})`);
            this.meter.bossDied(this.bosses.displayName(name));
        }));
        tracker.on('completion', live((percent) => this.meter.levelProgress(percent)));
        tracker.on('levelComplete', live(() => this.meter.levelComplete()));
        this.tracker = tracker;
        return tracker;
    }

    /** The level the player is in, from the feed's `level` or an enter-world packet in it. */
    enterLevel(level) {
        if (!level) return;
        this.level = level;
        this.meter.noteLevel(level);
        this.touch();
    }

    /** One packet off the feed: `up` the client sent it, `down` it was sent to the client. */
    onPacket(p) {
        const tracker = this.tracker || this.newTracker();
        this.warming = Boolean(p.backlog);
        try {
            if (p.dir === 'up') tracker.fromClient(p.id, p.payload);
            else tracker.fromServer(p.id, p.payload);
        } catch {
            // A packet this version can't read is skipped; the next one is read as usual.
        } finally {
            this.warming = false;
        }
        // "Enter world" sends the client on to its next level, over a new connection that numbers
        // entities afresh, so what comes after it is read from scratch. The fight carries on.
        if (p.dir === 'down' && p.id === PKT.ENTER_WORLD) this.newTracker();
    }

    /* ---------- game data ---------- */

    cachePath(name) {
        return this.dataDir ? path.join(this.dataDir, name) : '';
    }

    loadPowers() {
        let data = null;
        try {
            data = JSON.parse(fs.readFileSync(this.cachePath('damage-meter-powers.json'), 'utf8'));
            if (!data || (data.version || 1) < DATA_VERSION || !Array.isArray(data.powers)) throw new Error('old cache');
            this.powersInfo = { source: `cached ${data.source || ''}`, count: data.powers.length };
        } catch {
            try {
                data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'powers.json'), 'utf8'));
                this.powersInfo = { source: `bundled ${data.source || ''}`, count: data.powers.length };
            } catch (error) {
                // Never a reason for the launcher not to start: the meter shows power ids instead of names.
                this.log(`No spell data: ${(error && error.message) || error}`);
                data = { powers: [], abilities: {}, levels: {} };
                this.powersInfo = { source: 'none', count: 0 };
            }
        }
        this.meter.setPowers(new PowerTable(data));
    }

    loadBosses() {
        try {
            this.bosses = new BossTable(JSON.parse(fs.readFileSync(this.cachePath('damage-meter-bosses.json'), 'utf8')));
        } catch {
            try {
                this.bosses = new BossTable(JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'bosses.json'), 'utf8')));
            } catch (error) {
                this.log(`No boss list: ${(error && error.message) || error}`);
            }
        }
    }

    /**
     * The feed named the game's data files: spells and abilities (Game.swz), monsters (Login.swz).
     * Only files on the game server itself are fetched.
     */
    async loadLiveData(data) {
        const base = this.session ? this.session.serverUrl : '';
        const resolve = (p) => {
            try {
                const url = new URL(String(p || ''), base);
                return p && url.origin === new URL(base).origin ? url.href : '';
            } catch {
                return '';
            }
        };
        const game = resolve(data && data.game);
        const login = resolve(data && data.login);
        if (game && game !== this.liveData.game) {
            this.liveData.game = game;
            try {
                const parsed = dataFromSwz(await fetchBuffer(game, 30000), `${game} (${new Date().toISOString().slice(0, 10)})`);
                this.meter.setPowers(new PowerTable(parsed));
                this.powersInfo = { source: `live ${game}`, count: parsed.powers.length };
                this.writeCache('damage-meter-powers.json', parsed);
                this.log(`Spell data loaded from ${game} (${parsed.powers.length} powers)`);
            } catch (error) {
                this.log(`Spell data unavailable from ${game} (${(error && error.message) || error}); using ${this.powersInfo.source}`);
                this.liveData.game = ''; // asked again when the feed names it next
            }
        }
        if (login && login !== this.liveData.login) {
            this.liveData.login = login;
            try {
                const parsed = bossesFromSwz(await fetchBuffer(login, 30000), login);
                this.bosses = new BossTable(parsed);
                this.writeCache('damage-meter-bosses.json', parsed);
                this.log(`Boss list loaded from ${login} (${this.bosses.size} bosses)`);
            } catch (error) {
                this.log(`Boss list unavailable from ${login} (${(error && error.message) || error})`);
                this.liveData.login = '';
            }
        }
        this.touch();
    }

    writeCache(name, data) {
        const file = this.cachePath(name);
        if (!file) return;
        try {
            fs.writeFileSync(file, JSON.stringify(data));
        } catch {
            // the cache is a convenience
        }
    }

    /* ---------- what the page shows ---------- */

    touch() {
        this.dirty = true;
    }

    push() {
        const now = Date.now();
        // While the clock runs the numbers move every tick; otherwise only on change, plus a
        // slow heartbeat for the feed's status.
        if (!this.dirty && this.meter.state !== 'running' && now - this.lastSent < 2000) return;
        this.dirty = false;
        this.lastSent = now;
        this.emit('view', this.view());
    }

    view() {
        return {
            version: this.version,
            meter: this.meter.snapshot(),
            character: this.character,
            className: this.className,
            level: this.level,
            link: this.linkStatus(),
            scan: null,
            powers: this.powersInfo,
            settings: this.settings,
            lastExport: this.lastExport
        };
    }

    linkStatus() {
        const feed = this.feed.snapshot();
        if (!this.session) return { state: 'waiting', text: 'No game session to read hits from.' };
        if (feed.supported === false) {
            return { state: 'error', text: 'This server does not publish a combat feed yet, so there is nothing to read.' };
        }
        if (feed.lastError) return { state: 'error', text: feed.lastError };
        if (feed.running && feed.session) {
            return { state: 'live', text: this.character ? `Reading hits for ${this.character}` : 'Connected, waiting for your character' };
        }
        if (feed.supported === true) return { state: 'waiting', text: 'Waiting for your character to enter the game' };
        return { state: 'waiting', text: 'Connecting to the combat feed...' };
    }

    /* ---------- commands from the page ---------- */

    async command(cmd, arg) {
        const m = this.meter;
        switch (cmd) {
            case 'hello':
                break;
            case 'start':
                m.start();
                break;
            case 'stop':
                m.stop();
                break;
            case 'toggle':
                m.toggle();
                break;
            case 'reset':
                m.reset();
                break;
            case 'hide':
                this.settings.hidden = !this.settings.hidden;
                this.saveSettings();
                if (!this.settings.hidden) this.watch(true);
                break;
            case 'show':
                this.settings.hidden = false;
                this.saveSettings();
                this.watch(true);
                break;
            case 'autoStart':
                this.settings.autoStart = Boolean(arg);
                m.autoStart = this.settings.autoStart;
                this.saveSettings();
                break;
            case 'dungeonMode':
                this.settings.dungeonMode = Boolean(arg);
                m.setDungeonMode(this.settings.dungeonMode);
                this.saveSettings();
                break;
            case 'layout':
                // A panel the player moved or resized: { id, rect: { x, y, w, h } }, in CSS px.
                if (arg && typeof arg === 'object' && ['fight', 'rotation', 'spells'].includes(arg.id)) {
                    const lay = (this.settings.layout = this.settings.layout || { rects: {} });
                    lay.rects = lay.rects || {};
                    const r = arg.rect;
                    if (r && typeof r === 'object') {
                        lay.rects[arg.id] = {
                            x: Math.round(Number(r.x) || 0),
                            y: Math.round(Number(r.y) || 0),
                            w: Math.round(Number(r.w) || 0),
                            h: Math.round(Number(r.h) || 0)
                        };
                    } else {
                        delete lay.rects[arg.id];
                    }
                    this.saveSettings();
                }
                break;
            case 'resetLayout':
                this.settings.layout = { rects: {} };
                this.saveSettings();
                break;
            case 'export':
                return this.exportResults();
            case 'copy':
                if (this.io.writeClipboard) this.io.writeClipboard(exporter.toSummary(m.report(), this.meta()));
                return { ok: true };
            case 'reveal':
                if (this.lastExport && this.io.showItemInFolder) this.io.showItemInFolder(this.lastExport);
                break;
            default:
                return { ok: false, error: 'unknown command' };
        }
        this.touch();
        this.push();
        return { ok: true, view: this.view() };
    }

    meta() {
        return { source: `Dungeon Blitz: R launcher ${this.version}`, character: this.character, className: this.className, scan: null };
    }

    async exportResults() {
        if (!this.io.saveDialog) return { ok: false, error: 'no save dialog' };
        const folder = this.io.documentsDir ? path.join(this.io.documentsDir, 'Dungeon Blitz DPS') : this.dataDir;
        try {
            fs.mkdirSync(folder, { recursive: true });
        } catch {
            // the dialog still opens
        }
        const base = `DPS ${safeFileName(this.character)} ${stamp(new Date())}`;
        const file = await this.io.saveDialog(path.join(folder, `${base}.json`), [
            { name: 'Everything (dbb-dps JSON, for the DPS Calculator)', extensions: ['json'] },
            { name: 'Spell table and rotation (CSV, for spreadsheets)', extensions: ['csv'] }
        ]);
        if (!file) return { ok: false, canceled: true };
        const report = this.meter.report();
        const meta = this.meta();
        const body = /\.csv$/i.test(file) ? exporter.toCsv(report, meta) : JSON.stringify(exporter.toJson(report, meta), null, 2);
        try {
            fs.writeFileSync(file, body, 'utf8');
        } catch (error) {
            const message = `Could not save ${path.basename(file)}: ${(error && error.message) || error}`;
            this.log(message);
            if (this.io.showError) this.io.showError(message);
            return { ok: false, error: message };
        }
        this.lastExport = file;
        this.log(`Exported ${file}`);
        this.touch();
        this.push();
        return { ok: true, file, view: this.view() };
    }

    /* ---------- settings ---------- */

    settingsPath() {
        return this.cachePath('damage-meter.json');
    }

    loadSettings() {
        const file = this.settingsPath();
        if (!file) return;
        try {
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (saved && typeof saved === 'object') this.settings = Object.assign(this.settings, saved);
        } catch {
            // first run
        }
    }

    saveSettings() {
        const file = this.settingsPath();
        if (!file) return;
        try {
            fs.writeFileSync(file, JSON.stringify(this.settings, null, 2));
        } catch {
            // not fatal
        }
    }
}

// The game's data files are a few megabytes; anything far past that is not one.
const MAX_DATA_BYTES = 64 * 1024 * 1024;

function fetchBuffer(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        const request = client.get(url, { timeout: timeoutMs }, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            // A web page under the file's name (an error or maintenance page) is not the file.
            if (/^text\/html/i.test(String(response.headers['content-type'] || ''))) {
                response.resume();
                reject(new Error('a web page, not a game data file'));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_DATA_BYTES) {
                    request.destroy(new Error('file too large'));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        });
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', reject);
    });
}

function stamp(d) {
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function safeFileName(s) {
    return String(s || '').replace(/[\\/:*?"<>|]+/g, '').trim() || 'character';
}

module.exports = { DamageMeter, TICK_MS };
