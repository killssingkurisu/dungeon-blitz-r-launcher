'use strict';

/**
 * The FlashBrowser game window: the game page, with the PPAPI Flash plugin, in a Chromium 87
 * window of its own.
 *
 * This is the engine the launcher used before Adobe's standalone Flash Player, and it is the
 * default again. The launcher itself runs on a current Electron, whose Chromium cannot load
 * PPAPI plugins any more, so this window is a separate program: Electron 11 -- the last
 * Electron whose Chromium still hosts Flash, the same runtime FlashBrowser is built on -- with
 * the FlashBrowser plugin (Flash 32.0.0.363, before Adobe's kill switch). The launcher starts
 * it for each game and waits for it to close (lib/flashBrowser.js); it never shares the
 * launcher's own process or profile.
 *
 * It runs on Node 12: nothing newer than that may be used here.
 *
 * Arguments, after the app folder:
 *   --db-game-url=<url>        the game page to open; only its origin may be navigated to
 *   --db-plugin=<path>         the PPAPI plugin (pepflashplayer64.dll, PepperFlashPlayer.plugin)
 *   --db-flash-version=<v>     the plugin's version, repeated back to the page
 *   --db-user-data=<dir>       this window's own profile (cookies, local storage, window size)
 *   --db-devtools              allow developer tools (a development checkout only)
 *   --db-damage-meter=<v>      put the damage meter (damageMeter/) on the game page, naming the
 *                              launcher's version in its exports; it reads the game server's
 *                              combat feed as the launcher's account, whose token comes in
 *                              DUNGEON_BLITZ_LAUNCHER_TOKEN (read once, then dropped from the
 *                              environment)
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron');

const TITLE = 'Dungeon Blitz: R';
const DEFAULT_BOUNDS = { width: 1200, height: 800 };
const MIN_SIZE = { width: 800, height: 600 };
const BACKGROUND_COLOR = '#484955';
const ICON_PATH = path.join(__dirname, 'icon.png');

function option(name) {
    const prefix = `--db-${name}=`;
    const found = process.argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : '';
}

function originOf(url) {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

function isHttpUrl(url) {
    try {
        const { protocol } = new URL(url);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}

const gameUrl = option('game-url');
const pluginPath = option('plugin');
const flashVersion = option('flash-version') || '32.0.0.363';
const userDataDir = option('user-data');
const devTools = process.argv.includes('--db-devtools');
const damageMeterWanted = process.argv.some((arg) => arg === '--db-damage-meter' || arg.startsWith('--db-damage-meter='));
const launcherVersion = option('damage-meter');
const launcherToken = String(process.env.DUNGEON_BLITZ_LAUNCHER_TOKEN || '');
delete process.env.DUNGEON_BLITZ_LAUNCHER_TOKEN;
const gameOrigin = originOf(gameUrl);

const startable = isHttpUrl(gameUrl) && Boolean(pluginPath);
if (!startable) {
    console.error('[FlashBrowser] Started without a game address or a Flash plugin.');
    app.exit(2);
}

// Chromium reads the plugin switches once, while it starts up.
app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
app.commandLine.appendSwitch('ppapi-flash-version', flashVersion);
app.setName(TITLE);
if (userDataDir) {
    app.setPath('userData', userDataDir);
}

const boundsPath = () => path.join(app.getPath('userData'), 'window-state.json');

function readBounds() {
    try {
        const saved = JSON.parse(fs.readFileSync(boundsPath(), 'utf8'));
        return saved && typeof saved === 'object' ? saved : {};
    } catch {
        return {};
    }
}

function writeBounds(bounds) {
    try {
        fs.mkdirSync(path.dirname(boundsPath()), { recursive: true });
        fs.writeFileSync(boundsPath(), JSON.stringify(bounds));
    } catch {
        // A window that opens at the default size next time is all that is lost.
    }
}

function openExternal(url) {
    if (isHttpUrl(url)) {
        void shell.openExternal(url);
    }
}

let gameWindow = null;
let damageMeter = null;

/**
 * The damage meter (damageMeter/index.js), drawn on the game page by its preload
 * (damageMeter/overlay.js) in the grey gutters beside the picture. It is made before the window,
 * so the page's first 'hello' finds it; it reads the server's combat feed as this launcher's
 * account from the moment the player first shows it.
 */
