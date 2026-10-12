'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');

const { ChatRelay } = require('./lib/chatRelay');
const { GameStats } = require('./lib/gameStats');
const { createLauncherSessionRecovery } = require('./lib/launcherSessionRecovery');
const discordAuth = require('./lib/discordAuth');
const { exists, inspectInstallLocation, isWritableDirectory } = require('./lib/install');
const { GameHost } = require('./lib/gameHost');
const { findFlashBrowser, prepareFlashBrowserLaunch, verifyFlashBrowser } = require('./lib/flashBrowser');
const { verifyProjector } = require('./lib/integrity');
const { findProjector, findVendoredProjector, isChosenProjector, prepareLaunch, resolveSwfUrl } = require('./lib/projector');
const { keepGameTitle } = require('./lib/windowTitle');
const { describeWindows, unsupportedArchitectureMessage, unsupportedWindowsMessage } = require('./lib/windowsSupport');
const { PresenceBridge } = require('./lib/presence');
const { SocialBridge } = require('./lib/social');
const { createUpdateService } = require('./lib/update');
const { createSessionCache } = require('./lib/launcherSession');
const {
    LAUNCHER_ROOT,
    createStateStore,
    loadLauncherConfig,
    loadServers,
    normalizeHttpUrl
} = require('./lib/config');

// Which Windows this is, read once at startup: Electron runs on Windows 10 and later only,
// and an architecture there is no build of is refused by name. lib/windowsSupport.js holds
// the rules and is tested without an Electron runtime.
const windows = describeWindows();

// One 256px PNG arms the window icon on every platform and the dock icon on Linux and
// Windows; the packaged macOS app takes its icon from build/icon.icns via electron-builder,
// and the dock line below covers running from a checkout. A missing file is not fatal -- a
// window without an icon still works -- so this resolves lazily rather than failing start.
const WINDOW_ICON_PATH = path.join(LAUNCHER_ROOT, 'renderer', 'assets', 'icon.png');
const windowIcon = fs.existsSync(WINDOW_ICON_PATH) ? WINDOW_ICON_PATH : undefined;

function applyDockIcon() {
    if (process.platform === 'darwin' && app.dock && windowIcon) {
        // The dock is macOS-only, so the image is always readable here.
        app.dock.setIcon(windowIcon);
    }
}

// Electron derives the user data folder from package.json's name, so renaming the package
// would strand every player's saved sign-in in the old folder. Pinning it outright keeps
// that folder fixed whatever the package is called. setName alone is not enough: the
// default path is resolved before this script runs.
const APP_DIRECTORY_NAME = 'dungeon-blitz-r-launcher';
app.setName(APP_DIRECTORY_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_DIRECTORY_NAME));

const state = createStateStore(app.getPath('userData'));
const social = new SocialBridge({
    tokenCachePath: path.join(app.getPath('userData'), 'discord-social-token.json'),
    // Authorization happens in the player's own Discord client; a browser is only opened
    // when the configuration explicitly asks for that fallback.
    openUrl: openExternal
});
const sessionCache = createSessionCache(path.join(app.getPath('userData'), 'launcher-session.json'));

// Auto-update: GitHub releases are the feed (build.publish in package.json points
// electron-updater at them). Dev checkouts and dev AppImages never self-update, and the
// service itself is inert unless app.isPackaged.
let updateService = null;

// Rich presence is served by the launcher itself. The multiplayer server's own bridge
// cannot be used from a packaged build, and its absence used to be silent: presence just
// never appeared. See lib/presence.js.
const presence = new PresenceBridge({ launcherConfig: loadLauncherConfig() });

// Game chat and the player's Discord lobby are mirrored for the length of a game session.
// The game server does the reading and the printing; this side only carries the lines.
const chatRelay = new ChatRelay({ social });
chatRelay.on('state', () => pushState());

// The Discord Game Stats widget is written by the game server, which is the only side that
// can hold a bot token; the launcher asks for the write and shows what came back.
const gameStats = new GameStats();
gameStats.on('state', () => pushState());

const damageMeterEnabled = process.env.DUNGEON_BLITZ_DAMAGE_METER !== '0';

// While the game runs in the standalone projector, the launcher does what the game page's
// script would have: rich presence and region latency (lib/gameHost.js). FlashBrowser runs
// the page itself, so it needs none of this.
const gameHost = new GameHost({ presence });

// The two game engines. FlashBrowser -- the game page with FlashBrowser's PPAPI Flash plugin,
// in a Chromium 87 window (lib/flashBrowser.js) -- is the default. Adobe's standalone Flash
// Player (lib/projector.js) is the Legacy button, for players who see a delay collecting
// loot in the plugin.
const ENGINES = ['flashbrowser', 'projector'];

let launcherWindow = null;
// The program running the game -- FlashBrowser or the standalone Flash Player -- and which
// of the two it is.
let gameProcess = null;
let gameEngine = '';
let loginWatcher = null;
// The browser address of the sign-in in progress, for the "Copy sign-in link" button. It names
// the sign-in's key by hash only, so it is safe to put on the clipboard.
let loginLink = '';
// Whether the server wants the code the browser page shows (the launcher is not at the
// browser's address), whether the last one entered was wrong, and whether too many wrong ones
// ended the sign-in. `pendingLoginCode` is a code the player entered, sent once.
let loginCode = { required: false, rejected: false, ended: false };
let pendingLoginCode = '';
let projector = null;
let flashBrowser = { offered: false, target: '', found: null, partial: null, tampered: false, tamperReason: '' };
let discordAccount = { linked: false, email: '', name: '' };
let remembered = false;
let serverReachable = null;
// Set once at startup: a copy running from a mounted disk image or from Downloads is a copy
// nobody will notice going stale.
let installLocation = { relocate: false, reason: '', bundlePath: '', targetPath: '', message: '' };

/**
 * Finds the Flash Player to run the game in.
 *
 * A packaged launcher is locked to the Flash Player it shipped with, and checks it against
 * the fingerprint the build packed into the app (lib/integrity.js): a replaced or patched
 * player is reported as `tampered` and never started. A development checkout keeps the
 * flexible lookup -- a hand-picked file, the gitignored projector/ drop point, the usual
 * install places -- because that is where a player is swapped on purpose.
 */
