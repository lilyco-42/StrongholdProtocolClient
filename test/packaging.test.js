// Pins the contracts this repo has with the game repo (Stronghold-Protocol) and with its own build output:
//
//   * the payload patch (patches/game-client.patch) is applied by tools/unified-diff.mjs, not by git �?its format
//     assumptions are asserted here, and the patch is re-applied to a pristine copy of the real checkout so that
//     upstream drift fails the tests instead of shipping a client that connects to the wrong server;
//   * DATA_SHIM_JS / SIM_PRIVATE are duplicated in tools/game-contract.mjs (so the build needs no `npm install` in
//     the game checkout) and must still match server/index.js;
//   * assembling a payload flattens exactly the mounts server/index.js exposes, into an incremental directory.
//
// Tests that need a game checkout skip themselves when it is absent (a fresh clone without the sibling checkout).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPatch, parsePatch, stripPath } from '../tools/unified-diff.mjs';
import { versionCode } from '../tools/package-release.mjs';
import { DATA_SHIM_JS, SIM_PRIVATE, findGameRoot, isGameRoot, readGameContract, verifyGameContract, readProtocolVersion, findContractFile } from '../tools/game-contract.mjs';
import { PATCHED_FILES, applyPayloadPatch, assertPatched } from '../tools/payload-patches.mjs';
import { assembleClient, runtimeConfigSource, DEFAULT_SERVER, CLIENT_ROOT, SHELL_FILES, parseCommonArgs } from '../tools/package-client.mjs';
import { desktopTargets } from '../tools/package-desktop.mjs';
import { checkPayloadOffline, checkZipOffline, OUTBOUND } from '../tools/check-payload-offline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The game checkout, or null (then the contract tests skip themselves). */
const GAME_ROOT = (() => {
  try {
    return findGameRoot({ clientRoot: ROOT });
  } catch {
    return null;
  }
})();

const write = (root, rel, body) => {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
};

/** A tiny game checkout: only the files the assembler / contract reader looks at. */
function makeGameFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sp-game-'));
  const patch = mkdtempSync(path.join(tmpdir(), 'sp-patch-'));
  // public/ �?payload root
  write(root, 'public/index.html', '<html>\n<script type="module" src="/js/main.js"></script>\n</html>\n');
  write(root, 'public/js/net.js', "// net\n/** WebSocket URL. */\nexport function defaultWsUrl() { return 'ws://x/ws'; }\n");
  write(root, 'public/js/screens/room.js', '// room\n/** Invite link. */\nexport function inviteLink(code) { return `?room=${code}`; }\n');
  write(root, 'public/js/main.js', 'export {};\n');
  write(root, 'public/assets/char/x.png', 'png');
  // data/, shared/, server/
  write(root, 'data/chess.json', '{"a":1}');
  write(root, 'shared/constants.js', "export const PROTOCOL_VERSION = 1;\nexport const APP_VERSION = '0.1.0';\n");
  write(root, 'server/sim/simdata.js', 'export function getSimData() { return null; }\n');
  write(root, 'server/sim/units.js', 'export const U = 1;\n');
  write(root, 'server/sim/content/support/index.js', 'export const S = 1;\n');
  write(root, 'server/sim/nodeData.js', 'node only\n');
  // the two declarations tools/game-contract.mjs mirrors (kept byte-identical to the real values)
  write(root, 'server/index.js', `export const DATA_SHIM_JS = \`${DATA_SHIM_JS}\`;\nconst SIM_PRIVATE = new Set(['nodedata.js']);\n`);
  // a stand-in for patches/game-client.patch, against the three files above
  const patchFile = path.join(patch, 'game-client.patch');
  writeFileSync(patchFile, [
    'diff --git a/public/index.html b/public/index.html',
    '--- a/public/index.html',
    '+++ b/public/index.html',
    '@@ -1,3 +1,6 @@',
    ' <html>',
    '+<link rel="stylesheet" href="/css/shell-display.css">',
    '+<script src="/js/runtime-config.js"></script>',
    '+<script type="module" src="/js/shell/picker.js"></script>',
    ' <script type="module" src="/js/main.js"></script>',
    ' </html>',
    'diff --git a/public/js/net.js b/public/js/net.js',
    '--- a/public/js/net.js',
    '+++ b/public/js/net.js',
    '@@ -1,3 +1,4 @@',
    ' // net',
    '+// patched: resolveServerTarget reads globalThis.__SP_SERVER__ and ?server=',
    ' /** WebSocket URL. */',
    " export function defaultWsUrl() { return 'ws://x/ws'; }",
    'diff --git a/public/js/screens/room.js b/public/js/screens/room.js',
    '--- a/public/js/screens/room.js',
    '+++ b/public/js/screens/room.js',
    '@@ -1,3 +1,4 @@',
    ' // room',
    '+// patched: invite links use toHttpUrl()',
    ' /** Invite link. */',
    ' export function inviteLink(code) { return `?room=${code}`; }',
    '',
  ].join('\n'));
  return { root, patchFile };
}

