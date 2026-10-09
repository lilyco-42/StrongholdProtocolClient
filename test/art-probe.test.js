// test/art-probe.test.js — the probe's own plumbing, checked without a browser.
//
// Two things have to be true before the CI lane's answer means anything: the case list must contain the art
// the UI actually asks for (and none of the things an `<img>` cannot load), and the server must serve the
// shipped tree the way a packaged shell does — including refusing to serve anything outside it.
// The browser-side assertions live in tools/art-probe.html; this file keeps them honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArtCases, mimeFor, pageUrlOf, readManifests, startProbeServer } from '../tools/art-probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(path.dirname(HERE), 'tools');

test('every tool parses on the Node that runs this suite', () => {
  // Node 24.9 rejects at least one nested-template-literal shape with `missing ) after argument list`, and that
  // shape is easy to write by accident in a file full of URL templates. --check is the cheap gate; it belongs in
  // the suite because the CI lanes only find out after a 20-minute build.
  for (const f of fs.readdirSync(TOOLS).filter((n) => n.endsWith('.mjs'))) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', path.join(TOOLS, f)], { stdio: 'pipe' }),
      `${f} does not parse`);
  }
});

test('mimeFor answers the extensions the payload holds, and nothing else', () => {
  assert.equal(mimeFor('/a/b/x.png'), 'image/png');
  assert.equal(mimeFor('/a/b/X.WEBP'), 'image/webp');
  assert.equal(mimeFor('/a/b/op.skel'), 'application/octet-stream');
  assert.equal(mimeFor('/a/f.woff2'), 'font/woff2');
  assert.equal(mimeFor('/a/b/unknown.qqq'), 'application/octet-stream');
});

const FIXTURE_ASSETS = {
  chars: {
    char_a: {
      avatar: '/assets/char/avatar/char_a.png',
      portrait: '/assets/char/portrait/char_a_1.png',
      spine: { front: { skel: '/assets/spine/a/front/a.skel', textures: ['/assets/spine/a/front/a.png'] } },
    },
    char_b: { avatar: '/assets/char/avatar/char_b.png', portrait: '/assets/char/portrait/char_b_1.png' },
  },
  enemies: { enemy_a: { icon: '/assets/enemy/icon/enemy_a.png' } },
  tokens: { tok_a: { owner: 'char_a', avatar: '/assets/char/avatar/char_a.png' } },
  prof: { icon: { caster: '/assets/prof/caster.png', medic: '/assets/prof/medic.png' } },
  ui: { 'skillIcon/empty': '/assets/ui/skill_empty.png', 'buffIcon/icon_team_buff': '/assets/ui/buff_team.png' },
  audio: { bgm: { lobby: { loop: '/assets/audio/bgm_lobby.mp3' } } },
};

const FIXTURE_LOCAL = {
  groups: {
    'map/autochess': {
      small: { path: '/assets/local/map/small.png', w: 128, h: 128 },
      big: { path: '/assets/local/map/big.png', w: 2048, h: 2048 },
      meshy: { path: '/assets/local/map/mesh.obj', w: 10, h: 10 },
    },
    guide: { one: { path: '/assets/local/guide/one.png', w: 1024, h: 1024 } },
  },
};

const casesOf = (opt) => buildArtCases({ assets: FIXTURE_ASSETS, local: FIXTURE_LOCAL }, opt);

test('the case list holds what an <img> can be asked to load, and nothing else', () => {
  const urls = casesOf().map((c) => c.url);
  assert.ok(urls.includes('/assets/char/portrait/char_a_1.png'), 'portraits are the reported symptom');
  assert.ok(urls.includes('/assets/char/avatar/char_a.png'));
  assert.ok(urls.includes('/assets/spine/a/front/a.png'), 'spine texture pages are the large art');
  // a .skel or an .mp3 in this list would fail in every engine and be blamed on the tree
  assert.ok(!urls.some((u) => /\.(skel|atlas|mp3|obj|woff2)$/.test(u)), `non-image in list: ${urls.filter((u) => /\.(skel|atlas|mp3|obj|woff2)$/.test(u))}`);
});