function locateProjector(preferredPath) {
    if (app.isPackaged) {
        const found = findProjector({ vendorOnly: true });
        if (found) {
            const check = verifyProjector(found.path);
            found.tampered = !check.ok;
            found.tamperReason = check.reason;
        }
        return found;
    }

    return findProjector({
        preferredPath,
        // A gitignored projector/ at the repository root is a drop point for a checkout that
        // would rather not run tools/fetch-projector.js.
        extraDirectories: [path.join(LAUNCHER_ROOT, 'projector')]
    });
}

/**
 * Finds FlashBrowser for this machine. A packaged launcher checks it against the
 * fingerprint the build packed into the app, exactly as it does its Flash Player; a
 * development checkout runs whatever tools/fetch-flash-browser.js put in vendor/.
 */
function locateFlashBrowser() {
    const located = { ...findFlashBrowser(), tampered: false, tamperReason: '' };
    if (located.found && app.isPackaged) {
        const check = verifyFlashBrowser(located.found.root, { target: located.target });
        located.tampered = !check.ok;
        located.tamperReason = check.reason;
    }
    return located;
}

/**
 * Whether the game can be started in the standalone Flash Player: there is one this machine
 * can run -- Adobe's own Flash Player, in its own process and window.
 */
function projectorReady() {
    return Boolean(projector && !projector.archMismatch && !projector.tampered);
}

/** Whether the game can be started in FlashBrowser, the default engine. */
function flashBrowserReady() {
    return Boolean(flashBrowser.found && !flashBrowser.tampered);
}

/**
 * The engine a plain "play" uses -- the start-up play of a remembered player, and the play
 * after a sign-in: the one the player last picked with a button, as long as it can run;
 * otherwise FlashBrowser, the default; otherwise the standalone Flash Player.
 */
function preferredEngine() {
    const saved = state.read().engine;
    if (saved === 'projector' && projectorReady()) {
        return 'projector';
    }
    if (saved === 'flashbrowser' && flashBrowserReady()) {
        return 'flashbrowser';
    }
    if (flashBrowserReady()) {
        return 'flashbrowser';
    }
    if (projectorReady()) {
        return 'projector';
    }
    return flashBrowser.offered ? 'flashbrowser' : 'projector';
}

/** Why an engine cannot start the game right now, or '' when it can. */
function engineProblem(engine) {
    if (engine === 'flashbrowser') {
        if (!flashBrowser.offered) {
            return 'FlashBrowser is not available on this system. Play Legacy instead.';
        }
        if (flashBrowser.tampered) {
            return `${flashBrowser.tamperReason}. Reinstall the launcher, or play Legacy.`;
        }
        if (!flashBrowser.found) {
            return app.isPackaged
                ? 'FlashBrowser is missing from this install. Reinstall the launcher, or play Legacy.'
                : 'FlashBrowser is missing. Run `npm run fetch-flash-browser`, or play Legacy.';
        }
        return '';
    }

    if (!projector) {
        return 'Flash Player is missing. Choose the standalone Flash Player (flashplayer_32_sa) by hand.';
    }
    if (projector.archMismatch) {
        return `Flash Player is a ${projector.architectures.join('/')} program and cannot run on this machine.`;
    }
    if (projector.tampered) {
        return `${projector.tamperReason}. Reinstall the launcher to play.`;
    }
    return '';
}

function gameRunning() {
    return Boolean(gameProcess);
}

// Both engines are found once at startup, and the projector again whenever the player picks
// one by hand. Each is started fresh for every game, so a new choice applies on the next play.
function findFlashPlayer() {
    flashBrowser = locateFlashBrowser();
    if (flashBrowser.found) {
        console.log(`[FlashBrowser] ${flashBrowser.target} at ${flashBrowser.found.root}`);
        if (flashBrowser.tampered) {
            console.log(`[FlashBrowser] REFUSED: ${flashBrowser.tamperReason}. Reinstall the launcher.`);
        }
    } else if (flashBrowser.offered) {
        const missing = flashBrowser.partial ? ` (missing ${flashBrowser.partial.missing.join(', ')})` : '';
        console.log(`[FlashBrowser] Not found for ${flashBrowser.target}${missing}; the game runs in Flash Player.`);
    } else {
        console.log(`[FlashBrowser] None for ${process.platform}-${process.arch}; the game runs in Flash Player.`);
    }

    projector = locateProjector(state.read().projectorPath);
    if (!projector) {
        console.log('[Flash] No standalone Flash Player found; the launcher will ask for one.');
        return;
    }

    // The same status the launcher window renders, on the console: the quickest way to
    // tell a missing Flash Player from a copy built before it was vendored.
    console.log(
        `[Flash] ${projector.source} Flash Player ${projector.version || '(version unknown)'} at ${projector.path}`
    );
    if (projector.archMismatch) {
        console.log(`[Flash] WARNING: Flash Player is ${projector.architectures.join('/')} and cannot run on this machine.`);
    }
    if (projector.tampered) {
        console.log(`[Flash] REFUSED: ${projector.tamperReason}. Reinstall the launcher.`);
    }
}

function resolveSelectedServer() {
    const { servers, defaultServerId } = loadServers();
    const saved = state.read();
    const selected =
        servers.find((entry) => entry.id === saved.serverId) ||
        servers.find((entry) => entry.id === defaultServerId) ||
        servers[0] ||
        null;

    return { servers, selected };
}

/**
 * A packaged launcher always carries its own Flash Player (and, where there is one, its
 * FlashBrowser). One that can run neither is an incomplete build -- a stale install, or a
 * package assembled without running tools/fetch-projector -- and it can never play unless
 * the player happens to have a Flash Player of their own. Refusing to start says so outright
 * instead of leaving players on a sign-in screen that leads nowhere.
 *
 * A development checkout is exempt: there, a missing Flash Player is one
 * `npm run fetch-projector` away and the window already explains it.
 * DUNGEON_BLITZ_ALLOW_NO_FLASH=1 keeps a deliberately Flash-less build startable.
 */
function buildIsPlayable() {
    if (!app.isPackaged || projectorReady() || flashBrowserReady()) {
        return true;
    }
    return process.env.DUNGEON_BLITZ_ALLOW_NO_FLASH === '1';
}

function refuseToStart() {
    const vendored = findVendoredProjector();
    const detail = [
        'This copy of the launcher has no Flash Player, so the game could not start even after signing in.',
        '',
        `Running from: ${app.getAppPath()}`,
        'This is an incomplete or outdated build.',
        '',
        'Fix: install the current build again from the .dmg or .zip, or in a development',
        'checkout run `npm run fetch-projector` and start it there.',
        '',
        'To start anyway (a deliberately Flash-less build), set DUNGEON_BLITZ_ALLOW_NO_FLASH=1.'
    ].join('\n');

    console.log('[Flash] Refusing to start: this build carries no Flash Player.');
    if (vendored) {
        console.log(`[Flash] (a vendored Flash Player was found at ${vendored} but cannot run here)`);
    }
    dialog.showErrorBox('Dungeon Blitz: R cannot start', detail);
    app.exit(1);
}

