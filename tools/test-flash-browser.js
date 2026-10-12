#!/usr/bin/env node
'use strict';

/**
 * Checks FlashBrowser, the default game engine (lib/flashBrowser.js), without an Electron
 * runtime: which machines get one, how a vendor/flashbrowser/ folder is found and refused, how
 * it is started, the fingerprint an installed launcher checks, and that the lock file,
 * packaging and the game-window app agree with each other.
 *
 * Usage: node tools/test-flash-browser.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    FLASH_VERSION,
    TARGETS,
    findFlashBrowser,
    flashBrowserTarget,
    prepareFlashBrowserLaunch,
    verifyFlashBrowser
} = require('../lib/flashBrowser');
const { treeDigest, writeExpected } = require('../lib/integrity');
const { createStateStore } = require('../lib/config');

const ROOT = path.join(__dirname, '..');

function write(file, body = 'x') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

/** A complete vendor/flashbrowser/<target>/ folder, with stand-in files. */
function makeFlashBrowser(root, target) {
    if (target === 'win32-x64') {
        write(path.join(root, 'runtime', 'electron.exe'));
        write(path.join(root, 'runtime', 'resources', 'default_app.asar'));
        write(path.join(root, 'plugin', 'pepflashplayer64.dll'));
    } else {
        write(path.join(root, 'runtime', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
        write(path.join(root, 'runtime', 'Electron.app', 'Contents', 'Resources', 'default_app.asar'));
        write(path.join(root, 'plugin', 'PepperFlashPlayer.plugin', 'Contents', 'MacOS', 'PepperFlashPlayer'));
    }
    write(path.join(root, 'app', 'main.js'));
    write(path.join(root, 'app', 'package.json'), '{}');
}

function checkTargets() {
    assert.strictEqual(flashBrowserTarget({ platform: 'win32', arch: 'x64' }), 'win32-x64');
    assert.strictEqual(flashBrowserTarget({ platform: 'win32', arch: 'arm64' }), 'win32-x64', 'Windows on Arm runs the x64 build');
    assert.strictEqual(flashBrowserTarget({ platform: 'win32', arch: 'ia32' }), '', '32-bit Windows has no plugin');
    assert.strictEqual(flashBrowserTarget({ platform: 'darwin', arch: 'x64' }), 'darwin-x64');
    assert.strictEqual(flashBrowserTarget({ platform: 'darwin', arch: 'arm64' }), 'darwin-x64', 'Apple Silicon runs it under Rosetta');
    assert.strictEqual(flashBrowserTarget({ platform: 'linux', arch: 'x64' }), '', 'Linux has no plugin');

    const none = findFlashBrowser({ platform: 'linux', arch: 'x64' });
    assert.deepStrictEqual(none, { offered: false, target: '', found: null, partial: null });
    console.log('[test-flash-browser] Windows x64 and macOS get FlashBrowser, 32-bit Windows and Linux do not: OK');
}

function checkLookup(scratch) {
    for (const target of Object.keys(TARGETS)) {
        const [platform, arch] = target.split('-');
        const missingDir = path.join(scratch, 'missing', target);
        const partialDir = path.join(scratch, 'partial', target);
        const completeDir = path.join(scratch, 'complete', target);

        makeFlashBrowser(partialDir, target);
        fs.rmSync(path.join(partialDir, 'plugin'), { recursive: true, force: true });
        makeFlashBrowser(completeDir, target);

        const located = findFlashBrowser({ platform, arch, directories: [missingDir, partialDir, completeDir] });
        assert.strictEqual(located.offered, true);
        assert.strictEqual(located.target, target);
        assert.ok(located.found, `${target}: the complete folder is found past an incomplete one`);
        assert.strictEqual(located.found.root, completeDir);
        assert.ok(located.found.pluginPath.endsWith(TARGETS[target].plugin));
        if (platform === 'darwin') {
            assert.ok(
                located.found.executable.endsWith(path.join('Electron.app', 'Contents', 'MacOS', 'Electron')),
                'the macOS runtime is started through the binary inside Electron.app'
            );
        }

        const partial = findFlashBrowser({ platform, arch, directories: [missingDir, partialDir] });
        assert.strictEqual(partial.found, null);
        assert.deepStrictEqual(partial.partial.missing, [path.join('plugin', TARGETS[target].plugin)], 'the missing part is named');
    }
    console.log('[test-flash-browser] a complete FlashBrowser is found, an incomplete one says what it lacks: OK');
}

function checkLaunch() {
    const found = {
        executable: 'C:\\Launcher\\resources\\vendor\\flashbrowser\\win32-x64\\runtime\\electron.exe',
        appDir: 'C:\\Launcher\\resources\\vendor\\flashbrowser\\win32-x64\\app',
        pluginPath: 'C:\\Launcher\\resources\\vendor\\flashbrowser\\win32-x64\\plugin\\pepflashplayer64.dll'
    };
    const launch = prepareFlashBrowserLaunch(found, {
        gameUrl: 'http://dungeonblitzr.theminesa.studio/',
        userDataDir: 'C:\\Users\\p\\AppData\\Roaming\\dungeon-blitz-r-launcher\\flashbrowser',
        env: { PATH: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require evil.js', ELECTRON_NO_ASAR: '1' }
    });
    assert.strictEqual(launch.command, found.executable);
    assert.deepStrictEqual(launch.args, [
        found.appDir,
        '--db-game-url=http://dungeonblitzr.theminesa.studio/',
        `--db-plugin=${found.pluginPath}`,
        `--db-flash-version=${FLASH_VERSION}`,
        '--db-user-data=C:\\Users\\p\\AppData\\Roaming\\dungeon-blitz-r-launcher\\flashbrowser'
    ]);
    assert.deepStrictEqual(launch.env, { PATH: 'C:\\Windows' }, 'no Electron or Node switches reach the game window');

    const dev = prepareFlashBrowserLaunch(found, { gameUrl: 'http://x/', userDataDir: 'd', devTools: true, env: {} });
    assert.ok(dev.args.includes('--db-devtools'), 'a checkout may open developer tools');
    assert.ok(!launch.args.includes('--db-devtools'), 'an installed launcher may not');

    // The damage meter: named with the launcher's version, and its token kept off the command
    // line (which any process can list) and out of a parent's environment.
    assert.ok(!launch.args.some((arg) => arg.startsWith('--db-damage-meter')), 'no meter unless asked');
    const metered = prepareFlashBrowserLaunch(found, {
        gameUrl: 'http://x/',
        userDataDir: 'd',
        env: { PATH: 'p', DUNGEON_BLITZ_LAUNCHER_TOKEN: 'stale' },
        damageMeter: { version: '1.3.0', launcherToken: 'launcher-token' }
    });
    assert.ok(metered.args.includes('--db-damage-meter=1.3.0'), 'the meter is asked for with the version it names');
    assert.deepStrictEqual(metered.env, { PATH: 'p', DUNGEON_BLITZ_LAUNCHER_TOKEN: 'launcher-token' }, 'the token travels in the environment');
    assert.ok(!metered.args.join(' ').includes('launcher-token'), 'and never on the command line');

    // The switches the launcher passes are exactly the ones the game-window app reads.
    const host = fs.readFileSync(path.join(ROOT, 'flashbrowser', 'main.js'), 'utf8');
    for (const name of ['game-url', 'plugin', 'flash-version', 'user-data', 'damage-meter']) {
        assert.ok(host.includes(`option('${name}')`), `flashbrowser/main.js reads --db-${name}`);
    }
    assert.ok(host.includes("'--db-devtools'"), 'flashbrowser/main.js reads --db-devtools');
    assert.ok(host.includes('DUNGEON_BLITZ_LAUNCHER_TOKEN'), 'flashbrowser/main.js reads the token from the environment');
    console.log('[test-flash-browser] FlashBrowser is started on the game page with the plugin, in its own profile: OK');
}

function checkIntegrity(scratch) {
    const root = path.join(scratch, 'integrity', 'win32-x64');
    makeFlashBrowser(root, 'win32-x64');
    const integrityPath = path.join(scratch, 'integrity', 'flashbrowser.integrity.json');

    assert.strictEqual(verifyFlashBrowser(root, { target: 'win32-x64', integrityPath }).ok, false, 'no record, no start');

    writeExpected(root, { platform: 'win32-x64', version: FLASH_VERSION }, integrityPath);
    assert.deepStrictEqual(verifyFlashBrowser(root, { target: 'win32-x64', integrityPath }), { ok: true, reason: '' });

    const wrongTarget = verifyFlashBrowser(root, { target: 'darwin-x64', integrityPath });
    assert.strictEqual(wrongTarget.ok, false);
    assert.ok(wrongTarget.reason.includes('FlashBrowser fingerprint is for win32-x64'), wrongTarget.reason);

    for (const changed of [path.join('plugin', 'pepflashplayer64.dll'), path.join('app', 'main.js'), path.join('runtime', 'electron.exe')]) {
        const file = path.join(root, changed);
        const original = fs.readFileSync(file);
        fs.writeFileSync(file, 'patched');
        const result = verifyFlashBrowser(root, { target: 'win32-x64', integrityPath });
        assert.strictEqual(result.ok, false, `a changed ${changed} is refused`);
        assert.strictEqual(result.reason, 'FlashBrowser files were changed after installation');
        fs.writeFileSync(file, original);
    }

    write(path.join(root, 'app', 'extra.js'), 'require("evil")');
    assert.strictEqual(verifyFlashBrowser(root, { target: 'win32-x64', integrityPath }).ok, false, 'an added file is refused');
    console.log('[test-flash-browser] a changed, added-to or foreign FlashBrowser is refused: OK');
}

/**
 * electron-builder's packaging copy is not a byte-for-byte mirror of vendor/: it drops empty
 * folders (Electron.app has 53 empty .lproj locale folders), and a copier may turn symlinks into
 * the files they point at. 1.2.2's first macOS build failed its own fingerprint check on that.
 * The digest describes what runs -- files and their contents -- so both copies match, while a
 * changed, added or removed file still does not.
 */
function checkPackagingCopies(scratch) {
    if (process.platform === 'win32') {
        // Creating symlinks needs a privilege CI's Windows runners may not have; the suite runs
        // on Linux, and the case it pins is a macOS bundle.
        console.log('[test-flash-browser] (skipped on Windows: symlinks) packaging copies keep the fingerprint');
        return;
    }
    const original = path.join(scratch, 'bundle', 'Electron.app');
    const framework = path.join(original, 'Contents', 'Frameworks', 'Electron Framework.framework');
    write(path.join(framework, 'Versions', 'A', 'Electron Framework'), 'framework binary');
    write(path.join(framework, 'Versions', 'A', 'Resources', 'Info.plist'), 'plist');
    fs.symlinkSync('A', path.join(framework, 'Versions', 'Current'));
    fs.symlinkSync('Versions/Current/Electron Framework', path.join(framework, 'Electron Framework'));
    fs.symlinkSync('Versions/Current/Resources', path.join(framework, 'Resources'));
    write(path.join(original, 'Contents', 'MacOS', 'Electron'), 'electron binary');
    fs.mkdirSync(path.join(original, 'Contents', 'Resources', 'en.lproj'), { recursive: true });
    fs.mkdirSync(path.join(original, 'Contents', 'Resources', 'de.lproj'), { recursive: true });
    const expected = treeDigest(original);
    assert.match(expected, /^[0-9a-f]{64}$/);

    // A copy without the empty folders and with every link replaced by what it points at.
    const flattened = path.join(scratch, 'flattened', 'Electron.app');
    const copyDereferenced = (from, to) => {
        const stat = fs.statSync(from);
        if (stat.isDirectory()) {
            const entries = fs.readdirSync(from);
            if (!entries.length) {
                return;
            }
            fs.mkdirSync(to, { recursive: true });
            for (const entry of entries) {
                copyDereferenced(path.join(from, entry), path.join(to, entry));
            }
            return;
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
    };
    copyDereferenced(original, flattened);
    assert.ok(!fs.existsSync(path.join(flattened, 'Contents', 'Resources', 'en.lproj')), 'the premise: empty folders are gone');
    assert.ok(!fs.lstatSync(path.join(flattened, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'Current')).isSymbolicLink());
    assert.strictEqual(treeDigest(flattened), expected, 'a packaging copy keeps the fingerprint');

    fs.writeFileSync(path.join(flattened, 'Contents', 'MacOS', 'Electron'), 'patched');
    assert.notStrictEqual(treeDigest(flattened), expected, 'a changed file in it still does not');
    fs.writeFileSync(path.join(flattened, 'Contents', 'MacOS', 'Electron'), 'electron binary');
    write(path.join(flattened, 'Contents', 'MacOS', 'inject.dylib'), 'x');
    assert.notStrictEqual(treeDigest(flattened), expected, 'nor an added one');

    // A link pointing back up the tree is recorded, not followed forever; a dangling one counts.
    fs.symlinkSync('..', path.join(original, 'Contents', 'loop'));
    assert.match(treeDigest(original), /^[0-9a-f]{64}$/, 'a link loop does not hang the check');
    fs.symlinkSync('missing-target', path.join(original, 'Contents', 'dangling'));
    assert.match(treeDigest(original), /^[0-9a-f]{64}$/);
    console.log('[test-flash-browser] packaging copies keep the fingerprint; changes to them do not: OK');
}

/**
 * 1.2.2 crashed at start on Windows and macOS: an installed launcher has Electron's embedded asar
 * integrity on, and Electron kills the process when its asar-aware `fs` touches an archive it has
 * no record for -- FlashBrowser's own runtime/resources/default_app.asar, read while checking and
 * fingerprinting FlashBrowser. Here `fs` stands in for Electron's (it notes every .asar path it is
 * handed) and `original-fs` is the plain one, and finding, checking and starting FlashBrowser must
 * never hand Electron's `fs` an .asar path.
 */
function checkNoAsarAwareFs(scratch) {
    const Module = require('module');
    const realFs = require('fs');
    const touched = [];
    const asarAware = new Proxy(realFs, {
        get(target, property) {
            const value = target[property];
            if (typeof value !== 'function') {
                return value;
            }
            return (...args) => {
                if (typeof args[0] === 'string' && /\.asar([\\/]|$)/i.test(args[0])) {
                    touched.push(`fs.${String(property)}(${args[0]})`);
                }
                return value.apply(target, args);
            };
        }
    });

    const libDir = path.join(ROOT, 'lib');
    const fresh = ['rawFs', 'integrity', 'flashBrowser', 'binary'].map((name) => require.resolve(path.join(libDir, name)));
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (parent && parent.filename && parent.filename.startsWith(libDir)) {
            if (request === 'fs') {
                return asarAware;
            }
            if (request === 'original-fs') {
                return realFs;
            }
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    for (const file of fresh) {
        delete require.cache[file];
    }

    try {
        const electronLike = require(path.join(libDir, 'flashBrowser'));
        const integrity = require(path.join(libDir, 'integrity'));
        const root = path.join(scratch, 'asar', 'win32-x64');
        makeFlashBrowser(root, 'win32-x64');
        write(path.join(root, 'runtime', 'resources', 'default_app.asar'), "an archive of Electron's own");
        const record = path.join(scratch, 'asar', 'flashbrowser.integrity.json');
        integrity.writeExpected(root, { platform: 'win32-x64', version: FLASH_VERSION }, record);

        const located = electronLike.findFlashBrowser({ platform: 'win32', arch: 'x64', directories: [root] });
        assert.ok(located.found, 'FlashBrowser is found');
        assert.deepStrictEqual(
            electronLike.verifyFlashBrowser(root, { target: 'win32-x64', integrityPath: record }),
            { ok: true, reason: '' },
            'and checked against its fingerprint'
        );
        electronLike.prepareFlashBrowserLaunch(located.found, { gameUrl: 'http://x/', userDataDir: 'd', env: {} });
        assert.deepStrictEqual(touched, [], "Electron's asar-aware fs is never handed an .asar path");
    } finally {
        Module._load = originalLoad;
        for (const file of fresh) {
            delete require.cache[file];
        }
    }
    console.log("[test-flash-browser] FlashBrowser is found and checked without Electron's asar handling: OK");
}

function checkLockAndPackaging() {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'flashbrowser.lock.json'), 'utf8'));
    assert.strictEqual(lock.flash, FLASH_VERSION, 'the lock and the launcher name the same plugin build');
    assert.deepStrictEqual(Object.keys(lock.targets).sort(), Object.keys(TARGETS).sort(), 'one lock entry per target');

    for (const [target, entry] of Object.entries(lock.targets)) {
        assert.match(entry.runtime.sha256, /^[0-9a-f]{64}$/, `${target}: the Electron runtime is pinned`);
        assert.ok(entry.runtime.file.includes(`v${lock.electron}-${target}`), `${target}: the runtime is Electron ${lock.electron} for ${target}`);
        assert.ok(entry.runtime.urls.length >= 1 && entry.runtime.urls.every((url) => url.startsWith('https://')));
        assert.strictEqual(entry.plugin.name, TARGETS[target].plugin);

        // Every pinned plugin file is in the repository (a Git LFS pointer in a checkout made
        // without LFS), so a release can never quietly lose one.
        for (const [relative, hash] of Object.entries(entry.plugin.files)) {
            assert.match(hash, /^[0-9a-f]{64}$/);
            const file = path.join(ROOT, entry.plugin.payload, ...relative.split('/').filter(Boolean));
            assert.ok(fs.existsSync(file), `${file} is in the repository`);
            const head = fs.readFileSync(file).subarray(0, 200).toString('utf8');
            if (head.startsWith('version https://git-lfs.github.com/spec/')) {
                assert.ok(head.includes(`oid sha256:${hash}`), `${file}: the LFS pointer names the pinned hash`);
            }
        }
    }

    const pkg = require(path.join(ROOT, 'package.json'));
    const filters = pkg.build.extraResources.flatMap((entry) => entry.filter || []);
    assert.ok(filters.includes('flashbrowser/${platform}-${arch}/**/*'), 'each package ships only its own FlashBrowser');
    assert.ok(/fetch-flash-browser\.js --platform win32 --arch x64/.test(pkg.scripts['predist:win']));
    assert.ok(/fetch-flash-browser\.js --platform win32 --arch ia32/.test(pkg.scripts['predist:win:ia32']), 'the ia32 run clears it');
    assert.ok(/fetch-flash-browser\.js --platform darwin --arch x64/.test(pkg.scripts['predist:mac']));

    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    assert.ok(workflow.includes('node tools/fetch-flash-browser.js'), 'the release assembles FlashBrowser');
    assert.ok(workflow.includes('node tools/verify-flash-browser.js'), 'the release checks it in the package');

    const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(ignored.includes('lib/flashbrowser.integrity.json'), 'the per-build fingerprint is never committed');
    console.log('[test-flash-browser] the lock, the plugin payload and packaging agree: OK');
}

function checkSavedEngine(scratch) {
    const store = createStateStore(path.join(scratch, 'state'));
    assert.strictEqual(store.read().engine, '', 'nothing picked yet');
    store.write({ engine: 'projector' });
    assert.strictEqual(store.read().engine, 'projector', 'the Flash Player button is remembered');
    store.write({ engine: 'flashbrowser' });
    assert.strictEqual(store.read().engine, 'flashbrowser');
    store.write({ engine: 'something-else' });
    assert.strictEqual(store.read().engine, '', 'an unknown engine is ignored');
    console.log('[test-flash-browser] the engine a player picked is remembered: OK');
}

function main() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-flashbrowser-test-'));
    try {
        checkTargets();
        checkLookup(scratch);
        checkLaunch();
        checkIntegrity(scratch);
        checkPackagingCopies(scratch);
        checkNoAsarAwareFs(scratch);
        checkLockAndPackaging();
        checkSavedEngine(scratch);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log('[test-flash-browser] all assertions passed');
}

main();
