'use strict';

// Never Electron's asar-aware fs: see lib/rawFs.js.
const fs = require('./rawFs');
const path = require('path');

const { macBundleExecutable } = require('./binary');
const { verifyTree } = require('./integrity');

// The default game engine: FlashBrowser -- the game page, with the PPAPI Flash plugin
// FlashBrowser ships (32.0.0.363, the last build before Adobe's 2021-01-12 kill switch), in a
// Chromium 87 window.
//
// The launcher itself runs on a current Electron, and Chromium dropped PPAPI in 88, so the
// plugin cannot be loaded in the launcher's own process the way it was before. FlashBrowser is
// therefore a separate program the launcher starts per game, like Adobe's standalone Flash
// Player: the Electron 11 runtime, untouched as Electron publishes it, the small game-window
// app in flashbrowser/ and the plugin, side by side in vendor/flashbrowser/<target>/
// (tools/fetch-flash-browser.js puts them there):
//
//   vendor/flashbrowser/win32-x64/runtime/electron.exe
//   vendor/flashbrowser/win32-x64/app/main.js
//   vendor/flashbrowser/win32-x64/plugin/pepflashplayer64.dll
//
// Because the game page runs there with its own script, rich presence and region latency
// need nothing from the launcher (unlike the standalone Flash Player, lib/gameHost.js): the
// page posts presence to the launcher's local endpoint itself (lib/presence.js).
//
// The standalone Flash Player stays as the second engine, for players who see a delay
// collecting loot in the plugin.

// Which plugin build the page is told it has; the plugin itself is pinned in
// flashbrowser.lock.json.
const FLASH_VERSION = '32.0.0.363';

// What a FlashBrowser build is made of, per target. Only Windows x64 and macOS (Intel, which
// Apple Silicon runs under Rosetta) have a plugin to ship: there is no 32-bit Windows plugin
// in payload/flash/, and no Linux one.
const TARGETS = {
    'win32-x64': {
        runtime: path.join('runtime', 'electron.exe'),
        defaultApp: path.join('runtime', 'resources', 'default_app.asar'),
        plugin: 'pepflashplayer64.dll'
    },
    'darwin-x64': {
        runtime: path.join('runtime', 'Electron.app'),
        defaultApp: path.join('runtime', 'Electron.app', 'Contents', 'Resources', 'default_app.asar'),
        plugin: 'PepperFlashPlayer.plugin'
    }
};

const INTEGRITY_PATH = path.join(__dirname, 'flashbrowser.integrity.json');

/**
 * The FlashBrowser build this machine runs, as a vendor/flashbrowser/ folder name, or ''
 * when there is none for it.
 *
 * FlashBrowser is its own process, so it only has to suit the machine, not the launcher:
 * Windows on Arm runs the x64 build under emulation, and Apple Silicon runs it under Rosetta.
 * A 32-bit Windows launcher gets none -- it may be on a machine that cannot run x64 at all.
 */
function flashBrowserTarget({ platform = process.platform, arch = process.arch } = {}) {
    if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
        return 'win32-x64';
    }
    if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
        return 'darwin-x64';
    }
    return '';
}

function vendorDirectories(target) {
    const directories = [];
    if (process.resourcesPath) {
        directories.push(path.join(process.resourcesPath, 'vendor', 'flashbrowser', target));
    }
    directories.push(path.join(__dirname, '..', 'vendor', 'flashbrowser', target));
    return directories;
}

function exists(candidate) {
    try {
        fs.statSync(candidate);
        return true;
    } catch {
        return false;
    }
}

/**
 * What a vendor/flashbrowser/<target>/ folder holds.
 *
 * @returns {{ root: string, target: string, executable: string, appDir: string,
 *   pluginPath: string, missing: string[] }}
 */
