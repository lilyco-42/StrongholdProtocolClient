// The probe (shell/picker.js) is what makes a server row mean something: green = the player really gets in. Its two
// inputs are browser APIs whose behaviour the test must model rather than run:
//
//   * a failed WebSocket handshake exposes *no* reason — 404, 503 and a dead port all arrive as a bare close;
//   * a `no-cors` fetch resolves for *any* HTTP response (even 404/503) and rejects only when the host did not
//     answer, which is the one thing that can separate "wrong server" from "no server".
//
// Both rules above were measured against the live third-party servers on 2026-10-05. What runs here is the real
// payload module graph — the patched js/net.js from the game checkout plus the copied js/shell/* — so `toWsUrl` and
// the picker's import list are exercised for real, with only those two APIs scripted. Skipped, like the other
// contract lanes, when there is no game checkout next to this repo.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { PATCHED_FILES, applyPayloadPatch, assertPatched } from '../tools/payload-patches.mjs';
import { SHELL_FILES, shellSource } from '../tools/package-client.mjs';
import { findGameRoot } from '../tools/game-contract.mjs';
import { K_CHOSEN, K_SERVER, probeReason } from '../shell/picker-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_ROOT = (() => {
  try {
    return findGameRoot({ clientRoot: ROOT });
  } catch {
    return null;
  }
})();

const TIMEOUT = 40;

/**
 * Script what the network answers for one test.
 * @param {{open?: string[], flaky?: string[], cors?: Record<string, object>, answered?: string[], hang?: boolean,
 *          healthDelay?: number}} w
 *   `open` socket URLs whose handshake succeeds, `flaky` ones that only succeed on a second attempt,
 *   `cors` health URLs that return JSON with CORS headers, `answered` health URLs reachable without CORS
 *   headers, `hang` = health requests never settle at all, `healthDelay` = how long /healthz takes (a real one is
 *   tens of ms while a dead port's handshake fails at once, so the probe has to hold the failure open).
 */
function scriptWorld(w = {}) {
  const open = new Set(w.open ?? []);
  const flaky = new Set(w.flaky ?? []);
  const cors = w.cors ?? {};
  const answered = new Set(w.answered ?? []);
  const delay = w.healthDelay ?? 0;
  const tried = { sockets: [], health: [] };
  const hits = new Map();
  // Lazy on purpose: a rejected promise created up front would sit unhandled until the timer attaches its handler.
  const slow = (make) => new Promise((resolve, reject) => {
    setTimeout(() => { make().then(resolve, reject); }, delay);
  });

  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url;
      tried.sockets.push(url);
      const n = (hits.get(url) ?? 0) + 1;
      hits.set(url, n);
      this.readyState = 0;
      setTimeout(() => {
        const works = open.has(url) && !(flaky.has(url) && n < 2);
        if (works) {
          this.readyState = 1;
          this.onopen?.({});
        } else {
          this.readyState = 3;
          this.onclose?.({ code: 1006 });
        }
      }, 1);
    }

    close() { this.readyState = 3; }
  };

  globalThis.fetch = (url, opts = {}) => {
    tried.health.push({ url, mode: opts.mode ?? 'cors' });
    if (w.hang) return new Promise(() => {});
    if ((opts.mode ?? 'cors') === 'no-cors') {
      return slow(() => (answered.has(url) ? Promise.resolve({}) : Promise.reject(new TypeError('Failed to fetch'))));
    }
    const body = cors[url];
    if (body === undefined) return slow(() => Promise.reject(new TypeError('CORS error')));
    return slow(() => Promise.resolve({ json: () => Promise.resolve(body) }));
  };

  return { tried };
}

