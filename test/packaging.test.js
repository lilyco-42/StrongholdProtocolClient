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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPatch, parsePatch, stripPath } from '../tools/unified-diff.mjs';
import { DATA_SHIM_JS, SIM_PRIVATE, findGameRoot, isGameRoot, readGameContract, verifyGameContract, readProtocolVersion } from '../tools/game-contract.mjs';
import { PATCHED_FILES, applyPayloadPatch, assertPatched } from '../tools/payload-patches.mjs';
import { assembleClient, runtimeConfigSource, DEFAULT_SERVER, CLIENT_ROOT, SHELL_FILES, parseCommonArgs } from '../tools/package-client.mjs';
import { desktopTargets } from '../tools/package-desktop.mjs';
import { checkPayloadOffline, checkZipOffline } from '../tools/check-payload-offline.mjs';

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

  test('DATA_SHIM_JS / SIM_PRIVATE match server/index.js', () => {
    assert.doesNotThrow(() => verifyGameContract(GAME_ROOT));
    const { shim, simPrivate } = readGameContract(readFileSync(path.join(GAME_ROOT, 'server', 'index.js'), 'utf8'));
    assert.equal(shim, DATA_SHIM_JS);
    assert.deepEqual(simPrivate, [...SIM_PRIVATE]);
    assert.equal(typeof readProtocolVersion(GAME_ROOT), 'number');
    assert.ok(isGameRoot(GAME_ROOT));
  });

  test('the shell serves the payload with the game server"s MIME table', async () => {
    const { MIME } = await import('../desktop/serve.mjs');
    const src = readFileSync(path.join(GAME_ROOT, 'server', 'index.js'), 'utf8');
    const block = /export const MIME = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(src);
    assert.ok(block, 'MIME 表解析失败：游戏仓库 server/index.js 的 MIME 写法变了');
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

  test('electron-builder config agrees: folder target, trimmed locales, payload as resources/www', () => {
    const build = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).build;
    assert.deepEqual(build.win.target, ['dir']);
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
    writeFileSync(path.join(root, 'data', 'assets.json'),
      JSON.stringify(o.cdn ? { bgm: 'https://dl.lain42.top/site/assets/audio/x.mp3' } : { bgm: 'assets/audio/x.mp3' }));
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
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    assert.match(r.problems[0], /^index\.html 引用外部字体主机 fonts\.googleapis\.com/);
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

describe('artifact-level offline gate (reads APK zip entries)', () => {
  // The payload gate is not enough on its own: electron-builder puts the game www next to the 29 KB shell asar
  // (resources/www), and Capacitor stores it *deflate-compressed* inside the apk. Measured on the published apk:
  // grepping the whole file for "fonts.googleapis.com" gives 0, while the entry itself contains it twice — so an
  // artifact gate that does not open the zip would have waved the old build through.

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
    return t;
  })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  /** A real (small) zip: local headers + central directory + EOCD, stored or deflate per entry. */
  const makeZip = (items) => {
    const locals = [], cents = [];
    let offset = 0;
    for (const { name, text, method = 8 } of items) {
      const nameBuf = Buffer.from(name, 'utf8');
      const raw = Buffer.from(text, 'utf8');
      const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
      const crc = crc32(raw);
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
    assert.equal(r.problems.length, 1, JSON.stringify(r.problems));
    assert.match(r.problems[0], /^index\.html 引用外部字体主机/);
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
    const desktopJob = wf.slice(wf.indexOf('  desktop:'), wf.indexOf('  android:'));
    const androidJob = wf.slice(wf.indexOf('  android:'));
    assert.match(desktopJob, /check-payload-offline\.mjs build\/desktop\/win-unpacked\/resources\/www/, 'desktop: gate over the built exe');
    assert.match(androidJob, /check-payload-offline\.mjs --zip mobile\/android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk/, 'android: gate over the built apk');
    for (const [name, job, build] of [['desktop', desktopJob, 'npm run pack'], ['android', androidJob, 'gradlew']]) {
      const at = job.indexOf('产物内，闸门');
      assert.ok(at > 0, `${name}: the artifact gate step exists`);
      assert.ok(job.indexOf(build) < at, `${name}: the artifact gate runs after the binary exists`);
    }
  });
});