describe('unified diff applier', () => {
  test('parses files and hunks', () => {
    const files = parsePatch(readFileSync(path.join(ROOT, 'patches', 'game-client.patch'), 'utf8'));
    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => stripPath(f.newPath, 2)).sort(), [...PATCHED_FILES].sort());
    assert.equal(files.reduce((n, f) => n + f.hunks.length, 0), 7);
  });

  test('applies a patch, and refuses to apply it where the context no longer matches', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-diff-'));
    try {
      write(dir, 'a.txt', 'one\ntwo\nthree\n');
      const patch = '--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n+inserted\n two\n three\n';
      applyPatch(dir, patch, { strip: 1 });
      assert.equal(readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\ninserted\ntwo\nthree\n');
      // the context is gone now ("one / two / three" are no longer consecutive) �?the applier must fail, not guess
      assert.throws(() => applyPatch(dir, patch, { strip: 1 }), /does not match/);
      write(dir, 'b.txt', 'nothing\nlike\nthis\n');
      assert.throws(() => applyPatch(dir, '--- a/b.txt\n+++ b/b.txt\n@@ -1,3 +1,4 @@\n one\n+inserted\n two\n three\n', { strip: 1 }), /does not match/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses paths that escape the root', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-diff-'));
    try {
      assert.throws(() => applyPatch(dir, '--- a/../../evil.txt\n+++ b/../../evil.txt\n@@ -1 +1 @@\n-x\n+y\n', { strip: 1 }), /escapes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps CRLF line endings', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp-diff-'));
    try {
      write(dir, 'c.txt', 'one\r\ntwo\r\n');
      applyPatch(dir, '--- a/c.txt\n+++ b/c.txt\n@@ -1,2 +1,3 @@\n one\n+mid\n two\n', { strip: 1 });
      assert.equal(readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'one\r\nmid\r\ntwo\r\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('game-repo contract', { skip: GAME_ROOT ? false : 'no Stronghold-Protocol checkout next to this repo' }, () => {
  test('the patch is plain `git diff` output (what the applier supports)', () => {
    const text = readFileSync(path.join(ROOT, 'patches', 'game-client.patch'), 'utf8');
    assert.ok(!/\r/.test(text), 'no CRLF');
    assert.ok(!/\\ No newline/.test(text), 'no "\\ No newline at end of file" markers');
    assert.ok(!/^(rename|copy|new file|deleted file|old mode|new mode|similarity)/m.test(text), 'no renames/mode changes');
    assert.ok(!text.includes('\uFEFF'), 'no BOM');
  });

  test('DATA_SHIM_JS / SIM_PRIVATE match the game server source', () => {
    assert.doesNotThrow(() => verifyGameContract(GAME_ROOT));
    // 0.2.0 moved them from server/index.js to server/http/static.js — resolve, never hardcode
    const rel = findContractFile(GAME_ROOT);
    assert.ok(['server/http/static.js', 'server/index.js'].includes(rel), `unexpected contract home: ${rel}`);
    const { shim, simPrivate } = readGameContract(readFileSync(path.join(GAME_ROOT, rel), 'utf8'), rel);
    assert.equal(shim, DATA_SHIM_JS);
    assert.deepEqual(simPrivate, [...SIM_PRIVATE]);
    assert.equal(typeof readProtocolVersion(GAME_ROOT), 'number');
    assert.ok(isGameRoot(GAME_ROOT));
  });

  test('the shell serves the payload with the game server"s MIME table', async () => {
    const { MIME } = await import('../desktop/serve.mjs');
    const rel = ['server/http/files.js', 'server/index.js'].find((r) => {
      try { return /export const MIME = Object\.freeze\(/.test(readFileSync(path.join(GAME_ROOT, r), 'utf8')); } catch { return false; }
    });
    assert.ok(rel, 'MIME 表找不到：游戏仓库把它挪到了 server/ 下的哪个文件？');
    const src = readFileSync(path.join(GAME_ROOT, rel), 'utf8');
    const block = /export const MIME = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(src);
    assert.ok(block, `MIME 表解析失败：${rel} 的写法变了`);
    const pairs = [...block[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
    assert.ok(pairs.length > 20, `MIME 表只解析出 ${pairs.length} 条，解析可能失效`);
    assert.deepEqual({ ...MIME }, Object.fromEntries(pairs));
  });

  test('the payload patch still applies to this checkout (upstream drift fails the build)', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'sp-payload-'));
    try {
      for (const f of PATCHED_FILES) {
        write(out, f, readFileSync(path.join(GAME_ROOT, 'public', f), 'utf8'));
      }
      const applied = applyPayloadPatch({ gameRoot: GAME_ROOT, payloadRoot: out });
      assert.deepEqual([...applied].sort(), [...PATCHED_FILES].sort());
      assert.doesNotThrow(() => assertPatched(out));
      const net = readFileSync(path.join(out, 'js', 'net.js'), 'utf8');
      assert.match(net, /export function toWsUrl\(raw\)/);
      assert.match(net, /export function toHttpUrl\(raw\)/);
      // the patched defaultWsUrl must consult the override before falling back to the page's own origin
      assert.match(net, /const target = resolveServerTarget\(loc\);/);
      assert.match(readFileSync(path.join(out, 'js', 'screens', 'room.js'), 'utf8'), /toHttpUrl\(target\)/);
      assert.match(readFileSync(path.join(out, 'index.html'), 'utf8'), /<script src="\/js\/runtime-config\.js"><\/script>/);
      // the picker must be an ES module and come *before* main.js: module scripts run in document order
      const html = readFileSync(path.join(out, 'index.html'), 'utf8');
      const pickerAt = html.indexOf('<script type="module" src="/js/shell/picker.js">');
      assert.ok(pickerAt !== -1, 'index.html must load /js/shell/picker.js');
      assert.ok(pickerAt < html.indexOf('<script type="module" src="/js/main.js"'), 'the picker runs before the game boots');
      // ...and the shell stylesheet must come after every game stylesheet, so it wins on equal specificity
      const cssAt = html.indexOf('/css/shell-display.css');
      assert.ok(cssAt !== -1, 'index.html must link /css/shell-display.css');
      assert.ok(cssAt > html.lastIndexOf('/css/devices.css'), 'the shell stylesheet is loaded last');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('client payload assembly', () => {
  let game;
  before(() => { game = makeGameFixture(); });
  after(() => {
    rmSync(game.root, { recursive: true, force: true });
    rmSync(path.dirname(game.patchFile), { recursive: true, force: true });
  });

  test('flattens the server mounts, writes the generated files and applies the patch', () => {
    const out = path.join(game.root, 'build', 'client', 'www');
    const r = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
    assert.equal(r.server, DEFAULT_SERVER);
    assert.equal(r.missingAssets, false);
    assert.equal(r.patched.length, PATCHED_FILES.length);
    for (const rel of ['index.html', 'js/main.js', 'assets/char/x.png', 'data/chess.json', 'shared/constants.js', 'sim/units.js', 'sim/content/support/index.js', 'data.js', 'build.json', 'js/runtime-config.js', 'js/shell/picker.js', 'js/shell/picker-core.js', 'data/local-assets.json']) {
      assert.ok(existsSync(path.join(out, rel)), `${rel} must be in the payload`);
    }
    // the picker and the display tweaks are copied verbatim, so /js/shell/picker.js can import ../net.js and
    // ./picker-core.js, and css/shell-display.css overrides css/devices.css by load order
    for (const [name, rel] of SHELL_FILES) {
      assert.equal(readFileSync(path.join(out, rel), 'utf8'), readFileSync(path.join(ROOT, 'shell', name), 'utf8'));
    }
    // Node-only sim loader is never shipped
    assert.ok(!existsSync(path.join(out, 'sim', 'nodeData.js')));
    // /data.js is the game's shim, byte for byte
    assert.equal(readFileSync(path.join(out, 'data.js'), 'utf8'), DATA_SHIM_JS);
    // the empty local-art manifest stands in for the server's synthesised response
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'data', 'local-assets.json'), 'utf8')).groups, {});
    // the packaged client's server address + build provenance
    assert.equal(readFileSync(path.join(out, 'js', 'runtime-config.js'), 'utf8'), runtimeConfigSource(DEFAULT_SERVER));
    const build = JSON.parse(readFileSync(path.join(out, 'build.json'), 'utf8'));
    assert.equal(build.server, DEFAULT_SERVER);
    assert.equal(build.game.app, '0.1.0');
    assert.equal(build.game.protocol, 1);
    // the patch landed on the payload copy, not on the checkout
    assert.doesNotThrow(() => assertPatched(out));
    assert.match(readFileSync(path.join(out, 'js', 'net.js'), 'utf8'), /__SP_SERVER__/);
    assert.ok(!readFileSync(path.join(game.root, 'public', 'js', 'net.js'), 'utf8').includes('__SP_SERVER__'), 'the checkout is never modified');
    // manifest.json lands next to www/ for the build scripts
    assert.equal(JSON.parse(readFileSync(path.join(game.root, 'build', 'client', 'manifest.json'), 'utf8')).server, DEFAULT_SERVER);
  });

  test('a mount subdir that is a symlink is mirrored, not skipped (worktrees link public/assets)', (t) => {
    const game = makeGameFixture();
    const artRoot = mkdtempSync(path.join(tmpdir(), 'sp-art-'));
    const cleanup = () => {
      rmSync(game.root, { recursive: true, force: true });
      rmSync(path.dirname(game.patchFile), { recursive: true, force: true });
      rmSync(artRoot, { recursive: true, force: true });
    };
    try {
      const linked = path.join(game.root, 'public', 'assets');
      renameSync(linked, path.join(artRoot, 'art'));
      // 'junction' needs no privileges on Windows; the type is ignored on POSIX.
      symlinkSync(path.join(artRoot, 'art'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) {
      cleanup();
      t.skip(`symlinks unavailable: ${e.code || e.message}`);
      return;
    }
    try {
      const out = path.join(game.root, 'build', 'linked', 'www');
      const r = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
      assert.equal(r.missingAssets, false, 'the linked assets/ must count as present');
      assert.ok(existsSync(path.join(out, 'assets', 'char', 'x.png')), 'assets/char/x.png behind the link');
      assert.equal(readFileSync(path.join(out, 'assets', 'char', 'x.png'), 'utf8'), 'png');
    } finally {
      cleanup();
    }
  });

  test('a game checkout with tools/packs.mjs gets its pack index generated into the payload', () => {
    // 0.2.0: js/ui/lang.js lists the language packs from /packs/index.json, which only the server generates.
    // A packaged client has no server, so the payload must carry the file — generated by the game repo's own tool.
    const game = makeGameFixture();
    const tool = `#!/usr/bin/env node
// stand-in for the game repo's tools/packs.mjs: writes the index of the --root tree to --out
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const at = (k) => a[a.indexOf(k) + 1];
const root = at('--root'), out = at('--out');
const langs = fs.existsSync(path.join(root, 'public/i18n')) ? fs.readdirSync(path.join(root, 'public/i18n')).filter((f) => f.endsWith('.json')) : [];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ version: 1, packs: langs.map((f) => ({ type: 'lang', id: f.replace(/\\.json$/, '') })) }, null, 2) + '\\n');
`;
    try {
      write(game.root, 'tools/packs.mjs', tool);
      write(game.root, 'packs/README.md', 'pack folders live here\n');
      write(game.root, 'public/i18n/en.json', JSON.stringify({ _meta: { type: 'lang', lang: 'en', name: 'English' } }));
      const out = path.join(game.root, 'build', 'packs', 'www');
      const r = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
      const file = path.join(out, 'packs', 'index.json');
      assert.ok(existsSync(file), 'packs/index.json must be in the payload');
      const idx = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(idx.packs.map((p) => `${p.type}:${p.id}`), ['lang:en'], 'the index describes the mirrored packs');
      assert.ok(existsSync(path.join(out, 'packs', 'README.md')), 'packs/ is mirrored as a mount');
      // the generated file is part of the payload, so the next run must not rewrite it nor sweep it away
      const again = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
      assert.equal(again.copied, 0, 'an unchanged payload rewrites nothing (index included)');
      assert.ok(existsSync(file), 'the sweep must not delete the pack index');
    } finally {
      rmSync(game.root, { recursive: true, force: true });
      rmSync(path.dirname(game.patchFile), { recursive: true, force: true });
    }
  });

  test('a checkout without the packs tool ships no index instead of a wrong one', () => {
    const game = makeGameFixture();
    try {
      const out = path.join(game.root, 'build', 'nopacks', 'www');
      const r = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
      assert.ok(!existsSync(path.join(out, 'packs', 'index.json')), 'no tools/packs.mjs → no index, no warning needed');
      assert.equal(r.files > 0, true);
    } finally {
      rmSync(game.root, { recursive: true, force: true });
      rmSync(path.dirname(game.patchFile), { recursive: true, force: true });
    }
  });

  test('is incremental and drops payload files whose source is gone', () => {
    const out = path.join(game.root, 'build', 'client', 'www');
    const second = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
    assert.equal(second.copied, 0, 'nothing is rewritten when nothing changed');
    const stale = path.join(out, 'js', 'deleted.js');
    writeFileSync(stale, 'export {};\n');
    const third = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, out, log: () => {} });
    assert.equal(third.removed, 1);
    assert.ok(!existsSync(stale));
  });

  test('a custom --server address is what the payload connects to', () => {
    const out = path.join(game.root, 'build', 'other', 'www');
    const r = assembleClient({ gameRoot: game.root, patchFile: game.patchFile, server: '192.168.1.9:3000', out, log: () => {} });
    assert.equal(r.server, '192.168.1.9:3000');
    assert.match(readFileSync(path.join(r.out, 'js', 'runtime-config.js'), 'utf8'), /"192\.168\.1\.9:3000"/);
  });
});

test('the packaged clients default to a server the player runs locally', () => {
  assert.equal(DEFAULT_SERVER, 'localhost:3000');
  assert.match(runtimeConfigSource(DEFAULT_SERVER), /globalThis\.__SP_SERVER__ = "localhost:3000";/);
  // client.config.json points at the sibling checkout and the local server
  const config = JSON.parse(readFileSync(path.join(CLIENT_ROOT, 'client.config.json'), 'utf8'));
  assert.equal(config.gameRoot, '../Stronghold-Protocol');
  assert.equal(config.defaultServer, DEFAULT_SERVER);
  // ...and the shells ship the same defaults
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, 'mobile', 'capacitor.config.json'), 'utf8')).appId, 'site.starst.stronghold');
  assert.equal(JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build.appId, 'site.starst.stronghold');
});

describe('mobile (Android) shell', () => {
  const android = (rel) => readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', rel), 'utf8');

  test('the window fills the display: cutout allowed, system bars hidden, landscape locked', () => {
    const manifest = android('AndroidManifest.xml');
    assert.match(manifest, /android:screenOrientation="sensorLandscape"/, 'the game is landscape-only (see its rotate hint)');

    // both themes the activity can be created with must let the window draw into the cutout strip, otherwise the
    // system letterboxes it in landscape and that strip is the black bar along the edge
    const styles = android('res/values/styles.xml');
    assert.equal((styles.match(/>shortEdges</g) || []).length, 2, 'AppTheme.NoActionBar + AppTheme.NoActionBarLaunch');

    const activity = android('java/site/starst/stronghold/MainActivity.java');
    assert.match(activity, /WindowCompat\.setDecorFitsSystemWindows\(getWindow\(\), false\)/, 'the WebView draws under the bars');
    assert.match(activity, /hide\(WindowInsetsCompat\.Type\.systemBars\(\)\)/, 'the bars are hidden (immersive)');
    assert.match(activity, /onWindowFocusChanged/, 'a swipe or dialog must not leave the bars on screen');
  });

  test('the shell stylesheet rescales the HUD on short landscape screens only', () => {
    const css = readFileSync(path.join(ROOT, 'shell', 'display.css'), 'utf8');
    assert.match(css, /@media \(orientation: landscape\) and \(max-height: 480px\)/);
    // the same formula as css/theme.css, minus the 40 px floor that made the prep camera zoom the scene out
    assert.match(css, /clamp\(28px, min\(calc\(100vw \/ 19\.2\), calc\(100svh \/ 10\.8\)\), 240px\)/);
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, ''); // prose mentions the old formula
    assert.ok(!/clamp\(40px/.test(declarations), 'the 40 px floor is exactly what the override removes');
  });
});

