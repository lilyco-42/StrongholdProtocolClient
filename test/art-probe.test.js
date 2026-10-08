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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildArtCases, mimeFor, readManifests, startProbeServer } from '../tools/art-probe.mjs';

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