/**
 * A Windows the runtime cannot run on. The same shape as the Flash-less refusal below: name
 * what is missing and quit, rather than leaving a player on a window whose game can never
 * load. Windows 7 and 8 mostly never get this far -- Electron itself fails to start there --
 * so the README says so as well.
 */
function refuseUnsupportedWindows() {
    console.error(`[Windows] Refusing to start: ${windows.reason}`);

    // A build for an architecture there is none of is refused with its own text: the exact
    // file to download is the whole of the answer there, and burying it under the Windows
    // version requirements would send the player off to upgrade a machine that was never
    // the problem.
    //
    // The version names the installer exactly. A player who installed win-ia32 needs to
    // know which of the release's files replaces it, and the list is ordered against
    // them: GitHub sorts assets alphabetically and ia32 sorts before x64.
    const message = windows.architectureSupported
        ? unsupportedWindowsMessage(windows)
        : unsupportedArchitectureMessage(windows, { version: app.getVersion() });

    dialog.showErrorBox('Dungeon Blitz: R cannot start', message);
    app.exit(1);
}

/**
 * The lobby-chat state the launcher window shows, in one small object. The bridge is
 * deliberately quiet until the game starts, so "idle" is a normal state, not a fault.
 */
function socialSummary() {
    const snapshot = social.snapshot();
    return {
        enabled: process.env.DUNGEON_BLITZ_SOCIAL !== '0' && social.isAvailable(),
        running: Boolean(snapshot.running),
        lobbyReady: Boolean(snapshot.lobbyReady),
        authPending: Boolean(snapshot.auth),
        lobbyId: String(snapshot.lobbyId || ''),
        lastStatus: String(snapshot.lastStatus || '')
    };
}

function presenceSummary() {
    const snapshot = presence.snapshot();
    return {
        running: Boolean(snapshot.running),
        ready: Boolean(snapshot.ready),
        port: Number(snapshot.port) || 0,
        characterName: String(snapshot.characterName || ''),
        activity: String(snapshot.activity || ''),
        lastError: String(snapshot.lastError || '')
    };
}

function flashStatus() {
    if (!projector) {
        return {
            found: false,
            armed: false,
            locked: app.isPackaged,
            tampered: false,
            path: '',
            version: '',
            source: '',
            architectures: [],
            archMismatch: false
        };
    }

    return {
        found: true,
        armed: projectorReady(),
        // A packaged launcher runs only its own, verified Flash Player; there is nothing to
        // choose by hand.
        locked: app.isPackaged,
        tampered: Boolean(projector.tampered),
        path: projector.path,
        version: projector.version,
        source: projector.source,
        architectures: projector.architectures,
        archMismatch: projector.archMismatch
    };
}

/** FlashBrowser, the default engine, in the launcher state. */
function flashBrowserStatus() {
    return {
        // Whether this system has a FlashBrowser build at all: Windows x64 and macOS do; 32-bit
        // Windows and Linux play in Flash Player only.
        offered: Boolean(flashBrowser.offered),
        found: Boolean(flashBrowser.found),
        ready: flashBrowserReady(),
        locked: app.isPackaged,
        tampered: Boolean(flashBrowser.tampered),
        missing: flashBrowser.partial ? flashBrowser.partial.missing.slice() : []
    };
}

/** Which Windows this is, in the launcher state: what this machine is and what it can do. */
function windowsStatus() {
    return {
        supported: Boolean(windows.supported),
        product: String(windows.product || ''),
        architecture: String(windows.arch || ''),
        architectureSupported: Boolean(windows.architectureSupported),
        reason: String(windows.reason || ''),
        requirements: String(windows.requirements || '')
    };
}

/** What the widget-stats pipeline is doing, for the window's status strip. */
function gameStatsSummary() {
    const snapshot = gameStats.snapshot();
    return {
        enabled: process.env.DUNGEON_BLITZ_GAME_STATS !== '0',
        running: Boolean(snapshot.running),
        state: String(snapshot.state || 'idle'),
        written: Boolean(snapshot.written),
        username: String(snapshot.username || ''),
        updatedAt: Number(snapshot.updatedAt) || 0,
        lastError: String(snapshot.lastError || '')
    };
}

/** What the chat mirror is doing, for the window's status strip. */
function chatSummary() {
    const snapshot = chatRelay.snapshot();
    return {
        enabled: process.env.DUNGEON_BLITZ_CHAT_RELAY !== '0',
        running: Boolean(snapshot.running),
        supported: snapshot.supported,
        relayed: Number(snapshot.relayed) || 0,
        received: Number(snapshot.received) || 0,
        lastError: String(snapshot.lastError || '')
    };
}

function launcherState() {
    const { servers, selected } = resolveSelectedServer();

    return {
        appVersion: app.getVersion(),
        servers,
        selectedServerUrl: selected ? selected.url : '',
        serverReachable,
        gameRunning: gameRunning(),
        gameEngine,
        engine: preferredEngine(),
        windows: windowsStatus(),
        flash: flashStatus(),
        flashBrowser: flashBrowserStatus(),
        presence: presenceSummary(),
        social: socialSummary(),
        chat: chatSummary(),
        gameStats: gameStatsSummary(),
        install: {
            relocate: Boolean(installLocation.relocate),
            reason: String(installLocation.reason || ''),
            message: String(installLocation.message || ''),
            sourcePath: String(installLocation.bundlePath || ''),
            targetPath: String(installLocation.targetPath || ''),
            canMove: Boolean(installLocation.targetPath)
        },
        update: updateService
            ? updateService.summary()
            : { state: 'disabled', percent: 0, version: '', error: '', currentVersion: app.getVersion(), lastCheckedAt: 0 },
        discord: {
            ...discordAccount,
            remembered,
            loginPending: Boolean(loginWatcher),
            loginLinkAvailable: Boolean(loginWatcher && loginLink),
            loginCodeRequired: Boolean(loginWatcher && loginCode.required),
            loginCodeRejected: Boolean(loginWatcher && loginCode.rejected),
            loginCodeEnded: Boolean(!loginWatcher && loginCode.ended)
        }
    };
}