describe('desktop packaging layout', () => {
  test('the default build is the folder, not the self-extracting single file', () => {
    // The portable exe unpacks the whole app to %TEMP% on every launch (~24 s to the first screen vs ~0.5 s),
    // so the folder is the default and the single file is opt-in.
    assert.deepEqual(desktopTargets(), ['dir']);
    assert.deepEqual(desktopTargets({}), ['dir']);
  });

  test('--portable is the opt-in for the single self-extracting file', () => {
    assert.deepEqual(desktopTargets({ portable: true }), ['portable']);
  });

  test('electron-builder config agrees: folder + portable + installer targets, trimmed locales, payload as resources/www', () => {
    const build = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build;
    // dir 是整包目录（zip 分发），portable 与 Setup 是玩家直接双击的单文件 —— build-clients.yml 的「校验产物」
    // 按 *-portable.exe / *-Setup.exe 后缀找它们，所以下面两个 artifactName 必须和那里成对改。
    assert.deepEqual(build.win.target, ['dir', 'portable', 'nsis']);
    assert.equal(build.portable.artifactName, 'StrongholdProtocol-${version}-portable.exe');
    assert.equal(build.nsis.artifactName, 'StrongholdProtocol-${version}-Setup.exe');
    // 真 .msi 要 electron-builder 27（MsiTarget 只在 27.0.0-alpha 里），26.x 出不了 —— 升级前别在 CI 里加 msi target。
    assert.equal(build.msi, undefined, 'msi 尚未启用：需要 electron-builder 27');
    // Electron ships ~48 locales (~48 MB); a Chinese/English game only needs these two.
    assert.deepEqual(build.electronLanguages, ['zh-CN', 'en-US']);
    assert.deepEqual(build.extraResources, [{ from: '../build/client/www', to: 'www' }]);
    assert.equal(build.directories.output, '../build/desktop');
  });

  test('the packager reads those flags from the command line', () => {
    const o = parseCommonArgs(['--server', 'x:1', '--portable']);
    assert.equal(o.server, 'x:1');
    assert.equal(o.portable, true);
    assert.equal(parseCommonArgs([]).portable, false);
    assert.equal(parseCommonArgs(['--dir']).dir, true, '--dir is still accepted (it is the default now)');
    assert.throws(() => parseCommonArgs(['--nope']), /unknown option/);
  });
});