function createDamageMeter() {
    const { DamageMeter } = require('./damageMeter');
    const meter = new DamageMeter({
        dataDir: app.getPath('userData'),
        version: launcherVersion || app.getVersion(),
        log: (message) => console.log(`[DamageMeter] ${message}`)
    });
    meter.io = {
        documentsDir: app.getPath('documents'),
        saveDialog: (defaultPath, filters) =>
            dialog
                .showSaveDialog(gameWindow && !gameWindow.isDestroyed() ? gameWindow : undefined, {
                    title: 'Export DPS results',
                    defaultPath,
                    filters
                })
                .then((result) => (result.canceled ? '' : result.filePath || '')),
        writeClipboard: (text) => clipboard.writeText(String(text || '')),
        showItemInFolder: (file) => shell.showItemInFolder(file),
        showError: (message) => {
            void dialog.showMessageBox(gameWindow && !gameWindow.isDestroyed() ? gameWindow : undefined, {
                type: 'error',
                title: 'Damage meter',
                message: String(message || '')
            });
        }
    };
    meter.on('view', (view) => {
        if (gameWindow && !gameWindow.isDestroyed()) {
            gameWindow.webContents.send('damageMeter:view', view);
        }
    });
    let lastLink = '';
    meter.on('state', () => {
        const link = meter.linkStatus().text;
        if (link !== lastLink) {
            lastLink = link;
            console.log(`[DamageMeter] ${link}`);
        }
    });
    // Only the game page may drive the meter.
    ipcMain.handle('damageMeter:command', (event, cmd, arg) => {
        if (!gameWindow || gameWindow.isDestroyed() || event.sender !== gameWindow.webContents) {
            return { ok: false, error: 'not the game page' };
        }
        return meter.command(String(cmd || ''), arg);
    });
    meter.attach({ serverUrl: gameOrigin, getLauncherToken: () => launcherToken });
    meter.watch(!meter.settings.hidden);
    return meter;
}

// Discord's OAuth hand-off finishes in the player's browser, so the page never sees the
// localStorage event it normally waits on. Restarting its poll keeps the in-game sign-in
// working without modifying the page.
function nudgeDiscordLoginPoll() {
    if (!gameWindow || gameWindow.isDestroyed()) {
        return;
    }
    void gameWindow.webContents
        .executeJavaScript(
            'typeof startDiscordPendingLoginPoll === "function" ? (startDiscordPendingLoginPoll(), true) : false',
            true
        )
        .catch(() => false);
}

// Flash content can ask to navigate, and a plugin-enabled window must not be walked onto an
// arbitrary origin by a page -- or by anything a page loads.
app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
        if (gameOrigin && originOf(url) === gameOrigin) {
            return;
        }
        event.preventDefault();
        openExternal(url);
    });
    contents.on('new-window', (event, url) => {
        event.preventDefault();
        openExternal(url);
        nudgeDiscordLoginPoll();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
});

function createGameWindow() {
    const bounds = readBounds();
    gameWindow = new BrowserWindow({
        width: Number.isFinite(bounds.width) ? bounds.width : DEFAULT_BOUNDS.width,
        height: Number.isFinite(bounds.height) ? bounds.height : DEFAULT_BOUNDS.height,
        x: Number.isFinite(bounds.x) ? bounds.x : undefined,
        y: Number.isFinite(bounds.y) ? bounds.y : undefined,
        minWidth: MIN_SIZE.width,
        minHeight: MIN_SIZE.height,
        backgroundColor: BACKGROUND_COLOR,
        title: TITLE,
        show: false,
        icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
        webPreferences: {
            plugins: true,
            contextIsolation: true,
            nodeIntegration: false,
            enableRemoteModule: false,
            webviewTag: false,
            webSecurity: true,
            devTools,
            // The damage meter's panels, drawn on the game page from its isolated world.
            preload: damageMeter ? path.join(__dirname, 'damageMeter', 'overlay.js') : undefined
        }
    });

    gameWindow.setMenuBarVisibility(false);

    // The window is the game, not the page's <title>.
    gameWindow.on('page-title-updated', (event) => event.preventDefault());

    gameWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') {
            return;
        }
        if (input.key === 'F11') {
            gameWindow.setFullScreen(!gameWindow.isFullScreen());
            event.preventDefault();
            return;
        }
        if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
            gameWindow.webContents.reload();
            event.preventDefault();
            return;
        }
        // The meter's keys, read here because Flash takes the keyboard on the page.
        const meterCommand = damageMeter && !input.isAutoRepeat && !input.control && !input.alt && !input.meta
            ? { F6: 'toggle', F7: 'reset', F8: 'hide' }[input.key]
            : '';
        if (meterCommand) {
            void damageMeter.command(meterCommand);
            event.preventDefault();
            return;
        }
        if (devTools && input.control && input.shift && input.key.toLowerCase() === 'i') {
            gameWindow.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    gameWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
            return;
        }
        void dialog
            .showMessageBox(gameWindow, {
                type: 'error',
                title: 'Connection error',
                message: 'The game page could not be opened.',
                detail: `${validatedUrl}\n\n${errorDescription} (${errorCode})`,
                buttons: ['OK']
            })
            .then(() => {
                if (gameWindow && !gameWindow.isDestroyed()) {
                    gameWindow.close();
                }
            });
    });

    gameWindow.on('close', () => {
        if (!gameWindow.isFullScreen()) {
            writeBounds(gameWindow.getNormalBounds());
        }
    });
    gameWindow.on('closed', () => {
        gameWindow = null;
        if (damageMeter) {
            damageMeter.stop();
        }
    });

    gameWindow.once('ready-to-show', () => gameWindow.show());
    void gameWindow.loadURL(gameUrl);
}

app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
    if (!startable) {
        return;
    }
    // macOS keeps a menu bar for the standard shortcuts (copy, paste, quit); elsewhere the
    // window has none.
    if (process.platform !== 'darwin') {
        Menu.setApplicationMenu(null);
    } else if (app.dock && fs.existsSync(ICON_PATH)) {
        app.dock.setIcon(ICON_PATH);
    }
    if (damageMeterWanted) {
        damageMeter = createDamageMeter();
    }
    createGameWindow();
});