function pushState() {
    if (launcherWindow && !launcherWindow.isDestroyed()) {
        launcherWindow.webContents.send('launcher:state', launcherState());
    }
}

// The Social SDK runs headless: it puts the player in the Discord lobby, and Discord's
// own client is where lobby chat and the party roster are read. Nothing to render here.
let lastLoggedSocialStatus = '';
// Presence changes (Discord reached, character changed, Discord closed) belong in the
// status strip for the same reason: the window is where this is checked.
presence.on('state', () => pushState());

social.on('state', (snapshot) => {
    // Patches that carry no status (a lobby_ready's running flag, stop()) re-surface the
    // previous status; logging only changes keeps the console one-line-per-event.
    if (snapshot.lastStatus && snapshot.lastStatus !== lastLoggedSocialStatus) {
        lastLoggedSocialStatus = snapshot.lastStatus;
        console.log(`[Social] ${snapshot.lastStatus}`);
    }

    // The bridge knows the Discord account it authorized as; keeping that is what lets the
    // launcher greet the player by name without another sign-in.
    if (snapshot.username && snapshot.username !== discordAccount.name) {
        rememberDiscordLogin(discordAccount.email, snapshot.username);
    }
    // The window shows the bridge state, so every change has to reach it.
    pushState();
});

function createLauncherWindow() {
    launcherWindow = new BrowserWindow({
        width: 460,
        height: 580,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        backgroundColor: '#1d1e26',
        title: 'Dungeon Blitz: R',
        show: false,
        icon: windowIcon,
        webPreferences: {
            preload: path.join(LAUNCHER_ROOT, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // preload.js needs nothing but contextBridge and ipcRenderer, both of which a
            // sandboxed preload has.
            sandbox: true,
            // The launcher shell hosts no plugins; the game runs in FlashBrowser or the
            // standalone Flash Player, each its own program.
            plugins: false,
            // No developer tools in an installed launcher: they are a console onto the IPC
            // calls that start the game.
            devTools: !app.isPackaged,
            webviewTag: false
        }
    });

    launcherWindow.setMenuBarVisibility(false);
    launcherWindow.loadFile(path.join(LAUNCHER_ROOT, 'renderer', 'index.html'));
    launcherWindow.once('ready-to-show', () => launcherWindow.show());
    launcherWindow.on('closed', () => {
        launcherWindow = null;
    });
}

function openExternal(url) {
    const safeUrl = normalizeHttpUrl(url);
    if (!safeUrl) {
        return;
    }
    void shell.openExternal(safeUrl);
}

// Presence and lobby chat belong to a game session, so closing the game ends both;
// keeping them up would leave the player shown as playing nothing.
function endGameSession() {
    gameHost.stop();
    presence.stop();
    chatRelay.stop();
    gameStats.stop();
    stopAccountPolling();
    if (launcherWindow && !launcherWindow.isDestroyed()) {
        launcherWindow.show();
    } else if (!BrowserWindow.getAllWindows().length && process.platform !== 'darwin') {
        // The player closed the launcher while playing; with the game gone too there is
        // nothing left open, which is when the launcher has always quit.
        app.quit();
    }
    pushState();
}

/**
 * Starts the program that runs the game, and ends the game session when it exits.
 *
 * @param {string} label How the console names it.
 * @returns {Promise<{ ok: boolean, message?: string, child?: import('child_process').ChildProcess }>}
 */
async function spawnGame(engine, label, { command, args, cwd, env }) {
    let child;
    try {
        child = spawn(command, args, { stdio: 'ignore', windowsHide: false, cwd, env });
    } catch (error) {
        return { ok: false, message: `${label} could not be started: ${(error && error.message) || error}` };
    }

    // A spawn that fails (a missing or non-executable file) leaves no pid and reports why
    // as an 'error' on the next tick.
    if (!child.pid) {
        const error = await new Promise((resolve) => child.once('error', resolve));
        return { ok: false, message: `${label} could not be started: ${(error && error.message) || error}` };
    }
    child.on('error', (error) => console.log(`[${label}] ${(error && error.message) || error}`));

    gameProcess = child;
    gameEngine = engine;
    child.once('exit', (code, signal) => {
        console.log(`[${label}] exited (${signal || `code ${code}`})`);
        if (gameProcess === child) {
            gameProcess = null;
            gameEngine = '';
            endGameSession();
        }
    });
    return { ok: true, child };
}

/**
 * Opens the game in Adobe's standalone Flash Player.
 *
 * The projector loads the SWF straight from the server, so the game connects exactly as
 * it does from the page, in Flash Player's own window and renderer. The game page's own
 * script does not run there; lib/gameHost.js does its work instead.
 *
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
async function launchProjector(serverUrl, settings) {
    // Checked again at the moment of starting, not only at launch: the install folder can be
    // written to while the launcher sits on its sign-in screen.
    if (app.isPackaged) {
        const check = verifyProjector(projector.path);
        if (!check.ok) {
            projector.tampered = true;
            projector.tamperReason = check.reason;
            console.log(`[Flash] REFUSED: ${check.reason}`);
            return { ok: false, message: `${check.reason}. Reinstall the launcher to play.` };
        }
    }

    const swfUrl = await resolveSwfUrl(serverUrl);
    let launch;
    try {
        launch = prepareLaunch(projector, swfUrl, { workDir: path.join(app.getPath('userData'), 'game') });
    } catch (error) {
        return { ok: false, message: `Flash Player could not be prepared: ${(error && error.message) || error}` };
    }
    const { command, args, cwd, env } = launch;
    console.log(`[Flash] Starting ${command} ${args.join(' ')}${cwd ? ` in ${cwd}` : ''} for ${swfUrl}`);

    const started = await spawnGame('projector', 'Flash Player', { command, args, cwd, env });
    if (!started.ok) {
        return started;
    }

    // The window says "Dungeon Blitz: R", never Flash Player's name or the game's address.
    const title = keepGameTitle(started.child.pid);
    started.child.once('exit', () => title.stop());

    gameHost.start({ serverUrl, presence: Boolean(settings.startDiscordBridge) });
    startAccountPolling();
    return { ok: true };
}

/**
 * Opens the game page in FlashBrowser: Electron 11 with FlashBrowser's PPAPI Flash plugin,
 * started as its own program because the launcher's Chromium can no longer host the plugin.
 *
 * The page runs its own script there -- rich presence, region latency and the in-game Discord
 * sign-in -- exactly as it did in the launcher's old game window, so lib/gameHost.js stays off.
 *
 * @returns {Promise<{ ok: boolean, message?: string }>}
 */
async function launchFlashBrowser(serverUrl) {
    const found = flashBrowser.found;
    if (app.isPackaged) {
        const check = verifyFlashBrowser(found.root, { target: flashBrowser.target });
        if (!check.ok) {
            flashBrowser.tampered = true;
            flashBrowser.tamperReason = check.reason;
            console.log(`[FlashBrowser] REFUSED: ${check.reason}`);
            return { ok: false, message: `${check.reason}. Reinstall the launcher, or play Legacy.` };
        }
    }

    const launch = prepareFlashBrowserLaunch(found, {
        gameUrl: serverUrl,
        // Its own profile: two Chromium versions must never share one.
        userDataDir: path.join(app.getPath('userData'), 'flashbrowser'),
        devTools: !app.isPackaged,
        // The damage meter on the game page (flashbrowser/damageMeter) reads the server's combat
        // feed as this launcher's account. Off with DUNGEON_BLITZ_DAMAGE_METER=0.
        damageMeter: damageMeterEnabled ? { version: app.getVersion(), launcherToken: sessionCache.read().token || '' } : null
    });
    console.log(`[FlashBrowser] Starting ${launch.command} for ${serverUrl}`);

    const started = await spawnGame('flashbrowser', 'FlashBrowser', launch);
    if (!started.ok) {
        return started;
    }
    // Whoever the game ends up signing in as is remembered for the next launch.
    startAccountPolling();
    return { ok: true };
}

function stopGameProcess() {
    if (gameProcess) {
        const child = gameProcess;
        gameProcess = null;
        gameEngine = '';
        try {
            child.kill();
        } catch {
            // Already gone.
        }
    }
}

/**
 * @param {{ engine?: string, serverId?: string }} [options] `engine` is the button the player
 *   pressed ('flashbrowser' or 'projector'), and is remembered for the next plain play; without
 *   it the preferred engine runs.
 */
async function play({ engine: requested = '', serverId = '' } = {}) {
    if (gameProcess) {
        // The game's window is its own program's; it is already open.
        return { ok: true };
    }

    const { servers, selected: fallback } = resolveSelectedServer();
    // An explicit pick from the advanced list wins; otherwise this is the saved choice,
    // and on a first run the configured default -- the official server.
    const selected = servers.find((entry) => entry.id === serverId) || fallback;

    if (!selected) {
        return { ok: false, message: 'No servers configured. Check servers.json.' };
    }

    const chosen = ENGINES.includes(requested);
    const engine = chosen ? requested : preferredEngine();
    const problem = engineProblem(engine);
    if (problem) {
        return { ok: false, message: problem };
    }

    state.write(chosen ? { serverId: selected.id, engine } : { serverId: selected.id });

    // Before Flash Player starts, not after: the server signs the game's first connection
    // in from a pending hand-off, and the point of the saved token is that there is already
    // one waiting. An expired token is the one case that stops the launch: continuing would
    // drop the player into the SWF's password path with a perfectly good account.
    const resumed = await resumeLauncherSession(selected.url);
    if (resumed.expired) {
        pushState();
        return {
            ok: false,
            message: 'Your saved sign-in is no longer valid. Sign in with Discord again.'
        };
    }

    const settings = state.read();
    if (settings.startDiscordBridge) {
        presence.start({ serverUrl: selected.url, gameWindowPid: process.pid });
    }

    // The game's own chat and the Discord lobby are mirrored in both directions for as
    // long as the game window is open.
    if (settings.startSocialBridge && process.env.DUNGEON_BLITZ_SOCIAL !== '0' && process.env.DUNGEON_BLITZ_CHAT_RELAY !== '0') {
        chatRelay.start({ serverUrl: selected.url });
    }

    // Lobby chat belongs to a game session. Starting the social bridge here rather than
    // at launch is what keeps the launcher from opening a browser for Discord
    // authorization before the player has asked for anything; once it starts, the
    // session is exactly what it always was. Repeated plays are no-ops -- the bridge
    // returns early while it is already running.
    if (settings.startSocialBridge && process.env.DUNGEON_BLITZ_SOCIAL !== '0') {
        social.start({
            serverUrl: selected.url,
            // Read at the moment of asking: the resume above rotates the token.
            getLauncherToken: () => sessionCache.read().token || ''
        });
    }

    // The widget profile is written for the player by the server, and a play session is when
    // the ask belongs: the launcher token that identifies them was just resumed above, and
    // the server reads the player's Discord account off it. One ask per session keeps the
    // profile current without the player having to do anything.
    if (process.env.DUNGEON_BLITZ_GAME_STATS !== '0') {
        gameStats.start({
            serverUrl: selected.url,
            getLauncherToken: () => sessionCache.read().token || ''
        });
        void gameStats.sync();
    }

    const launched =
        engine === 'flashbrowser' ? await launchFlashBrowser(selected.url) : await launchProjector(selected.url, settings);
    if (!launched.ok) {
        gameHost.stop();
        presence.stop();
        chatRelay.stop();
        gameStats.stop();
    }
    pushState();
    return launched;
}

// Discord's consent screen is sent to the player's own browser, never rendered here: the
// launcher window shows only its own page and loads no remote content at all.
//
// Nothing is lost by leaving: each sign-in carries a one-time key of the launcher's own
// (lib/discordAuth.js), and the server files the completed login under it as well as under the
// browser's address, so the launcher's poll sees the sign-in the player completed in their
// browser -- even a browser behind a VPN or proxy the launcher is not.
function openDiscordLogin() {
    const { selected } = resolveSelectedServer();
    if (!selected) {
        return { ok: false, message: 'No server selected.' };
    }
    if (loginWatcher) {
        return { ok: true };
    }

    const loginKey = discordAuth.createLoginKey();
    const authUrl = discordAuth.loginUrl(selected.url, loginKey);
    if (!normalizeHttpUrl(authUrl)) {
        return { ok: false, message: 'The sign-in address is not valid.' };
    }

    // On Linux Electron reports the browser as opened even when xdg-open failed, so the window
    // also offers the link to copy for as long as the sign-in is pending.
    loginLink = authUrl;
    loginCode = { required: false, rejected: false, ended: false };
    pendingLoginCode = '';
    openExternal(authUrl);

    const watcher = discordAuth.watchForLogin(selected.url, {
        loginKey,
        // A code is sent once per time the player enters it: each wrong one counts on the server.
        takeLoginCode: () => {
            const code = pendingLoginCode;
            pendingLoginCode = '';
            return code;
        },
        onCodeStatus: ({ codeRequired, codeRejected }) => {
            // The server dropped the sign-in after too many wrong codes: stop waiting on it.
            const ended = codeRejected && !codeRequired;
            // "Wrong code" stays up until the player enters another one, not just for the one poll
            // that carried the wrong code.
            const next = { required: codeRequired, rejected: codeRejected || (loginCode.rejected && codeRequired), ended };
            if (next.required !== loginCode.required || next.rejected !== loginCode.rejected || next.ended !== loginCode.ended) {
                loginCode = next;
                pushState();
            }
            if (ended) {
                watcher.cancel();
            }
        }
    });
    loginWatcher = watcher;
    void watcher.promise.then(async (pending) => {
        loginWatcher = null;
        loginLink = '';
        pendingLoginCode = '';
        if (!pending) {
            pushState();
            return;
        }

        rememberDiscordLogin(pending.email);
        // While the hand-off this sign-in created is still live, which is what the server
        // grants the token against. It is also what play() below spends, so the token has to
        // be asked for first.
        await captureLauncherSession(selected.url, pending.email, loginKey);
        // A game already open needs nothing: the server's OAuth callback signs its open
        // connection in by itself. Otherwise this sign-in is what the player was waiting on.
        if (!gameProcess) {
            await play();
        }
        pushState();
    });

    pushState();
    return { ok: true };
}

// Signing in once is enough -- but "once" used to mean "once per launch".
//
// The server's Discord hand-off is a two-minute record keyed by the player's address, and
// the login packet spends it. What is kept now is a device token the server issues after a
// real Discord sign-in (lib/launcherSession.js); redeeming it on the next start recreates
// exactly the hand-off the OAuth callback would have, so the server signs the game's
// connection in as usual. The account *name* is kept on top of that, so the window can greet a
// returning player instead of offering the sign-in button again.
function rememberDiscordLogin(email, name) {
    const nextEmail = String(email || '').trim();
    const nextName = String(name || '').trim();
    const changed = nextEmail !== discordAccount.email || nextName !== discordAccount.name || !discordAccount.linked;

    discordAccount = { linked: true, email: nextEmail, name: nextName || discordAccount.name };
    remembered = true;

    // Written only on a change: this runs from a poll.
    if (changed) {
        state.write({
            discordEmail: discordAccount.email,
            discordName: discordAccount.name,
            discordLinkedAt: Date.now()
        });
    }
}

function restoreDiscordLogin() {
    const saved = state.read();
    const cached = sessionCache.read();
    if (!saved.discordLinkedAt && !cached.token) {
        return;
    }
    // The session cache is the authority on the email -- it is what the token was issued
    // against -- and the saved name is the display the window shows.
    discordAccount = {
        linked: true,
        email: cached.email || saved.discordEmail,
        name: saved.discordName || discordAccount.name
    };
    remembered = true;
}

function forgetDiscordLogin() {
    const { selected } = resolveSelectedServer();
    const cached = sessionCache.read();
    if (selected && cached.token) {
        // Best effort: the local copy goes either way, and a token the server still holds
        // expires on its own.
        void discordAuth.forgetSession(selected.url, cached.token);
    }
    sessionCache.clear();
    discordAccount = { linked: false, email: '', name: '' };
    remembered = false;
    state.write({ discordEmail: '', discordName: '', discordLinkedAt: 0 });
}

/**
 * Reads back the account the player is actually playing as.
 *
 * A player who signs in inside the game -- the SWF's own Discord flow, or simply a
 * session that outlived the launcher -- never touches the launcher's sign-in button, so
 * the launcher used to ask again on the next launch. The server can tell who is behind
 * the connection that is asking, and only while that connection is in the game, so this
 * runs while a game session is up and remembers what it finds.
 *
 * Knowing the name is not enough on its own: the routes that do something *as* the player --
 * the widget sync, the linked lobby -- take the device token, and the player who signed in
 * inside the game is exactly the one with no token here. So the same moment is used to take
 * the token too, before the sign-in that proves it goes stale (see below).
 */
async function refreshDiscordAccount() {
    const { selected } = resolveSelectedServer();
    if (!selected) {
        return;
    }

    const account = await discordAuth.fetchDiscordAccount(selected.url);
    if (!account || !account.linked) {
        return;
    }

    const name = account.globalName || account.username || discordAccount.name;
    if (!discordAccount.linked || name !== discordAccount.name || account.email !== discordAccount.email) {
        rememberDiscordLogin(account.email, name);
        pushState();
    }

    return captureLauncherSessionFromGameSession();
}

// The device token, for a player who signed in with Discord inside the game rather than through
// the launcher's own sign-in button. Without it the widget sync has nobody to ask about itself
// and answers 401 forever for those players, which is what made the widget appear for some and
// never for others. lib/launcherSessionRecovery.js holds the rules; this is only the wiring.
const sessionRecovery = createLauncherSessionRecovery({
    readToken: () => sessionCache.read().token,
    // Read at the moment of asking: the player can switch servers between plays.
    issueSession: () => {
        const { selected } = resolveSelectedServer();
        return selected ? discordAuth.issueSession(selected.url) : null;
    },
    onCaptured: (token, email) => sessionCache.write(token, email)
});

/**
 * Tries to take a device token from the sign-in this game session is running on.
 *
 * @returns {Promise<boolean>} Whether one was taken, so the caller can ask the server again
 *   for what the missing token just refused: a widget profile to write.
 */
async function captureLauncherSessionFromGameSession() {
    const result = await sessionRecovery.capture();
    if (!result.captured) {
        return false;
    }

    console.log('[LauncherSession] Took a device token from the game session\'s own Discord sign-in');
    return true;
}

// The game session appears a few seconds after the window opens, so the account is looked
// up again for a short while rather than once at the wrong moment -- and for a little longer
// than it takes to see the name, because a sign-in the player completes inside the game is
// what the device token is captured from, and the server keeps the proof of that sign-in for
// two minutes. A poll that stopped at the first name it read would miss it.
let accountPollTimer = null;
let accountPollAttempts = 0;
const ACCOUNT_POLL_ATTEMPTS = 24;

function startAccountPolling() {
    stopAccountPolling();
    accountPollAttempts = 0;
    sessionRecovery.reset();
    accountPollTimer = setInterval(() => {
        accountPollAttempts += 1;
        void refreshDiscordAccount().then((captured) => {
            // A token taken after the widget ask means the ask was refused for want of it, and
            // the answer is a profile Discord can now be written for.
            if (captured) {
                void gameStats.sync();
            }
        });
        if (accountPollAttempts >= ACCOUNT_POLL_ATTEMPTS) {
            stopAccountPolling();
        }
    }, 5000);
}

function stopAccountPolling() {
    if (accountPollTimer) {
        clearInterval(accountPollTimer);
        accountPollTimer = null;
    }
}

/** Take the device token the server offers while this sign-in is still fresh. */
async function captureLauncherSession(gameUrl, email, loginKey = '') {
    const issued = await discordAuth.issueSession(gameUrl, loginKey);
    if (!issued) {
        // An older server, or one that did not offer one. The player is signed in for this
        // session; the next start simply asks again, which is where we started.
        return;
    }
    sessionCache.write(issued.token, issued.email || email);
}

/**
 * Turn a saved token back into a sign-in, before the game window opens.
 *
 * Only an outright refusal (401) drops the saved sign-in -- a server that is old, down or slow
 * must not sign the player out. Anything else carries on exactly as the launcher did before.
 *
 * @returns {Promise<{ resumed: boolean, expired: boolean }>}
 */
async function resumeLauncherSession(gameUrl) {
    const cached = sessionCache.read();
    if (!cached.token) {
        return { resumed: false, expired: false };
    }

    const result = await discordAuth.resumeSession(gameUrl, cached.token);
    if (result.ok) {
        // The old token stopped working the moment the server answered, so the replacement is
        // saved before anything else can fail.
        sessionCache.write(result.token, result.email || cached.email);
        rememberDiscordLogin(result.email || cached.email);
        return { resumed: true, expired: false };
    }

    if (result.expired) {
        sessionCache.clear();
        discordAccount = { linked: false, email: '' };
        remembered = false;
        state.write({ discordEmail: '', discordLinkedAt: 0 });
        return { resumed: false, expired: true };
    }

    return { resumed: false, expired: false };
}

async function refreshServerStatus() {
    const { selected } = resolveSelectedServer();
    if (!selected) {
        serverReachable = null;
        pushState();
        return;
    }

    const config = await discordAuth.fetchConfig(selected.url);
    serverReachable = config.reachable;
    pushState();
}

/**
 * Puts this copy where it belongs and restarts from there.
 *
 * The copy is what updates stop reaching and what the player stops recognising; offering
 * the move is the difference between a warning nobody acts on and a one-click fix.
 */
function moveToApplications() {
    const target = String(installLocation.targetPath || '');
    const source = String(installLocation.bundlePath || '');
    if (!target || !source) {
        return { ok: false, message: 'This build cannot move itself. Install it again from the installer.' };
    }

    if (!isWritableDirectory(path.dirname(target))) {
        return { ok: false, message: `${path.dirname(target)} is not writable by this user.` };
    }

    try {
        if (exists(target)) {
            fs.rmSync(target, { recursive: true, force: true });
        }
        // ditto is the macOS way to copy a bundle: it preserves symlinks, permissions and
        // the app's signature, which a plain recursive copy does not.
        require('child_process').execFileSync('ditto', [source, target], { stdio: 'ignore' });
    } catch (error) {
        return { ok: false, message: `Could not copy the launcher: ${(error && error.message) || error}` };
    }

    console.log(`[Install] Moved to ${target}`);

    const executableInBundle = app.getPath('exe').replace(source, '');
    app.relaunch({ execPath: path.join(target, executableInBundle) });
    app.exit(0);
    return { ok: true };
}

/**
 * The standalone warning, for a player who launched from a disk image and never opens the
 * window's own banner.
 */
async function warnAboutInstallLocation() {
    if (!installLocation.relocate) {
        return;
    }

    const buttons = installLocation.targetPath ? ['Move to Applications', 'Not now'] : ['OK'];
    const options = {
        type: 'warning',
        title: 'This copy cannot update itself',
        message: installLocation.message,
        detail: [
            installLocation.targetPath ? `Move it to: ${installLocation.targetPath}` : '',
            'Running the current build is what keeps Flash arming and lobby chat working.'
        ]
            .filter(Boolean)
            .join('\n'),
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1
    };
    const result =
        launcherWindow && !launcherWindow.isDestroyed()
            ? await dialog.showMessageBox(launcherWindow, options)
            : await dialog.showMessageBox(options);

    if (result.response === 0 && installLocation.targetPath) {
        const moved = moveToApplications();
        if (!moved.ok) {
            dialog.showErrorBox('Could not move the launcher', String(moved.message || ''));
        }
    }
}

function registerIpc() {
    ipcMain.handle('launcher:getState', () => launcherState());

    ipcMain.handle('launcher:discordLogin', () => openDiscordLogin());

    // The code the browser page shows, for a launcher the server cannot match by address. It is
    // only kept until the next poll sends it.
    ipcMain.handle('launcher:submitLoginCode', (_event, code) => {
        const cleaned = String(code || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 16);
        if (!loginWatcher || !cleaned) {
            return { ok: false };
        }
        pendingLoginCode = cleaned;
        loginCode = { ...loginCode, rejected: false };
        pushState();
        return { ok: true };
    });

    // For a browser that did not open, or opened somewhere the player is not looking.
    ipcMain.handle('launcher:copySignInLink', () => {
        if (!loginWatcher || !loginLink) {
            return { ok: false };
        }
        clipboard.writeText(loginLink);
        return { ok: true };
    });

    ipcMain.handle('launcher:forgetDiscordLogin', () => {
        forgetDiscordLogin();
        return launcherState();
    });

    ipcMain.handle('launcher:browseFlash', async () => {
        if (app.isPackaged) {
            return { ...launcherState(), notice: 'This launcher only runs the Flash Player it was installed with.' };
        }
        const filters =
            process.platform === 'win32'
                ? [{ name: 'Flash Player', extensions: ['exe'] }]
                : process.platform === 'darwin'
                  ? [{ name: 'Flash Player', extensions: ['app'] }]
                  : [{ name: 'Flash Player', extensions: ['*'] }];

        const result = await dialog.showOpenDialog(launcherWindow, {
            title: 'Choose Flash Player (flashplayer_32_sa)',
            // A macOS .app is a folder; picking it needs openDirectory as well.
            properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
            filters
        });

        if (result.canceled || !result.filePaths.length) {
            return launcherState();
        }

        const chosen = result.filePaths[0];
        if (!isChosenProjector(chosen)) {
            return { ...launcherState(), notice: 'That is not the standalone Flash Player (flashplayer_32_sa).' };
        }
        // The projector is started per game, so a new one applies on the next play with no
        // restart.
        state.write({ projectorPath: chosen });
        projector = locateProjector(chosen);
        return launcherState();
    });

    ipcMain.handle('launcher:relaunch', () => {
        app.relaunch();
        app.exit(0);
    });

    ipcMain.handle('launcher:moveToApplications', () => moveToApplications());

    ipcMain.handle('launcher:updateInstall', () => (updateService ? updateService.restartToUpdate() : false));

    // The manual retry, for the player who just linked their Discord account and wants the
    // widget filled without opening the game again.
    ipcMain.handle('launcher:gameStatsSync', async () => {
        // The player presses this right after signing in with Discord inside the game, which is
        // the moment the widget usually needs a nudge -- and by then the account poll has long
        // since stopped, so the device token for that sign-in is taken here instead. The ask
        // then follows it: a launcher with no token has nobody to be written for.
        sessionRecovery.reset();
        await refreshDiscordAccount();
        await gameStats.sync();
        return gameStatsSummary();
    });

    // The renderer names the button that was pressed; anything else is a plain play.
    ipcMain.handle('launcher:play', (_event, engine) => play({ engine: typeof engine === 'string' ? engine : '' }));
    ipcMain.handle('launcher:quit', () => app.quit());
}

/**
 * Whether an installed launcher was started to be inspected or instrumented: a Node or
 * Chromium debugger, or NODE_OPTIONS loading code ahead of the launcher's own.
 *
 * The build's Electron fuses (package.json build.electronFuses) already switch off the Node
 * --inspect flags, NODE_OPTIONS and ELECTRON_RUN_AS_NODE in the binary. This check stays as
 * a second line: it also covers the Chromium switches no fuse governs
 * (--remote-debugging-port, --js-flags), and a binary whose fuses were flipped back. A
 * development checkout is never refused.
 */
function instrumentationDetected() {
    if (!app.isPackaged) {
        return '';
    }

    const switches = ['inspect', 'inspect-brk', 'inspect-port', 'remote-debugging-port', 'remote-debugging-pipe', 'js-flags'];
    const flagged = switches.find((name) => app.commandLine.hasSwitch(name));
    if (flagged) {
        return `--${flagged}`;
    }
    const argument = process.argv.find((arg) => /^--(inspect|remote-debugging|js-flags)/.test(arg));
    if (argument) {
        return argument.split('=')[0];
    }
    if (/(^|\s)(--require|-r|--inspect|--loader|--experimental-loader)\b/.test(String(process.env.NODE_OPTIONS || ''))) {
        return 'NODE_OPTIONS';
    }
    try {
        if (require('inspector').url()) {
            return 'an attached debugger';
        }
    } catch {
        // No inspector module: nothing can be attached through it.
    }
    return '';
}

// Every page the launcher ever shows is its own: nothing may navigate one elsewhere, open a
// window, embed a webview, or -- in an installed launcher -- keep developer tools open.
app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
        event.preventDefault();
        openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
        openExternal(url);
        return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    if (app.isPackaged) {
        contents.on('devtools-opened', () => contents.closeDevTools());
    }
});