describe('desktop shell: a stable loopback origin keeps localStorage', () => {
  // Chromium scopes localStorage/sessionStorage by origin. The shell serves the payload over http://127.0.0.1:<port>,
  // so an OS-assigned port every launch (the old `port: 0`) is a different origin every time — the game's identity
  // token (sp.tokens), loadout (sp.pref.loadout), settings and the picker's saved server all read back empty, i.e.
  // "restarting loses the loadout / login". Binding a pinned port is the whole fix; these tests keep it pinned.
  const HTML = '<!doctype html><title>t</title>';

  /** Bind an http server to a free port low enough that PORT_SEARCH ports above it also exist. */
  async function occupyPortAbove(port) {
    for (let p = port; p <= 65535 - 32; p++) {
      const s = http.createServer();
      try {
        await new Promise((resolve, reject) => { s.once('error', reject); s.listen(p, '127.0.0.1', resolve); });
        return { server: s, port: p };
      } catch { s.close(); }
    }
    return null;
  }

  test('serve.mjs pins a concrete port and exports the fallback width', async () => {
    const { DEFAULT_PORT, PORT_SEARCH } = await import('../desktop/serve.mjs');
    assert.ok(Number.isInteger(DEFAULT_PORT) && DEFAULT_PORT > 1023 && DEFAULT_PORT < 65536, 'a concrete, non-privileged port');
    assert.ok(Number.isInteger(PORT_SEARCH) && PORT_SEARCH > 1);
  });

  test('the desktop window is pointed at that stable origin (never an ephemeral port)', () => {
    const src = readFileSync(path.join(ROOT, 'desktop', 'main.mjs'), 'utf8');
    assert.match(src, /import \{[^}]*DEFAULT_PORT[^}]*\} from '\.\/serve\.mjs'/, 'main.mjs must use the pinned port');
    assert.match(src, /createStaticServer\(\{[^}]*port:\s*DEFAULT_PORT/, 'the static server must be given the pinned port');
  });

  test('TLS: the shells ask once per server (trust-on-first-use) instead of verifying nothing', () => {
    const src = readFileSync(path.join(ROOT, 'desktop', 'main.mjs'), 'utf8');
    assert.match(src, /app\.on\('certificate-error'/, 'the desktop shell decides per certificate');
    assert.match(src, /event\.preventDefault\(\)/, 'it must take over Electron\'s default (reject) decision');
    assert.match(src, /process\.argv\.includes\('--insecure-tls'\)/, '--insecure-tls answers without asking');
    assert.ok(!/appendSwitch\('ignore-certificate-errors'\)/.test(src), 'verification is never disabled app-wide');
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8'));
    assert.ok(pkg.build.files.includes('trust.mjs'), 'desktop/trust.mjs must ship with the shell');
    const android = readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'src', 'main', 'java', 'site', 'starst', 'stronghold', 'MainActivity.java'), 'utf8');
    assert.match(android, /onReceivedSslError/, 'the Android shell hooks SSL errors as well');
    assert.match(android, /setWebViewClient\(new BridgeWebViewClient\(bridge\)/, 'it keeps Capacitor\'s client (local payload + bridge)');
  });

  test('a busy port falls through to the next free one (deterministically) instead of failing', async () => {
    const { createStaticServer, PORT_SEARCH } = await import('../desktop/serve.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'sp-serve-'));
    writeFileSync(path.join(root, 'index.html'), HTML);
    const blocker = await occupyPortAbove(50000);
    if (!blocker) return; // no free port to occupy: nothing to assert on this machine
    let served;
    try {
      served = await createStaticServer({ root, port: blocker.port, log: { warn() {}, error() {} } });
      assert.notEqual(served.port, blocker.port, 'the busy port is skipped');
      assert.ok(served.port > blocker.port && served.port <= blocker.port + PORT_SEARCH, `landed on ${served.port}, searched from ${blocker.port}`);
      assert.equal(served.url, `http://127.0.0.1:${served.port}`, 'the origin is the loopback host + chosen port');
      // and the payload is actually served from that origin (200 + body)
      const got = await new Promise((resolve, reject) => {
        http.get(`${served.url}/index.html`, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => resolve({ status: r.statusCode, body: d }));
        }).on('error', reject);
      });
      assert.equal(got.status, 200);
      assert.match(got.body, /<title>t<\/title>/);
    } finally {
      await served?.close();
      await new Promise((resolve) => blocker.server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a port the OS reserved (Windows answers EACCES) is skipped, not fatal — and the two shells agree', async () => {
    // windows-latest 上实测到的：从被占的 50000 往后找，撞到 50001 直接抛 `listen EACCES`，而不是接着试 50002。
    // Hyper-V / WSL2 / Docker 会把一整段动态端口留给系统（`netsh interface ipv4 show excludedportrange protocol=tcp`），
    // bind 进去是 EACCES 而不是 EADDRINUSE —— 落在玩家机上就是"桌面版打不开"。行为的证据是那个作业本身变绿；
    // 这里钉住的是判定集合：哪些错误算"这台机器上这个口不能用"，哪些仍然必须抛出来（不能把编程错误重试掉）。
    const { PORT_SKIP_CODES } = await import('../desktop/serve.mjs');
    assert.deepEqual([...PORT_SKIP_CODES].sort(), ['EACCES', 'EADDRINUSE', 'EPERM']);
    assert.ok(!PORT_SKIP_CODES.has('ERR_INVALID_ARG'), 'a programming error must still throw, not be retried away');
    const src = readFileSync(path.join(ROOT, 'desktop', 'serve.mjs'), 'utf8');
    assert.match(src, /if \(!PORT_SKIP_CODES\.has\(e\?\.code\)\) throw e;/, 'the search loop must consult the set');
    const rust = readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'src', 'server.rs'), 'utf8');
    assert.match(rust, /Err\(_\) => continue,/, 'the Rust shell skips any unusable port inside its search window');
  });

  test('the weakest host model still serves the mirror: plain static, no alias, no rewrite (Capacitor does exactly this)', async () => {
    // The APK's BGM was silent because Capacitor is *just* a static file host: it cannot resolve the extension-less
    // /media/… alias (that is what `__SP_MEDIA_ALIAS__ = false` is for). The font mirror went through the same question,
    // so it is pinned here rather than in a one-off probe script nobody can re-run: if the sheet or a slice needs any
    // host cooperation at all, the APK silently falls back to system fonts on a player's phone.
    const root = mkdtempSync(path.join(tmpdir(), 'sp-plain-'));
    writeFileSync(path.join(root, 'index.html'), HTML);
    mkdirSync(path.join(root, 'webfonts', 'google'), { recursive: true });
    mkdirSync(path.join(root, 'assets', 'audio', 'bgm'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'audio', 'bgm', 'act1.mp3'), 'MP3MP3MP3');
    const SHEET = "@font-face{src:url(/webfonts/google/f0.woff2)}@font-face{src:url(/webfonts/google/f1.woff2)}";
    writeFileSync(path.join(root, 'webfonts', 'google', 'google.css'), SHEET);
    writeFileSync(path.join(root, 'webfonts', 'google', 'f0.woff2'), 'wOF2');

    const MIME = { '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.html': 'text/html' };
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
      const abs = path.resolve(root, rel);
      // Deliberately dumb: one path → one file, no aliases, no index fallback beyond the literal name.
      if (!abs.startsWith(path.resolve(root)) || !existsSync(abs) || !statSync(abs).isFile()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(readFileSync(abs));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (p) => new Promise((resolve, reject) => {
      http.get(`${base}${p}`, (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'] })); }).on('error', reject);
    });

    try {
      const alias = await get('/media/bgm/act1');
      assert.equal(alias.status, 404, 'premise: a plain static host cannot serve the alias — that is the bug the flag dodges');
      const direct = await get('/assets/audio/bgm/act1.mp3');
      assert.equal(direct.status, 200, 'the form the APK keeps must resolve on any static host');
      assert.equal(direct.type, 'audio/mpeg');

      const sheet = await get('/webfonts/google/google.css');
      assert.equal(sheet.status, 200, 'the mirrored sheet needs no host cooperation');
      assert.match(sheet.type || '', /text\/css/);
      const face = await get('/webfonts/google/f0.woff2');
      assert.equal(face.status, 200);
      assert.equal(face.type, 'font/woff2');
      const absent = await get('/webfonts/google/f1.woff2');
      assert.equal(absent.status, 404, 'positive control: this lane really opens the disk, it does not answer 200 to everything');

      // The reference form is what makes this host-independent: every slice must be addressed from the root, never
      // relatively, or a nested page would ask for /dev/webfonts/… and get nothing.
      if (GAME_ROOT) {
        const real = readFileSync(path.join(GAME_ROOT, 'public', 'webfonts', 'google', 'google.css'), 'utf8');
        const urls = [...new Set([...real.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, '')))];
        assert.ok(urls.length > 100, `镜像里只找到 ${urls.length} 个 url() —— 读错了文件，这条测试就是空的`);
        assert.deepEqual(urls.filter((u) => !u.startsWith('/webfonts/google/')), [],
          '切片必须用根绝对路径引用，纯静态宿主才会按原样命中');
      }
    } finally {
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the outbound gate catches every load-time reference form, protocol-relative included, and stays quiet on identifiers', () => {
    // The five original families all required `https?:`, so `srcset="//cdn.example/x.png"` — which is exactly as
    // external as an absolute URL once the page is on https, and hangs an offline LAN start — would have passed green.
    // Measured 2026-10-05 on payload-c10: none of these forms occur there (198 text files), so this is a future-proof pin.
    const mustFlag = {
      'imagesrcset 属性': '<link imagesrcset="//h.example/a.png 2x">',
      'srcset 属性': '<img srcset="//h.example/b.png 1x">',
      'CSS url(//)': 'body{background:url(//h.example/bg.png)}',
      'CSS @import "//"': '@import "//h.example/o.css";',
      'fetch("//")': 'fetch("//h.example/f")',
      'import("//")': 'import("//h.example/dyn")',
      'new EventSource("//")': 'new EventSource("//h.example/s")',
      'new WebSocket("//")': 'new WebSocket("//h.example/ws")',
      'xhr.open("GET","//")': 'x.open("GET","//h.example/x",false)',
      'navigator.sendBeacon("//")': 'navigator.sendBeacon("//h.example/beacon")',
    };
    // Not requests: an xmlns identifier and a URL inside a comment. Flagging those is what trains people to ignore a gate.
    const mustNotFlag = {
      'SVG xmlns 标识符': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '注释里的地址': '// see https://cdn.example.com/docs\n/* https://cdn.example.com/x.png and //cdn.example.com/y.png */',
    };
    const hit = (s) => OUTBOUND.flatMap((rx) => [...s.matchAll(rx)].map((m) => m[1]));
    for (const [label, s] of Object.entries(mustFlag)) {
      const got = hit(s);
      assert.ok(got.length >= 1, `${label} 应当被拦，实际没有 —— 闸门漏了这一种引用形式`);
      assert.match(got[0], /h\.example/, `${label} 报出来的应当是那条地址，而不是 ["'] 之类的前缀：${got[0]}`);
    }
    for (const [label, s] of Object.entries(mustNotFlag)) {
      assert.deepEqual(hit(s), [], `${label} 不发请求，拦它就是把闸门变成噪音`);
    }
  });

  test('the provenance gate accepts only a payload that traces to a commit (and CI runs it in both jobs)', async () => {
    // Measured 2026-10-05: the workflow's DEFAULT payload_url (the OSS copy) carries build.json describe="v0.1.3-dirty",
    // dirty=true. The version gate and the offline gate both pass it, so without this gate CI ships an exe/apk nobody
    // can trace back to a commit — and the game side has no CI at all to fall back on.
    const { checkProvenance, main } = await import('../tools/check-payload-provenance.mjs');
    const clean = { server: 'sp.lain42.top', game: { app: '0.1.3', describe: 'v0.1.3-16-g603b94c', dirty: false } };
    assert.equal(checkProvenance(clean).ok, true, '干净树上的 payload 必须放行');
    const dirty = { server: 'sp.lain42.top', game: { app: '0.1.3', describe: 'v0.1.3-dirty', dirty: true } };
    const d = checkProvenance(dirty);
    assert.equal(d.ok, false);
    assert.match(d.problems.join('\n'), /dirty/, '要说出是 dirty，否则没人知道为什么被拦');
    assert.match(d.problems.join('\n'), /describe/, '还要说出 describe 追不到 commit');
    // Two more shapes that must not pass: a tag exactly at HEAD (no -g<sha>) and a missing stamp.
    assert.equal(checkProvenance({ game: { app: '0.1.3', describe: 'v0.1.3', dirty: false } }).ok, false);
    assert.equal(checkProvenance({ game: { app: '0.1.3', dirty: false } }).ok, false);
    assert.equal(checkProvenance({ game: { app: '0.1.2', describe: 'v0.1.2-1-gabcdef123', dirty: false } }, '0.1.3').ok, false);

    // And the same object read off disk, when this machine still has the payload we intend to publish
    // (set SP_PAYLOAD to point at a staged www dir; otherwise the two assertions below are skipped).
    const c10 = process.env.SP_PAYLOAD || 'D:/Code/_artifacts/payload-c10';
    if (existsSync(path.join(c10, 'build.json'))) {
      assert.equal(main([c10]), 0, '待发布的 payload 必须过出处闸门');
      assert.equal(main([c10, '--expect-app', '0.1.3']), 0);
    }

    const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'build-clients.yml'), 'utf8');
    for (const name of ['desktop', 'android']) {
      const job = wf.slice(wf.indexOf(`  ${name}:`));
      const at = job.indexOf('check-payload-provenance.mjs build/client/www');
      assert.ok(at > -1, `${name} job must run the provenance gate`);
      assert.ok(at < job.indexOf('check-payload-offline.mjs build/client/www'),
        `${name}: 出处闸门要在离线闸门之前 —— 拦下复现不出来的 payload 比看内容更省事`);
      assert.ok(at < job.indexOf('npm run pack') || at < job.indexOf('cap sync android'),
        `${name}: 出处闸门必须在真正开始打包之前`);
    }
  });

  test('the shell serves the mirrored font sheet the way a font host does (mime + long cache, and no escape)', async () => {
    // Why this test exists: the whole point of `public/webfonts/google/` is that the packaged client never talks to
    // fonts.googleapis.com / fonts.gstatic.com. `check-payload-offline.mjs` proves the bytes are IN the payload, but
    // nothing proved the Electron shell actually serves that directory usefully — dropping 'webfonts' from
    // LONG_CACHE_DIRS or losing the .woff2 mime is silent (the page still renders, just re-fetching or rejecting faces).
    const { createStaticServer, LONG_CACHE, LONG_CACHE_DIRS } = await import('../desktop/serve.mjs');
    assert.ok(LONG_CACHE_DIRS.has('webfonts'), "'webfonts' must stay in the long-cache set — dropping it is silent");
    const root = mkdtempSync(path.join(tmpdir(), 'sp-webfonts-'));
    writeFileSync(path.join(root, 'index.html'), HTML);
    mkdirSync(path.join(root, 'webfonts', 'google'), { recursive: true });
    writeFileSync(path.join(root, 'webfonts', 'google', 'google.css'),
      "@font-face{font-family:'Noto Sans SC';src:url(/webfonts/google/f0.woff2)}");
    writeFileSync(path.join(root, 'webfonts', 'google', 'f0.woff2'), 'wOF2');

    const get = (urlPath) => new Promise((resolve, reject) => {
      http.get(`${served.url}${urlPath}`, (r) => {
        let d = Buffer.alloc(0);
        r.on('data', (c) => { d = Buffer.concat([d, c]); });
        r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], cache: r.headers['cache-control'], body: d.toString() }));
      }).on('error', reject);
    });

    let served;
    try {
      served = await createStaticServer({ root, port: 0, log: { warn() {}, error() {} } });

      const sheet = await get('/webfonts/google/google.css');
      assert.equal(sheet.status, 200, 'the local sheet the index.html <link> points at must be served');
      assert.match(sheet.type || '', /text\/css/, 'Chromium refuses a stylesheet that is not text/css');
      assert.equal(sheet.cache, LONG_CACHE, 'a 421-face sheet re-fetched on every load is a regression, not a detail');

      const face = await get('/webfonts/google/f0.woff2');
      assert.equal(face.status, 200);
      assert.equal(face.type, 'font/woff2', 'a wrong mime makes the font silently fall back to a system face');
      assert.equal(face.cache, LONG_CACHE);

      // Positive control: the long cache must belong to the mirrored dirs only. Without this line, making every
      // response long-cacheable would keep the four assertions above green.
      const page = await get('/index.html');
      assert.equal(page.status, 200);
      assert.notEqual(page.cache, LONG_CACHE, 'index.html must not inherit the long cache');

      const escape = await get('/webfonts/google/../../../../../../windows/win.ini');
      assert.ok(escape.status === 403 || escape.status === 404, `路径逃逸不该读出根外文件（${escape.status}）`);
      assert.ok(!/\[fonts\]/.test(escape.body), '逃逸请求拿到内容就是真的开口子了');
    } finally {
      if (served) await served.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the /media alias resolves to the real audio file (the desktop shell has no server/index.js)', async () => {
    const { createStaticServer, MEDIA_PREFIX, AUDIO_EXTS } = await import('../desktop/serve.mjs');
    assert.equal(MEDIA_PREFIX, '/media/');
    // The game rewrites audio URLs to this alias (public/js/media.js) using the list in shared/media.js; only
    // server/index.js used to resolve it back, so every BGM 404'd in the packaged client until serve.mjs did too.
    if (GAME_ROOT) {
      const shared = readFileSync(path.join(GAME_ROOT, 'shared', 'media.js'), 'utf8');
      const line = /export const AUDIO_EXTS = Object\.freeze\(\[([^\]]*)\]\)/.exec(shared);
      assert.ok(line, 'shared/media.js still defines AUDIO_EXTS');
      assert.deepEqual(AUDIO_EXTS.slice(), line[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')),
        'serve.mjs must try exactly the extensions the client rewrites with');
      assert.match(shared, new RegExp(`MEDIA_PREFIX = '${MEDIA_PREFIX}'`.replace(/[/.]/g, (c) => `\\${c}`)));
    }

    const root = mkdtempSync(path.join(tmpdir(), 'sp-media-'));
    writeFileSync(path.join(root, 'index.html'), HTML);
    mkdirSync(path.join(root, 'assets', 'audio', 'bgm'), { recursive: true });
    mkdirSync(path.join(root, 'assets', 'audio', 'sfx'), { recursive: true });
    writeFileSync(path.join(root, 'assets', 'audio', 'bgm', 'act1.mp3'), 'MP3MP3MP3');
    writeFileSync(path.join(root, 'assets', 'audio', 'sfx', 'hit.m4a'), 'M4A');

    const get = async (urlPath) => new Promise((resolve, reject) => {
      http.get(urlPath.startsWith('http') ? urlPath : `${served.url}${urlPath}`, (r) => {
        let d = Buffer.alloc(0);
        r.on('data', (c) => { d = Buffer.concat([d, c]); });
        r.on('end', () => resolve({ status: r.statusCode, type: r.headers['content-type'], body: d.toString(), range: r.headers['content-range'] }));
      }).on('error', reject);
    });

    let served;
    try {
      served = await createStaticServer({ root, port: 0, log: { warn() {}, error() {} } });

      const alias = await get('/media/bgm/act1');
      assert.equal(alias.status, 200, 'the extension-less alias is served, not 404');
      assert.equal(alias.type, 'audio/mpeg', 'Content-Type comes from the resolved file');
      assert.equal(alias.body, 'MP3MP3MP3');

      const withExt = await get('/media/bgm/act1.mp3');
      assert.equal(withExt.status, 200, 'an already-suffixed alias still resolves');

      const otherExt = await get('/media/sfx/hit');
      assert.equal(otherExt.status, 200, 'a second entry in AUDIO_EXTS (.m4a) is tried too');
      assert.equal(otherExt.body, 'M4A');

      const missing = await get('/media/bgm/nope');
      assert.equal(missing.status, 404, 'an unknown track is a clean 404, not a directory guess');

      // Web Audio/BGM seeking asks for ranges, so the alias must keep the file server's Range support.
      const ranged = await new Promise((resolve, reject) => {
        const req = http.get(`${served.url}/media/bgm/act1`, { headers: { range: 'bytes=0-2' } }, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => resolve({ status: r.statusCode, range: r.headers['content-range'], body: d }));
        });
        req.on('error', reject);
      });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.range, 'bytes 0-2/9');
      assert.equal(ranged.body, 'MP3');

      const direct = await get('/assets/audio/bgm/act1.mp3');
      assert.equal(direct.status, 200, 'the direct path still works (the fallback for plain static hosts)');

      // A browser/HTTP client normalizes `%2e%2e` and `..` out of a URL before sending it, so a traversal probe has to
      // be written to the socket verbatim — that is what reaches the server's own decode guard.
      const getRaw = (pathName) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: served.port, path: pathName }, (r) => {
          let d = '';
          r.on('data', (c) => { d += c; });
          r.on('end', () => resolve(r.statusCode));
        });
        req.on('error', reject);
        req.end();
      });

      // Statuses mirror server/index.js serveMedia: '.' / '..' segments are 403 (forbidden), a dot-led or dot-ended
      // segment, an empty stem and a trailing slash are 404 (not found).
      const denied = [
        ['/media/', 404],
        ['/media/bgm/', 404],
        ['/media/act1.', 404],
        ['/media/../index.html', 403],
        ['/media/%2e%2e/index.html', 403],
      ];
      for (const [bad, want] of denied) {
        assert.equal((await getRaw(bad)), want, `${bad} must answer ${want}`);
      }
      assert.ok(AUDIO_EXTS.includes('.mp3') && AUDIO_EXTS.length >= 4);
    } finally {
      await served?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('two launches land on the same origin, so the next run sees the localStorage the last one wrote', async () => {
    const { createStaticServer } = await import('../desktop/serve.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'sp-serve-'));
    writeFileSync(path.join(root, 'index.html'), HTML);
    const blocker = await occupyPortAbove(50000);
    if (!blocker) return;
    try {
      const first = await createStaticServer({ root, port: blocker.port, log: { warn() {}, error() {} } });
      const firstUrl = first.url;
      await first.close();
      const second = await createStaticServer({ root, port: blocker.port, log: { warn() {}, error() {} } });
      try {
        assert.equal(second.url, firstUrl, 'the origin must be identical on the next launch (Chromium keys storage by origin)');
      } finally {
        await second.close();
      }
    } finally {
      await new Promise((resolve) => blocker.server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('audio: each host gets the URL form it can actually serve', () => {
  // /media/<track> (extension-less, to keep download managers off BGM) is resolved by server/index.js on the web and
  // by desktop/serve.mjs in the desktop shell — but Capacitor only serves www/ as plain files, so on Android that
  // alias is a guaranteed 404 and the whole game would play silent. public/js/media.js gates on
  // __SP_MEDIA_ALIAS__; these assertions keep the two jobs honest (a missing flag = a silent APK, which no test
  // could otherwise see).
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'build-clients.yml'), 'utf8');
  const desktopJob = wf.slice(wf.indexOf('  desktop:'), wf.indexOf('  android:'));
  const androidJob = wf.slice(wf.indexOf('  android:'));

  test('the Android job turns the alias off, before cap sync copies www/', () => {
    assert.match(androidJob, /__SP_MEDIA_ALIAS__ = false/, 'Android must disable the alias');
    assert.ok(androidJob.indexOf('__SP_MEDIA_ALIAS__ = false') < androidJob.indexOf('cap sync android'),
      'the flag has to be in the payload before Capacitor copies it');
  });

  test('the desktop job leaves it on (serve.mjs resolves /media)', () => {
    assert.ok(!desktopJob.includes('__SP_MEDIA_ALIAS__ = false'), 'desktop keeps the alias');
    assert.ok(desktopJob.includes('stronghold-desktop-win'), 'sanity: this is the desktop job slice');
  });
});

describe('payload offline gate (no third-party host in the boot path)', () => {
  // The mirror is byte-identical to what Google serves (game repo: tools/fetch-webfonts.mjs --check --verify-bytes),
  // so a payload that still reaches fonts.googleapis/gstatic gains nothing and breaks LAN/offline play; a payload
  // carrying dl.lain42.top binds the installed client to the CDN and renders blank offline. Both used to ship.
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'build-clients.yml'), 'utf8');

  const SLICES = 120;
  const mkPayload = (o = {}) => {
    const root = mkdtempSync(path.join(tmpdir(), 'sp-offline-'));
    mkdirSync(path.join(root, 'webfonts', 'google'), { recursive: true });
    mkdirSync(path.join(root, 'data'), { recursive: true });
    const urls = Array.from({ length: o.slices ?? SLICES }, (_, i) => `/webfonts/google/f${i}.woff2`);
    writeFileSync(path.join(root, 'index.html'), o.remoteFont
      ? '<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC" /></head></html>\n'
      : '<html><head><link rel="stylesheet" href="/webfonts/google/google.css" /></head></html>\n');
    if (!o.dropSheet) {
      writeFileSync(path.join(root, 'webfonts', 'google', 'google.css'),
        urls.map((u) => `@font-face{font-family:'Noto Sans SC';src:url(${u});font-display:swap}`).join('\n'));
      for (const u of urls) {
        if (o.dropSliceFile && u.endsWith('/f0.woff2')) continue;
        writeFileSync(path.join(root, 'webfonts', 'google', path.basename(u)), 'wOF2');
      }
    }
    // Art manifests and the files they promise. Three references, all satisfiable, because the point of this
    // gate is that a broken reference is named (see artReferenceProblems): the case variant below is the one
    // a Windows packaging machine cannot see with existsSync.
    const ART_FILES = ['assets/char/avatar/c1.png', 'assets/char/portrait/c1_1.png', 'assets/local/map/board.png'];
    writeFileSync(path.join(root, 'data', 'assets.json'), JSON.stringify(o.cdn
      ? { chars: { c1: { avatar: '/assets/char/avatar/c1.png', portrait: '/assets/char/portrait/c1_1.png' } }, bgm: 'https://dl.lain42.top/site/assets/audio/x.mp3' }
      : { chars: { c1: { avatar: '/assets/char/avatar/c1.png', portrait: '/assets/char/portrait/c1_1.png' } }, bgm: 'assets/audio/x.mp3' }));
    writeFileSync(path.join(root, 'data', 'local-assets.json'),
      JSON.stringify({ groups: { map: { board: { path: '/assets/local/map/board.png', w: 64, h: 64 } } } }));
    if (!o.noArtManifest) {
      for (const rel of ART_FILES) {
        if (Array.isArray(o.dropArt) && o.dropArt.includes(rel)) continue;
        const onDisk = (o.caseArt && o.caseArt[rel]) || rel;
        mkdirSync(path.dirname(path.join(root, onDisk)), { recursive: true });
        writeFileSync(path.join(root, onDisk), 'PNG');
      }
    } else {
      rmSync(path.join(root, 'data', 'assets.json'), { force: true });
      rmSync(path.join(root, 'data', 'local-assets.json'), { force: true });
    }
    return root;
  };
  const cleanup = [];
  const make = (o) => { const r = mkPayload(o); cleanup.push(r); return r; };
  after(() => { for (const r of cleanup) rmSync(r, { recursive: true, force: true }); });

  test('a mirrored payload passes and reports what it counted', () => {
    const r = checkPayloadOffline(make());
    assert.deepEqual(r.problems, []);
    assert.equal(r.slices, SLICES);
    assert.equal(r.woff2, SLICES);
  });

  test('a remote font link in index.html fails, naming the file', () => {
    const r = checkPayloadOffline(make({ remoteFont: true }));
    // 一条外链现在同时违反两条规则（字体主机 + 站外请求），所以按内容断言、不按条数断言。
    assert.ok(r.problems.some((x) => /^index\.html 引用外部字体主机 fonts\.googleapis\.com/.test(x)), JSON.stringify(r.problems));
    assert.ok(r.problems.some((x) => /会向站外发请求/.test(x)), JSON.stringify(r.problems));
    assert.equal(r.problems.filter((x) => /引用外部字体主机/.test(x)).length, 1, '只有 index.html 该被点名');
  });

  test('a CDN-absolute manifest fails (offline play is the point of an exe/apk)', () => {
    const r = checkPayloadOffline(make({ cdn: true }));
    assert.match(r.problems.join('\n'), /assets\.json 引用 CDN 绝对地址 dl\.lain42\.top/);
  });

  test('a slice referenced by the sheet but missing from disk fails', () => {
    const r = checkPayloadOffline(make({ dropSliceFile: true }));
    assert.match(r.problems.join('\n'), /个切片文件缺失/);
  });

  test('a payload without the mirror sheet fails', () => {
    const r = checkPayloadOffline(make({ dropSheet: true }));
    assert.match(r.problems.join('\n'), /缺自托管字体表/);
  });

  // The 立绘 question in one line: the shipped tree has to contain every file the art manifests name, compared
  // case-exactly, because a packaged iOS app and the Linux web host both 404 on a name that only differs in case
  // while the Windows machine that built them cannot see the difference. docs/IOS-ART.md.
  test('the art manifests are counted, and a satisfied reference list is green', () => {
    const r = checkPayloadOffline(make());
    assert.equal(r.art.checked, 2, 'both manifests read');
    assert.equal(r.art.refs, 3);
    assert.deepEqual(r.problems, []);
  });

  test('a portrait named by the manifest but absent from the payload is called out', () => {
    const r = checkPayloadOffline(make({ dropArt: ['assets/char/portrait/c1_1.png'] }));
    const text = r.problems.join('\n');
    assert.match(text, /data\/assets\.json: \d+ 个 URL 里 1 个在 payload 里找不到/);
    assert.match(text, /assets\/char\/portrait\/c1_1\.png/);
    assert.ok(!/只差大小写/.test(text), 'a plain absence is not reported as a case error');
  });

  test('a name that only differs in case is caught where existsSync is blind', () => {
    const root = make({ caseArt: { 'assets/char/portrait/c1_1.png': 'assets/char/portrait/C1_1.png' } });
    // Whether the wrong-case path opens here is a property of this filesystem, not of the check, so it is
    // recorded rather than asserted — the part that must hold everywhere is that the gate names the case error.
    const wrongCaseOpens = existsSync(path.join(root, 'assets', 'char', 'portrait', 'c1_1.png'));
    console.log(`  本机文件系统${wrongCaseOpens ? '不分' : '分'}大小写：existsSync ${wrongCaseOpens ? '看不出' : '看得出'}这个错`);
    const r = checkPayloadOffline(root);
    const text = r.problems.join('\n');
    assert.match(text, /其中 1 个只差大小写/);
    assert.match(text, /清单要 assets\/char\/portrait\/c1_1\.png，盘上是 assets\/char\/portrait\/C1_1\.png/);
  });

  test('a tree without the art manifests is not held to them', () => {
    const r = checkPayloadOffline(make({ noArtManifest: true }));
    assert.equal(r.art.checked, 0);
    assert.equal(r.art.refs, 0);
    assert.ok(!r.problems.some((p) => /美术清单/.test(p)), JSON.stringify(r.problems));
  });

  test('a directory that is not a payload is refused, not silently passed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sp-notpayload-'));
    cleanup.push(root);
    const r = checkPayloadOffline(root);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /不是 payload 根目录/);
  });

  test('both CI jobs run the gate before they build anything', () => {
    const desktopJob = wf.slice(wf.indexOf('  desktop:'), wf.indexOf('  android:'));
    const androidJob = wf.slice(wf.indexOf('  android:'));
    for (const [name, job] of [['desktop', desktopJob], ['android', androidJob]]) {
      assert.match(job, /check-payload-offline\.mjs/, `${name} job must run the offline gate`);
      assert.ok(job.indexOf('check-payload-offline.mjs') < job.indexOf('npm run pack') || job.indexOf('check-payload-offline.mjs') < job.indexOf('cap sync android'),
        `${name}: the gate has to run before the binary is built`);
    }
  });
});