test('groups are per field, not per file, and the cap is honoured', () => {
  const cases = casesOf({ perGroup: 1 });
  const groups = new Set(cases.map((c) => c.group));
  assert.ok(groups.has('chars.portrait'));
  assert.ok(groups.has('chars.avatar'));
  assert.ok(groups.has('enemies.icon'));
  assert.ok(groups.has('assets.tokens.avatar'));
  assert.ok(groups.has('assets.prof.icon'), 'the ~90 profession icons are one group of the same shape');
  assert.ok(!([...groups].some((g) => g.startsWith('assets.audio'))), 'audio is not art');
  for (const g of groups) {
    assert.ok(cases.filter((c) => c.group === g).length <= 1, `${g} kept more than perGroup samples`);
  }
});

test('within a group the declared-largest file is the one that survives sampling', () => {
  const map = casesOf({ perGroup: 1 }).filter((c) => c.group === 'local.map');
  assert.deepEqual(map.map((c) => c.url), ['/assets/local/map/big.png']);
  assert.equal(map[0].px, 2048 * 2048);
});

test('the last case is a URL that must not resolve', () => {
  const cases = casesOf();
  const control = cases[cases.length - 1];
  assert.equal(control.group, '__control__');
  assert.match(control.url, /^\/assets\/char\/portrait\//);
  assert.ok(!cases.slice(0, -1).some((c) => c.url === control.url));
});

test('readManifests tolerates a tree without the local manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-probe-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'assets.json'), JSON.stringify(FIXTURE_ASSETS));
    const got = readManifests(dir);
    assert.ok(got.assets.chars, 'assets.json read');
    assert.equal(got.local, null, 'missing local-assets.json is null, not a crash');
    assert.ok(buildArtCases(got).length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** One request, headers + body, against the running probe server. */
function get(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the probe server serves the tree, the case list, and refuses to leave the tree', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-probe-root-'));
  const cases = casesOf();
  let server = null;
  try {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets', 'char', 'portrait'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'assets.json'), JSON.stringify(FIXTURE_ASSETS));
    // 8-byte file so Content-Length is a number we did not type from memory
    fs.writeFileSync(path.join(dir, 'assets', 'char', 'portrait', 'char_a_1.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    server = await startProbeServer({
      root: dir,
      probeHtml: path.join(TOOLS, 'art-probe.html'),
      cases,
    });
    const port = server.port;

    const file = await get(port, '/assets/char/portrait/char_a_1.png');
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal(Number(file.headers['content-length']), 8, 'a real length, so a copy step cannot exit 0 while shipping nothing');
    assert.equal(file.headers['cache-control'], 'no-store');
    assert.equal(file.headers['accept-ranges'], undefined, 'the packaged shells do not advertise ranges either');

    const head = await get(port, '/assets/char/portrait/char_a_1.png', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers['content-length']), 8);
    assert.equal(head.body, '');

    const gone = await get(port, cases[cases.length - 1].url);
    assert.equal(gone.status, 404, 'the negative control must 404 here or the browser gate proves nothing');

    const probe = await get(port, '/__art_probe__');
    assert.equal(probe.status, 200);
    assert.match(probe.headers['content-type'], /^text\/html/);
    assert.ok(probe.body.includes('__ART_PROBE__'), 'the page has to publish the result the driver reads');
    assert.ok(probe.body.includes('loading'), 'and it has to exercise the lazy attribute the client uses');

    const list = await get(port, '/__art_cases__.json');
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body).cases.map((c) => c.url), cases.map((c) => c.url));

    for (const evil of ['/%2e%2e/%2e%2e/../../package.json', '/%2e/%2e/../package.json']) {
      const r = await get(port, evil);
      assert.notEqual(r.status, 200, `${evil} must not be served`);
      assert.ok(!r.body.includes('"name": "stronghold-protocol-client"'), `${evil} leaked outside the tree`);
    }
  } finally {
    if (server) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the probe page measures the four things the driver compares', () => {
  const html = fs.readFileSync(path.join(TOOLS, 'art-probe.html'), 'utf8');
  for (const marker of ['eager', 'lazy', 'scrolled', 'rerender', '__control__', 'droppedErrored']) {
    assert.ok(html.includes(marker), `the page no longer reports ${marker}`);
  }
});