const instrumentation = instrumentationDetected();
if (instrumentation) {
    console.error(`[Launcher] Refusing to run: started with ${instrumentation}.`);
    dialog.showErrorBox(
        'Dungeon Blitz: R cannot start',
        `The launcher was started with ${instrumentation}, which an installed launcher does not allow.\n\n` +
            'Start it normally from its shortcut.'
    );
    app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const target = launcherWindow;
        if (target && !target.isDestroyed()) {
            if (target.isMinimized()) {
                target.restore();
            }
            target.show();
            target.focus();
        }
    });

    findFlashPlayer();
    restoreDiscordLogin();
    installLocation = inspectInstallLocation({ isPackaged: app.isPackaged, appPath: app.getAppPath() });
    if (installLocation.relocate) {
        console.warn(`[Install] ${installLocation.message} (running from ${installLocation.bundlePath})`);
    }
    // The updater only arms in a packaged build: a checkout updates by git pull, and a dev
    // AppImage is exactly the kind of install that must not write over itself.
    if (app.isPackaged) {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.autoDownload = true;
        // The floor: if the player ignores the restart prompt, the update still lands on
        // the next quit. The prompt itself is never a forced restart (game may be open).
        autoUpdater.autoInstallOnAppQuit = true;
        updateService = createUpdateService({
            autoUpdater,
            app,
            log: (message) => console.log(message)
        });
        updateService.on('state', () => pushState());
        updateService.start();
    }
    registerIpc();

    app.whenReady().then(() => {
        // Checked before the Flash guard because nothing below it can matter on a Windows
        // the runtime cannot run on at all.
        if (!windows.supported) {
            refuseUnsupportedWindows();
            return;
        }

        if (!buildIsPlayable()) {
            refuseToStart();
            return;
        }

        createLauncherWindow();
        applyDockIcon();
        void refreshServerStatus();
        void warnAboutInstallLocation();
        // Covers a session that outlived the launcher: the account is there to be found
        // even before a game window is opened.
        void refreshDiscordAccount();

        // A player who has signed in before is not asked again: play() redeems the saved
        // device token on the way, so the game finds a sign-in waiting for it. If the
        // token has been revoked or has expired, play() says so and the launcher window is
        // already up with the Discord button on it.
        if (remembered && (flashBrowserReady() || projectorReady())) {
            void play();
        }

        app.on('activate', () => {
            if (!BrowserWindow.getAllWindows().length) {
                createLauncherWindow();
                applyDockIcon();
            }
        });
    });

    app.on('window-all-closed', () => {
        // The game's window is not one of ours -- FlashBrowser and Flash Player are their own
        // programs: closing the launcher while the game is open leaves the session running.
        // endGameSession() quits once the game closes too.
        if (gameProcess) {
            return;
        }
        presence.stop();
        chatRelay.stop();
        social.stop();
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('before-quit', () => {
        stopGameProcess();
        gameHost.stop();
        presence.stop();
        chatRelay.stop();
        gameStats.stop();
        social.stop();
        if (updateService) {
            updateService.stop();
        }
    });
}