const sheetTextFor = (n) => Array.from({ length: n }, (_, i) => "@font-face{font-family:'Noto Sans SC';src:url(/webfonts/google/f" + i + ".woff2);font-display: swap}").join(String.fromCharCode(10));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();

describe('artifact-level offline gate (reads APK zip entries)', () => {
  // The payload gate is not enough on its own: electron-builder puts the game www next to the 29 KB shell asar
  // (resources/www), and Capacitor stores it *deflate-compressed* inside the apk. Measured on the published apk:
  // grepping the whole file for "fonts.googleapis.com" gives 0, while the entry itself contains it twice — so an
  // artifact gate that does not open the zip would have waved the old build through.

  /** A real (small) zip: local headers + central directory + EOCD, stored or deflate per entry. */
  const makeZip = (items) => {
    const locals = [], cents = [];
    let offset = 0;
    for (const { name, text, method = 8 } of items) {
      const nameBuf = Buffer.from(name, 'utf8');
      const raw = Buffer.from(text, 'utf8');
      const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
      let cc = 0xffffffff; for (const b of raw) cc = CRC_TABLE[(cc ^ b) & 0xff] ^ (cc >>> 8); const crc = (cc ^ 0xffffffff) >>> 0;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      locals.push(lh, nameBuf, data);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
      cents.push(ch, nameBuf);
      offset += lh.length + nameBuf.length + data.length;
    }
    const cen = Buffer.concat(cents);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(items.length, 8); eocd.writeUInt16LE(items.length, 10);
    eocd.writeUInt32LE(cen.length, 12); eocd.writeUInt32LE(offset, 16);
    const p = path.join(mkdtempSync(path.join(tmpdir(), 'sp-apk-')), 'app-debug.apk');
    writeFileSync(p, Buffer.concat([...locals, cen, eocd]));
    return p;
  };

  const SLICES = 120;
  const sheetText = Array.from({ length: SLICES }, (_, i) => `@font-face{font-family:'Noto Sans SC';src:url(/webfonts/google/f${i}.woff2);font-display: swap}`).join('\n');
  const goodApk = (o = {}) => makeZip([
    { name: 'assets/public/index.html', method: 0, text: o.remoteFont
      ? '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC">'
      : '<link href="/webfonts/google/google.css">' },
    ...(o.dropSheet ? [] : [{ name: 'assets/public/webfonts/google/google.css', text: sheetText }]),
    ...(o.dropSliceFile ? [] : Array.from({ length: SLICES }, (_, i) => ({ name: `assets/public/webfonts/google/f${i}.woff2`, text: 'wOF2' }))),
    { name: 'assets/public/data/assets.json', text: o.cdn ? '{"bgm":"https://dl.lain42.top/x.mp3"}' : '{"bgm":"assets/audio/x.mp3"}' },
    { name: 'assets/public/assets/char/a.png', text: 'not-text-but-skipped' },
    { name: 'classes.dex', text: 'irrelevant-to-the-gate' },
  ]);

  test('reads both stored and deflated entries and passes a mirrored apk', () => {
    const r = checkZipOffline(goodApk());
    assert.deepEqual(r.problems, []);
    assert.equal(r.slices, SLICES);
    assert.equal(r.woff2, SLICES);
    assert.equal(r.entries, 1 + 1 + SLICES + 1 + 1 + 1, 'central directory count = index + sheet + slices + assets.json + png + dex');
  });

  test('finds the host inside a compressed entry (whole-file grep would miss it)', () => {
    const r = checkZipOffline(goodApk({ remoteFont: true }));
    assert.ok(r.problems.some((x) => /^index\.html 引用外部字体主机/.test(x)), JSON.stringify(r.problems));
    assert.ok(r.problems.some((x) => /会向站外发请求/.test(x)), '压缩条目里的站外引用也要单独报出来');
    assert.equal(r.problems.filter((x) => /引用外部字体主机/.test(x)).length, 1);
  });

  test('a missing slice inside the apk fails, not just a missing slice on disk', () => {
    const r = checkZipOffline(goodApk({ dropSliceFile: true }));
    assert.match(r.problems.join('\n'), /个切片文件缺失/);
  });

  test('a CDN-absolute manifest inside the apk fails', () => {
    const r = checkZipOffline(goodApk({ cdn: true }));
    assert.match(r.problems.join('\n'), /assets\.json 引用 CDN 绝对地址 dl\.lain42\.top/);
  });

  test('a zip that is not shaped like the apk is refused, not silently green', () => {
    const p = makeZip([{ name: 'whatever.txt', text: 'x' }]);
    const r = checkZipOffline(p);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /assets\/public\/index\.html/);
    assert.throws(() => checkZipOffline((() => { const q = path.join(tmpdir(), 'not-a-zip.apk'); writeFileSync(q, 'nope'); return q; })()), /EOCD/);
  });

  test('CI checks the shipped bytes, not just the staged payload', () => {
    const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'build-clients.yml'), 'utf8');
    // Slice by job boundary: a test that reads "android to the end of the file" would silently pass on the ios job's
    // steps once a third job exists.
    const job = (name) => {
      const start = wf.indexOf(`  ${name}:`);
      assert.ok(start > 0, `workflow 里没有 ${name} job`);
      const rest = wf.slice(start + 1);
      const next = rest.search(/^ {2}[a-z][\w-]*:$/m);
      return rest.slice(0, next === -1 ? rest.length : next);
    };
    const desktop = job('desktop');
    const android = job('android');
    const ios = job('ios');
    assert.match(desktop, /check-payload-offline\.mjs build\/desktop\/win-unpacked\/resources\/www/, 'desktop: gate over the built exe');
    assert.match(android, /check-payload-offline\.mjs --zip mobile\/android\/app\/build\/outputs\/apk\/release\/app-release\.apk/, 'android: gate over the built apk');
    // iOS 的产物是一个目录包（.ipa 只是它的 zip 外壳），所以闸门直接扫 .app 里的 public/ —— 路径由那一步自己 find 出来。
    assert.match(ios, /check-payload-offline\.mjs "\$WWW"/, 'ios: gate over the built .app');
    for (const [name, src, build] of [['desktop', desktop, 'npm run pack'], ['android', android, 'gradlew'], ['ios', ios, 'xcodebuild']]) {
      const at = src.indexOf('产物内闸门') >= 0 ? src.indexOf('产物内闸门') : src.indexOf('产物内，闸门');
      assert.ok(at > 0, `${name}: the artifact gate step exists`);
      assert.ok(src.indexOf(build) < at, `${name}: the artifact gate runs after the binary exists`);
    }
  });

  // iOS 这一路是 2026-10-06 加的（有玩家用 iPhone）。它和另两路的差别全在"我们不签名"上，所以钉死三件事。
  test('the iOS lane builds an unsigned .ipa and keeps the same gates', () => {
    const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'build-clients.yml'), 'utf8');
    const start = wf.indexOf('  ios:');
    const ios = wf.slice(start);
    assert.ok(start > 0, 'workflow 里要有 ios job');
    assert.match(ios.slice(0, 200), /runs-on:\s*macos-latest/, 'iOS 只能在 macOS runner 上编');
    // 与另两路同一套前置闸门，少一道就是给玩家发没把关的包。
    for (const g of ['校验 payload 完整性', '校验 payload 版本（闸门）', 'payload 出处（闸门）', '零外部依赖（闸门）']) {
      assert.ok(ios.includes(g), `ios job 缺前置闸门：${g}`);
    }
    // WKWebView 也是纯静态宿主：不写这个 flag，装机版就是全程静音（Android 侧同一个道理，见 §4.2）。
    assert.match(ios, /__SP_MEDIA_ALIAS__ = false/, 'ios 也要关掉 /media 别名');
    // 不签名是决定，不是遗漏：CI 里没有也不该有证书。⚠️ 只看**非注释行** —— 上面那句解释里也写着
    // CODE_SIGNING_ALLOWED=NO，整段匹配会退化成"提到过就行"，把真实参数删掉测试照样绿（这次就这么翻过车）。
    const code = ios.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.match(code, /CODE_SIGNING_ALLOWED=NO/, 'ios 的 xcodebuild 必须显式关掉签名（注释不算）');
    assert.match(code, /CODE_SIGN_IDENTITY=\s+/, 'CODE_SIGN_IDENTITY 要留空（给了值就是要签名）');
    for (const forbidden of ['security import', 'create-keychain', 'allowProvisioningUpdates', 'CODE_SIGN_IDENTITY="', 'exportArchive', 'MATCH_PROFILE']) {
      assert.ok(!code.includes(forbidden), `ios job 的代码里不该出现签名相关操作：${forbidden}`);
    }
    // scheme 得在仓库里：模板不带共享 scheme，纯 CI 环境下 xcodebuild 不会替你生成一个。
    assert.ok(existsSync(path.join(ROOT, 'mobile', 'ios', 'App', 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'App.xcscheme')),
      'mobile/ios 要提交共享 scheme，否则 -scheme App 在 CI 上会找不到');
    // 工程侧的 iOS 配置：ATS 放开明文（局域网/frp 的 ws://），方向只留横屏。
    const plist = readFileSync(path.join(ROOT, 'mobile', 'ios', 'App', 'App', 'Info.plist'), 'utf8');
    assert.match(plist, /NSAllowsArbitraryLoads[\s\S]{0,40}<true\/>/, 'ATS 要允许明文连接，否则 ws:// 自建服连不上');
    assert.ok(!plist.includes('UIInterfaceOrientationPortrait'), 'iOS 只该声明横屏（游戏是横屏设计）');
    // 中文标点紧跟变量 = macOS runner（/bin/bash 3.2）会把全角字符当成变量名的一部分，`set -u` 当场
    // "unbound variable"（第一次跑 ios job 就是这么死的，而同样写法在 Linux/Windows 上恰好躲过）。
    // 规则：变量旁边只要是非 ASCII，就必须写 ${NAME}。
    for (const m of wf.matchAll(/\$\{?([A-Za-z_]\w*)\}?([^\x00-\x7F])/g)) {
      assert.equal(m[0][1], '{', `workflow 里 $${m[1]} 紧跟非 ASCII "${m[2]}" —— 改成 \${${m[1]}}（bash 3.2 会把它读成一个变量名）`);
    }
  });

  // 「与已安装应用签名不同(-7)」是玩家 2026-10-07 报上来的：这个工程原本一个 signingConfig 都没有，CI 跑的是
  // assembleDebug，于是每个 runner 现场生成一把一次性 debug keystore —— Android 按签名证书决定能不能覆盖安装，
  // 所以每次发版所有装机玩家都必须卸载重装（连同 localStorage 里的代号/调配/设置一起没）。
  // 修法是固定一把 upload key，并把「这次和上次是不是同一把钥匙」变成 CI 的产物校验项。下面钉住这套约定。
  test('the Android lane signs with one fixed upload key and proves it from the artifact', () => {
    const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'build-clients.yml'), 'utf8');
    const gradle = readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'build.gradle'), 'utf8');
    const aStart = wf.indexOf('  android:');
    assert.ok(aStart > 0, 'workflow 里要有 android job');
    const aRest = wf.slice(aStart + 1);
    const aNext = aRest.search(/^ {2}[a-z][\w-]*:$/m);
    const android = aRest.slice(0, aNext === -1 ? aRest.length : aNext);

    // 1) 出货的是 release，不是 debug。
    assert.match(android, /gradlew\s+assembleRelease/, 'android job 必须打 release');
    assert.ok(!/gradlew\s+assembleDebug/.test(android), 'android job 不该再出现 assembleDebug：debug 签的是 runner 的一次性钥匙');
    assert.match(android, /path: mobile\/android\/app\/build\/outputs\/apk\/release\/app-release\.apk/, '上传的必须是 release 包');

    // 2) 钥匙来自仓库 secret，而且这一步排在打包之前（secret 坏掉时一分钟就红，不是二十分钟后）。
    assert.match(android, /secrets\.ANDROID_KEYSTORE_BASE64/, 'keystore 从仓库 secret 解出');
    assert.match(android, /secrets\.ANDROID_KEYSTORE_PASSWORD/, '口令同样是 secret');
    const prep = android.indexOf('准备固定签名钥匙');
    assert.ok(prep > 0, '要有"准备固定签名钥匙"这一步');
    assert.ok(prep < android.indexOf('assembleRelease'), '准备钥匙必须早于打包');

    // 3) 同一把钥匙是**闸门**：apksigner 读产物里的证书，和仓库记录的指纹对拍，且必须在产物上传之前。
    assert.match(android, /-name apksigner/, '用 SDK 自带的 apksigner 读证书');
    assert.match(android, /verify --print-certs/, '要把证书指纹打印出来');
    assert.match(android, /mobile\/android\/upload-key-sha256\.txt/, '与仓库记录的指纹对拍');
    assert.ok(android.indexOf('APK 签名就是那一把钥匙') < android.indexOf('upload-artifact'), '签名闸门必须在上传产物之前');

    // 4) 记录在册的指纹：CI 用 `tr -d ' \n\r'` 读它，所以这个文件里只容得下那一串（注释会把它污染成两次不匹配）。
    const pin = readFileSync(path.join(ROOT, 'mobile', 'android', 'upload-key-sha256.txt'), 'utf8').trim();
    assert.match(pin, /^[0-9a-f]{64}$/, `指纹得是 64 位小写十六进制，实为 ${JSON.stringify(pin)}`);

    // 5) 私钥不出门：本仓库是 PUBLIC 的，keystore 一旦提交，任何人都能签出一个老玩家会自动接受的更新包。
    const gi = readFileSync(path.join(ROOT, 'mobile', 'android', '.gitignore'), 'utf8');
    assert.match(gi, /^keystore\.properties$/m, 'keystore.properties 必须 gitignore');
    assert.match(gi, /^keystore\/$/m, 'keystore/ 目录必须 gitignore');

    // 6) gradle 侧：缺钥匙时 release 必须失败。AGP 对没配签名的 release 的做法是**静默产出未签名 APK**，
    //    那个包会一路走到玩家手机上才报错，比 CI 红一次难看得多。
    assert.match(gradle, /signingConfigs\s*\{[\s\S]*?release\s*\{[\s\S]*?storeFile\s*=/, '要定义 release signingConfig');
    assert.match(gradle, /signingConfig\s*=\s*signingConfigs\.release/, 'release buildType 必须真的用上它');
    const thr = gradle.indexOf('throw new GradleException');
    assert.ok(thr > 0, '缺钥匙时必须 throw');
    assert.ok(thr < gradle.indexOf('android {'), '缺钥匙的检查要在配置阶段生效（写在 android{} 之前）');
    assert.ok(gradle.includes('ANDROID_KEYSTORE_BASE64'), '报错文案要把 secret 名字写出来，CI 日志才自证');
  });

  // 版本号的唯一真源是 package.json，四个地方要跟着它走（tools/package-release.mjs 的 alignVersions 负责写）。
  // iOS 那两个字段是这次加进来的：Xcode 模板写死 1.0 / 1，不钉住就会和 exe/apk 不同号，玩家报障对不上。
  test('every platform stamp agrees with package.json (and alignVersions is what keeps it that way)', () => {
    const v = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const code = versionCode(v);
    assert.ok(Number.isInteger(code) && code > 0, `versionCode(${v}) 应当派生出整数，实得 ${code}`);
    for (const rel of ['package.json', 'desktop/package.json', 'mobile/package.json', 'tauri/package.json']) {
      assert.equal(JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8')).version, v, `${rel} 的版本与根不一致`);
    }
    const gradle = readFileSync(path.join(ROOT, 'mobile', 'android', 'app', 'build.gradle'), 'utf8');
    assert.ok(gradle.includes(`versionName "${v}"`), `android versionName 不是 ${v}`);
    assert.match(gradle, new RegExp(`\\bversionCode ${code}\\b`), `android versionCode 不是 ${code}`);
    const pbx = readFileSync(path.join(ROOT, 'mobile', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    const marketing = [...pbx.matchAll(/\bMARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
    const build = [...pbx.matchAll(/\bCURRENT_PROJECT_VERSION = ([^;]+);/g)].map((m) => m[1]);
    assert.ok(marketing.length >= 2 && marketing.every((x) => x === v), `iOS MARKETING_VERSION 是 ${marketing.join('/')}，应为 ${v}（Debug 与 Release 都要）`);
    assert.ok(build.length >= 2 && build.every((x) => x === String(code)), `iOS CURRENT_PROJECT_VERSION 是 ${build.join('/')}，应为 ${code}`);
    // Tauri 那一版还多两个字段（conf 与 Cargo.toml）。build-tauri.yml 的版本闸门拿 payload 的 game.app 比这三处，
    // 少改一个就是"装出来的 exe 显示错版本"，所以它们必须和上面的六个文件同一次写全。
    const conf = JSON.parse(readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'tauri.conf.json'), 'utf8'));
    assert.equal(conf.version, v, 'tauri/src-tauri/tauri.conf.json 的版本与根不一致');
    const cargo = readFileSync(path.join(ROOT, 'tauri', 'src-tauri', 'Cargo.toml'), 'utf8');
    assert.match(cargo, new RegExp(`^version = "${v}"`, 'm'), `Cargo.toml 的 version 不是 ${v}`);
  });
});

describe('the artifact gate points where the packagers actually put the bytes', () => {
  // If these two derivations ever drift, the CI gate would either scan a nonexistent directory (loud, it exits 1)
  // or, worse, stop matching the real shipped layout. The mapping lives in the packager configs, not in the workflow.
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'build-clients.yml'), 'utf8');

  test('electron-builder ships the payload as extraResources named www next to the asar', () => {
    const b = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build;
    const extra = b.extraResources.find((r) => r.to === 'www');
    assert.ok(extra, 'extraResources must map the payload to "www"');
    assert.equal(extra.from.replace('../', ''), 'build/client/www', 'same staging dir the payload gate scans');
    assert.equal(b.asar, true, 'asar covers only the shell files, so the www is NOT inside app.asar');
    assert.ok(!b.files.includes('../build/client/www'), 'payload must not be in files[] (it would be in the asar then)');
    const out = b.directories.output.replace('../', '');
    const expected = `check-payload-offline.mjs ${out}/win-unpacked/resources/${extra.to}`;
    assert.ok(wf.includes(expected), `workflow 里的产物闸门路径应当是 ${expected}`);
  });

  test('Capacitor copies webDir into the apk as assets/public', () => {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, 'mobile', 'capacitor.config.json'), 'utf8'));
    assert.equal(cfg.webDir.replace(/^\.\.\//, ''), 'build/client/www', 'android webDir is the same staged payload');
    assert.match(cfg.server.androidScheme, /^https$/, 'https scheme — the /media alias 404s here, hence the flag step');
    assert.ok(wf.includes('check-payload-offline.mjs --zip'), 'android artifact gate must open the apk, not grep it');
  });
});