function inspectFlashBrowser(root, target) {
    const layout = TARGETS[target];
    const runtime = path.join(root, layout.runtime);
    const executable = target.startsWith('darwin') ? macBundleExecutable(runtime) : runtime;
    const appDir = path.join(root, 'app');
    const pluginPath = path.join(root, 'plugin', layout.plugin);

    const missing = [];
    if (!executable || !exists(executable)) {
        missing.push(`Electron ${layout.runtime}`);
    }
    // The runtime is used exactly as Electron publishes it, so the game-window app is handed
    // to Electron's own default app on the command line rather than built into the runtime.
    if (!exists(path.join(root, layout.defaultApp))) {
        missing.push(layout.defaultApp);
    }
    if (!exists(path.join(appDir, 'main.js'))) {
        missing.push(path.join('app', 'main.js'));
    }
    if (!exists(pluginPath)) {
        missing.push(path.join('plugin', layout.plugin));
    }

    return { root, target, executable: executable || runtime, appDir, pluginPath, missing };
}

/**
 * Resolves FlashBrowser for this machine.
 *
 * @param {{ platform?: string, arch?: string, directories?: string[] }} [options]
 *   `directories` replaces the vendor folders (the tests use it).
 * @returns {{ offered: boolean, target: string, found: object|null, partial: object|null }}
 *   `offered` says whether this machine has a FlashBrowser build at all; `found` is a
 *   complete one; `partial` is the first folder that exists but lacks something, for the
 *   message that says what.
 */
function findFlashBrowser(options = {}) {
    const target = flashBrowserTarget(options);
    if (!target) {
        return { offered: false, target: '', found: null, partial: null };
    }

    let partial = null;
    for (const directory of options.directories || vendorDirectories(target)) {
        if (!exists(directory)) {
            continue;
        }
        const inspected = inspectFlashBrowser(directory, target);
        if (!inspected.missing.length) {
            return { offered: true, target, found: inspected, partial: null };
        }
        partial = partial || inspected;
    }
    return { offered: true, target, found: null, partial };
}

/** Whether a FlashBrowser folder is the one this build shipped (lib/integrity.js). */
function verifyFlashBrowser(root, { target, integrityPath = INTEGRITY_PATH } = {}) {
    return verifyTree(root, { integrityPath, platform: target, label: 'FlashBrowser' });
}

/**
 * How to start FlashBrowser on the game, ready to spawn.
 *
 * Electron's default app loads the game-window app from the folder named first; the
 * `--db-*` switches after it are that app's own (flashbrowser/main.js).
 *
 * The damage meter, when wanted, is named with the launcher's version (shown in its exports)
 * and given the launcher token in the environment rather than on the command line, which any
 * process on the machine can list.
 *
 * @param {{ executable: string, appDir: string, pluginPath: string }} found
 * @param {{ gameUrl: string, userDataDir: string, devTools?: boolean, env?: object,
 *           damageMeter?: { version: string, launcherToken?: string } | null }} options
 * @returns {{ command: string, args: string[], env: object }}
 */
function prepareFlashBrowserLaunch(found, { gameUrl, userDataDir, devTools = false, env = process.env, damageMeter = null }) {
    const args = [
        found.appDir,
        `--db-game-url=${gameUrl}`,
        `--db-plugin=${found.pluginPath}`,
        `--db-flash-version=${FLASH_VERSION}`,
        `--db-user-data=${userDataDir}`
    ];
    if (devTools) {
        args.push('--db-devtools');
    }
    if (damageMeter) {
        args.push(`--db-damage-meter=${damageMeter.version || ''}`);
    }

    // The launcher's own Electron settings must not reach a different Electron: one that runs
    // it as plain Node, or loads code into it.
    const childEnv = {};
    for (const [key, value] of Object.entries(env || {})) {
        if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS' || key === 'DUNGEON_BLITZ_LAUNCHER_TOKEN') {
            continue;
        }
        childEnv[key] = value;
    }
    if (damageMeter && damageMeter.launcherToken) {
        childEnv.DUNGEON_BLITZ_LAUNCHER_TOKEN = String(damageMeter.launcherToken);
    }

    return { command: found.executable, args, env: childEnv };
}

module.exports = {
    FLASH_VERSION,
    INTEGRITY_PATH,
    TARGETS,
    findFlashBrowser,
    flashBrowserTarget,
    inspectFlashBrowser,
    prepareFlashBrowserLaunch,
    verifyFlashBrowser
};