describe('the server probe', { skip: GAME_ROOT ? false : 'no Stronghold-Protocol checkout next to this repo' }, () => {
  let dir = null;
  let picker = null;
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sp-picker-'));
    // The payload keeps the game's own depths (`js/net.js` imports `../../shared/constants.js`, which a *browser*
    // clamps to `/shared/…`). On a real filesystem that would escape, so the tree sits one level below `shared/`.
    const payload = path.join(dir, 'payload');
    for (const f of PATCHED_FILES) {
      const target = path.join(payload, f);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(GAME_ROOT, 'public', f), 'utf8'));
    }
    applyPayloadPatch({ gameRoot: GAME_ROOT, payloadRoot: payload });
    assertPatched(payload);
    cpSync(path.join(GAME_ROOT, 'shared'), path.join(dir, 'shared'), { recursive: true });
    for (const [name, rel] of SHELL_FILES) {
      if (!name.endsWith('.js')) continue;
      const target = path.join(payload, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, shellSource(name));
    }
    // A session that has already chosen: the module's launch decision then skips the overlay, so this lane needs no
    // DOM at all and still gets the real exports.
    globalThis.sessionStorage = { getItem: (k) => (k === K_CHOSEN ? '1' : null), setItem() {}, removeItem() {} };
    globalThis.localStorage = { getItem: (k) => (k === K_SERVER ? 'https://sp.lain42.top' : null), setItem() {}, removeItem() {} };
    picker = await import(pathToFileURL(path.join(payload, 'js', 'shell', 'picker.js')).href);
  });

  after(() => {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWebSocket;
    delete globalThis.sessionStorage;
    delete globalThis.localStorage;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('a pasted page URL is tried both where it says and at the root', async () => {
    scriptWorld();
    assert.deepEqual(picker.candidateWsUrls('https://host.example/play'), [
      'wss://host.example/play/ws', 'wss://host.example/ws',
    ], 'toWsUrl keeps the path, so the root mount has to be added explicitly');
    assert.deepEqual(picker.candidateWsUrls('192.168.1.9:3000'), [
      'ws://192.168.1.9:3000/ws', 'wss://192.168.1.9:3000/ws',
    ], 'a scheme-less host:port keeps its two-scheme guess');
  });

  test('it enters the server that answers, even when that is not the one typed', async () => {
    const { tried } = scriptWorld({ open: ['wss://host.example/ws'] });
    const r = await picker.probe('https://host.example/play', TIMEOUT);
    assert.equal(r.ok, true);
    assert.equal(r.url, 'wss://host.example/ws', 'the game gets the socket URL that actually opened');
    assert.equal(r.hadPath, true);
    assert.deepEqual(tried.sockets.sort(), ['wss://host.example/play/ws', 'wss://host.example/ws'], 'both, in one round');
  });

  test('a host that answers /healthz is reported as online even though /ws failed', async () => {
    // ark-proto.stardust.matce.cn: /ws returns 401/403, so the row must not say '无法连接'.
    const { tried } = scriptWorld({ cors: { 'https://ark-proto.stardust.matce.cn/healthz': { app: '0.1.3', humans: 3 } } });
    const r = await picker.probe('https://ark-proto.stardust.matce.cn', TIMEOUT);
    assert.equal(r.ok, false);
    assert.equal(r.online, true);
    assert.deepEqual(r.info, { app: '0.1.3', humans: 3 });
    assert.match(probeReason(r), /对方在线，但 \/ws 没通/);
    assert.equal(tried.health.filter((h) => h.mode === 'no-cors').length, 0, 'CORS worked, no second ask needed');
  });

  test('a server without CORS headers is still proven online by the no-cors ask', async () => {
    // game.xiaolubao.com: /ws answers 503 and /healthz has no CORS headers — the only case the second fetch exists for.
    const health = 'https://game.xiaolubao.com/healthz';
    const { tried } = scriptWorld({ answered: [health] });
    const r = await picker.probe('https://game.xiaolubao.com', TIMEOUT);
    assert.equal(r.ok, false);
    assert.equal(r.online, true, 'the handshake exposed nothing; the opaque fetch proved the host is alive');
    assert.equal(r.info, undefined, 'an opaque response has no readable body');
    assert.match(probeReason(r), /对方在线，但 \/ws 没通/);
    assert.ok(tried.health.some((h) => h.mode === 'no-cors' && h.url === health), 'asked again without CORS');
  });

  test('a host that answers nothing stays a plain failure', async () => {
    // A rejection proves nothing (an Android shell blocks plain http as mixed content), so no reason is claimed.
    scriptWorld();
    const r = await picker.probe('10.0.0.42:3000', TIMEOUT);
    assert.equal(r.ok, false);
    assert.equal(r.online, false);
    assert.equal(probeReason(r), '');
  });

  test('a handshake that fails first still waits for /healthz to answer', async () => {
    // The realistic ordering: an instant close (a proxy that returns 503 for /ws) and an HTTP answer tens of ms
    // later. Reporting the failure as soon as the socket closed would lose the whole point of the row.
    scriptWorld({ answered: ['https://game.xiaolubao.com/healthz'], healthDelay: 20 });
    const r = await picker.probe('https://game.xiaolubao.com', 100);
    assert.equal(r.ok, false);
    assert.equal(r.online, true, 'the probe held the failure open for the slower health answer');
    assert.match(probeReason(r), /对方在线，但 \/ws 没通/);
  });

  test('a health request that never settles cannot hang the row', async () => {
    // The failed socket deliberately waits for /healthz; the per-attempt deadline is what keeps that bounded.
    const { tried } = scriptWorld({ hang: true });
    const started = Date.now();
    const r = await picker.probe('https://host.example', 60);
    assert.equal(r.ok, false);
    assert.equal(r.online, false);
    assert.ok(Date.now() - started < 2000, `settled in ${Date.now() - started}ms`);
    assert.ok(tried.sockets.includes('wss://host.example/ws'));
  });

  test('a slow first handshake is retried instead of shown as a failure', async () => {
    scriptWorld({ open: ['wss://wei.linxia.dev/ws'], flaky: ['wss://wei.linxia.dev/ws'] });
    const r = await picker.probe('wss://wei.linxia.dev/ws', TIMEOUT);
    assert.equal(r.ok, true, 'the second attempt is what turns a flaky network into a green row');
    assert.equal(r.url, 'wss://wei.linxia.dev/ws');
  });

  test('four guesses cost one timeout, not four', async () => {
    // A firewalled host answers nothing, so every attempt runs to its deadline. Trying the scheme/mount guesses at
    // once is what keeps a hopeless row at about two rounds instead of five.
    const { tried } = scriptWorld({ hang: true });
    const started = Date.now();
    const r = await picker.probe('1.2.3.4:3000/play', 60);
    const ms = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(new Set(tried.sockets).size, 4, `ws/wss × play/root, got ${[...new Set(tried.sockets)].join(' ')}`);
    assert.equal(tried.sockets.length, 5, 'one round of four, then the best guess retried');
    assert.ok(ms < 240, `four guesses in one round plus one retry: ${ms}ms`);
  });

  test('an empty address probes nothing', async () => {
    const { tried } = scriptWorld();
    const r = await picker.probe('', TIMEOUT);
    assert.equal(r.ok, false);
    assert.deepEqual(tried.sockets, []);
    assert.deepEqual(tried.health, []);
  });
});