describe('the mirror check is case-exact, because Android filesystems are', () => {
  // existsSync() on a Windows runner says "there" for F0.woff2 when the sheet asks for f0.woff2 — and the phone 404s.
  const mkMirrorZip = (mutate) => {
    const items = [
      { name: 'assets/public/index.html', method: 0, text: '<link href="/webfonts/google/google.css">' },
      { name: 'assets/public/webfonts/google/google.css', text: sheetTextFor(60) },
    ];
    for (let i = 0; i < 60; i++) items.push({ name: `assets/public/webfonts/google/f${i}.woff2`, text: 'wOF2' });
    return makeZipFrom(items.filter((x) => !x.drop), mutate(items));
  };
  const makeZipFrom = (items, extra = []) => {
    const all = [...items, ...extra];
    const locals = [], cents = [];
    let offset = 0;
    for (const { name, text, method = 8 } of all) {
      const nameBuf = Buffer.from(name, 'utf8'); const raw = Buffer.from(text, 'utf8');
      const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
      let c = 0xffffffff; for (const b of raw) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); c = (c ^ 0xffffffff) >>> 0;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(c, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
      locals.push(lh, nameBuf, data);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
      ch.writeUInt32LE(c, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
      cents.push(ch, nameBuf);
      offset += lh.length + nameBuf.length + data.length;
    }
    const cen = Buffer.concat(cents); const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(all.length, 8); eocd.writeUInt16LE(all.length, 10);
    eocd.writeUInt32LE(cen.length, 12); eocd.writeUInt32LE(offset, 16);
    const p = path.join(mkdtempSync(path.join(tmpdir(), 'sp-casezip-')), 'a.apk');
    writeFileSync(p, Buffer.concat([...locals, cen, eocd]));
    return p;
  };

  test('a mirror name that only differs in case is reported as missing, not as present', () => {
    // sheet wants f0.woff2; disk offers F0.woff2 instead.
    const p = makeZipFrom([
      { name: 'assets/public/index.html', method: 0, text: '<link href="/webfonts/google/google.css">' },
      { name: 'assets/public/webfonts/google/google.css', text: sheetTextFor(120) },
      ...Array.from({ length: 119 }, (_, i) => ({ name: `assets/public/webfonts/google/f${i + 1}.woff2`, text: 'wOF2' })),
      { name: 'assets/public/webfonts/google/F0.woff2', text: 'wOF2' },
    ]);
    const r = checkZipOffline(p);
    assert.match(r.problems.join('\n'), /个切片文件缺失/);
    assert.match(r.problems.join('\n'), /只差大小写/, '必须点破"只差大小写"，否则没人知道为什么算缺失');
  });

  test('two files differing only by case are refused', () => {
    const p = makeZipFrom([
      { name: 'assets/public/index.html', method: 0, text: '<link href="/webfonts/google/google.css">' },
      { name: 'assets/public/webfonts/google/google.css', text: sheetTextFor(120) },
      ...Array.from({ length: 120 }, (_, i) => ({ name: `assets/public/webfonts/google/f${i}.woff2`, text: 'wOF2' })),
      { name: 'assets/public/webfonts/google/F119.woff2', text: 'wOF2' },
    ]);
    assert.match(checkZipOffline(p).problems.join('\n'), /只差大小写的同名文件/);
  });

  test('the directory mode is case-exact too (this is the one existsSync gets wrong)', () => {
    // Windows/macOS: `fs.existsSync('f0.woff2')` is TRUE when the file on disk is `F0.woff2` — so a payload
    // assembled on a windows runner can pass an existsSync check and still 404 on a phone. Linux is
    // case-sensitive, so the premise itself is a property of the machine, not of the gate: measure which one we
    // are on and still require the gate to refuse the mismatch. Asserting the premise as a requirement is what
    // made this test red on ubuntu-latest while green here.
    const root = mkdtempSync(path.join(tmpdir(), 'sp-casedir-'));
    mkdirSync(path.join(root, 'webfonts', 'google'), { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<link href="/webfonts/google/google.css">');
    writeFileSync(path.join(root, 'webfonts', 'google', 'google.css'), sheetTextFor(120));
    writeFileSync(path.join(root, 'webfonts', 'google', 'F0.woff2'), 'wOF2');
    for (let i = 1; i < 120; i++) writeFileSync(path.join(root, 'webfonts', 'google', `f${i}.woff2`), 'wOF2');
    const insensitive = existsSync(path.join(root, 'webfonts', 'google', 'f0.woff2'));
    const r = checkPayloadOffline(root);
    const flat = r.problems.join('\n');
    assert.match(flat, /个切片文件缺失/, `这台机器 existsSync 大小写不敏感=${insensitive}`);
    assert.match(flat, /只差大小写/, '要说出"只差大小写"，否则没人明白为什么算缺失');
  });

  test('the real payload mirror is case-exact (measured, not assumed)', () => {
    // 112 slices on disk must match the sheet's 112 names character for character.
    const dir = path.join(CLIENT_ROOT, '..', 'Stronghold-Protocol-upstream', 'public', 'webfonts', 'google');
    if (!existsSync(dir)) return;   // the game checkout is not next to this repo on every machine
    const sheet = readFileSync(path.join(dir, 'google.css'), 'utf8');
    const want = [...new Set([...sheet.matchAll(/url\(\/webfonts\/google\/([^)]+\.woff2)\)/g)].map((m) => m[1]))];
    const disk = readdirSync(dir).filter((f) => f.endsWith('.woff2'));
    assert.ok(want.length >= 100, `sheet references only ${want.length}`);
    assert.deepEqual(want.filter((n) => !disk.includes(n)), [], '有切片名字对不上（大小写敏感）');
    const seen = new Map();
    for (const f of disk) seen.set(f.toLowerCase(), (seen.get(f.toLowerCase()) || 0) + 1);
    assert.deepEqual([...seen].filter(([, c]) => c > 1), [], '镜像目录里有只差大小写的同名文件');
  });
});

describe('the offline gate bans outbound references, not URL-shaped strings', () => {
  // Vendored three.js/pixi ship dozens of doc/licence URLs in comments and an xmlns SVG namespace.
  // A gate that cried wolf on those would be silenced within one release, so the rule matches reference FORMS only.
  const dir = (html) => {
    const root = mkdtempSync(path.join(tmpdir(), 'sp-outbound-'));
    mkdirSync(path.join(root, 'webfonts', 'google'), { recursive: true });
    writeFileSync(path.join(root, 'index.html'), html);
    writeFileSync(path.join(root, 'webfonts', 'google', 'google.css'), sheetTextFor(120));
    for (let i = 0; i < 120; i++) writeFileSync(path.join(root, 'webfonts', 'google', `f${i}.woff2`), 'wOF2');
    return root;
  };
  const hits = (html) => checkPayloadOffline(dir(html)).problems.filter((p) => p.includes('会向站外发请求'));

  test('a real reference to another host is flagged, whatever the form', () => {
    for (const [label, html] of [
      ['script src', '<script src="https://cdn.example.com/lib.js"></script>'],
      ['link href', '<link rel="stylesheet" href="https://fonts.example.com/css2">'],
      ['css url()', '<style>@font-face{src:url(https://x.example.com/a.woff2)}</style>'],
      ['fetch()', '<script>fetch("https://api.example.com/ping")</script>'],
      ['@import', '<style>@import url("https://themes.example.com/a.css");</style>'],
    ]) {
      assert.equal(hits(html).length, 1, `${label} 应当被抓住`);
      assert.match(hits(html)[0], /https:\/\/\S*example/, '报的要能指到那个地址');
    }
  });

  test('URLs that never leave the device are NOT flagged (this is what keeps the gate usable)', () => {
    for (const [label, html] of [
      ['svg xmlns', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'],
      ['licence in comment', '/* see https://www.opensource.org/licenses/mit-license and https://github.com/x/y */'],
      ['doc link in comment', '// details at https://developer.mozilla.org/en-US/docs/Web/API/WebGL'],
      ['wss to the game server', "<script>new WebSocket('wss://sp.lain42.top/ws')</script>"],
      ['relative only', '<link href="/css/theme.css"><script src="/js/main.js"></script>'],
    ]) {
      assert.deepEqual(hits(html), [], `${label} 不该被当成站外请求`);
    }
  });

  test('the shipped payload has zero outbound references (measured, not assumed)', () => {
    const p = 'D:/Code/_artifacts/payload-c10';
    if (!existsSync(path.join(p, 'index.html'))) return;      // local scratch tree, absent on CI
    const r = checkPayloadOffline(p);
    assert.deepEqual(r.problems.filter((x) => x.includes('会向站外发请求')), [], JSON.stringify(r.problems.slice(0, 3)));
    // and the previously published one is the red control for this rule
    const old = 'D:/Code/_artifacts/www-c5';
    if (!existsSync(path.join(old, 'index.html'))) return;
    assert.ok(checkPayloadOffline(old).problems.some((x) => x.includes('会向站外发请求')), '旧 payload 必须仍是红的');
  });
});