// CI 第一次跑 spine 驱动就是死在这一条上：拼出来的地址有双斜杠，服务端把 `//dev/...` 当协议相对地址解，
// 于是包内明明有的自检页答 404，两个引擎各白等满超时。这条把它钉住（纯字符串，任何机器都跑）。
test('pageUrlOf builds a path inside the tree, never a protocol-relative URL', () => {
  const S = 'http://127.0.0.1:40171/__art_probe__';
  assert.equal(pageUrlOf({ serverUrl: S, pagePath: '/dev/spine-probe.html' }), 'http://127.0.0.1:40171/dev/spine-probe.html');
  assert.equal(pageUrlOf({ serverUrl: S, pagePath: 'dev/spine-probe.html', query: 'many=8' }), 'http://127.0.0.1:40171/dev/spine-probe.html?many=8');
  assert.equal(pageUrlOf({ serverUrl: S, pagePath: '/dev/x.html', query: '?ids=112' }), 'http://127.0.0.1:40171/dev/x.html?ids=112');
  for (const u of [
    pageUrlOf({ serverUrl: S, pagePath: '/dev/spine-probe.html', query: 'many=8&ids=1,2' }),
    pageUrlOf({ serverUrl: S, pagePath: '/a/b.html' }),
  ]) {
    assert.ok(!/\/\//.test(u.slice(u.indexOf('://') + 3)), `${u} 里还有第二个斜杠 —— 服务端会把它解成协议相对地址`);
  }
  // 而且服务端真的要把它当路径解：pathname 必须是那一页，host 必须还是 127.0.0.1
  const parsed = new URL(pageUrlOf({ serverUrl: S, pagePath: '/dev/spine-probe.html' }));
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/dev/spine-probe.html');
});

// spine-probe-check.mjs 的两种「测不了」必须与「测出来了」区分开：它用退出码 2 表示探针本身不成立，
// 用 1 表示复现了 WebKit 的失败。这两条把它最前面的两道 fail-closed 门跑一遍 —— 都是纯文件系统判断，
// 不需要 Playwright，所以在客户端仓的 CI 里也能真跑（不是那种会被跳过的绿）。
// spawnSync 而不是 execFileSync：后者会把断言失败也当成进程失败抛回同一个 catch，红得很含糊。
const runDriver = (...args) => spawnSync(process.execPath,
  [path.join(TOOLS, 'spine-probe-check.mjs'), ...args, '--wait-ms', '3000'],
  { encoding: 'utf8', stdio: 'pipe' });

test('spine-probe driver exits 2 when the probe page is not in the tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-spine-'));
  try {
    const r = runDriver('--root', dir);
    assert.equal(r.status, 2, `退出码应是 2（探针不成立），实际 ${r.status}：${(r.stdout + r.stderr).slice(0, 300)}`);
    assert.match(`${r.stdout}${r.stderr}`, /包里找不到/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spine-probe driver checks the tree before it asks for an engine', () => {
  // 顺序是刻意的：包里没有自检页时报的应该是「缺页」而不是「没装 playwright」——
  // 后者会把一个打包问题伪装成环境问题，而这两种红要的处理完全不同。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-spine-'));
  try {
    fs.mkdirSync(path.join(dir, 'dev'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dev', 'spine-probe.html'), '<html></html>');
    const r = runDriver('--root', dir);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 2, `退出码应是 2，实际 ${r.status}：${out.slice(0, 300)}`);
    assert.doesNotMatch(out, /包里找不到/, '页在的时候不该再报缺页');
    // 本仓库没有依赖，所以这里应当停在「要 Playwright」；万一将来装了，它会走到「页面没结论」，
    // 两种都是探针不成立(2)，但都不能悄悄变成 0。
    assert.match(out, /Playwright|没有出现/, out.slice(0, 300));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
