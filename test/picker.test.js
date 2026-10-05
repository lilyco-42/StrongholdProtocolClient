// Rules of the shell server picker (shell/picker.js). The DOM half needs a browser (verified by loading the
// payload), so what is pinned here is the part that decides *when* a player is asked and *what* counts as a server
// address — the two places where a wrong answer is silent: a picker that never appears looks like a broken client.
//
// Dependency-free on purpose: no DOM stub, no jsdom, `node --test` straight from a fresh clone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BUILTIN_SERVERS, COMMUNITY_SERVERS, K_AUTOSTART, K_CHOSEN, K_LIST, K_SEED, K_SERVER, NAME_MAX, SEED_VERSION,
  addressError, ambiguousScheme, autostartOn, cleanName, customFrom, isAndroidUA, missingSeeds, orderCandidates,
  otherScheme, pathOf, probeReason, rootWsUrl, serverName, shouldShowPicker,
} from '../shell/picker-core.js';

describe('when the picker is shown', () => {
  test('first launch (nothing remembered) always asks', () => {
    assert.equal(shouldShowPicker({ forced: false, chosenThisSession: false, savedAddress: null, autostart: true }), true);
    assert.equal(shouldShowPicker({ forced: false, chosenThisSession: false, savedAddress: null, autostart: false }), true);
  });

  test('desktop remembers and does not ask again', () => {
    assert.equal(shouldShowPicker({ forced: false, chosenThisSession: false, savedAddress: 'localhost:3000', autostart: true }), false);
  });

  test('Android (autostart off) always asks — it is the only way to switch servers there', () => {
    assert.equal(shouldShowPicker({ forced: false, chosenThisSession: false, savedAddress: 'localhost:3000', autostart: false }), true);
  });

  test('--choose-server / F2 forces it, even with something remembered', () => {
    assert.equal(shouldShowPicker({ forced: true, chosenThisSession: false, savedAddress: 'localhost:3000', autostart: true }), true);
  });

  test('a choice in this session wins: the reload after picking must not ask again (no loop)', () => {
    const base = { forced: false, savedAddress: 'localhost:3000' };
    assert.equal(shouldShowPicker({ ...base, chosenThisSession: true, autostart: true }), false);
    assert.equal(shouldShowPicker({ ...base, chosenThisSession: true, autostart: false }), false);
    // ...including a forced launch: --choose-server asks once per launch, not once per reload
    assert.equal(shouldShowPicker({ forced: true, chosenThisSession: true, savedAddress: 'localhost:3000', autostart: false }), false);
  });

  test('autostart defaults: on for desktop, off for Android, explicit value wins', () => {
    assert.equal(autostartOn(null, false), true, 'desktop default: remember and go straight in');
    assert.equal(autostartOn(undefined, true), false, 'Android default: always ask');
    assert.equal(autostartOn('0', false), false);
    assert.equal(autostartOn('1', true), true);
  });

  test('Android is detected from the WebView user agent', () => {
    assert.equal(isAndroidUA('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36'), true);
    assert.equal(isAndroidUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/44.5.1'), false);
    assert.equal(isAndroidUA(undefined), false);
  });
});

describe('server addresses', () => {
  test('accepts the shapes a player can type', () => {
    for (const ok of ['game.starst.site', '192.168.1.9:3000', 'localhost:3000', 'https://example.com', 'ws://10.0.0.5:8080/game/ws', 'http://[::1]:3000']) {
      assert.equal(addressError(ok), null, `${ok} should be accepted`);
    }
  });

  test('rejects what is not an address, with a reason', () => {
    assert.match(addressError(''), /请输入/);
    assert.match(addressError('   '), /请输入/);
    assert.match(addressError('game server'), /空格/);
    assert.equal(addressError('http://x.io/'), null, 'a trailing slash is normalised by toWsUrl, not rejected');
    assert.match(addressError('!!!'), /无法识别/);
    assert.match(addressError('game..starst'), /主机名/);
    assert.match(addressError('.starst.site'), /主机名/);
    assert.match(addressError(':3000'), /主机名/);
  });

  test('the only built-in entry is the local server the player runs themselves', () => {
    assert.deepEqual(BUILTIN_SERVERS.map((s) => s.address), ['localhost:3000']);
    assert.equal(BUILTIN_SERVERS[0].label, '本机 / 局域网');
  });

  test('the stored custom list is JSON ({name, address}) and survives garbage', () => {
    assert.deepEqual(customFrom('[{"name":"家","address":"a:1"},{"name":"","address":"b:2"}]'), [
      { name: '家', address: 'a:1' }, { name: '', address: 'b:2' },
    ]);
    assert.deepEqual(customFrom('["a:1","b:2"]'), [
      { name: '', address: 'a:1' }, { name: '', address: 'b:2' },
    ], 'the pre-name (array of strings) shape still loads');
    assert.deepEqual(customFrom(''), []);
    assert.deepEqual(customFrom(null), []);
    assert.deepEqual(customFrom('not json'), []);
    assert.deepEqual(customFrom('{"a":1}'), [], 'not an array');
    assert.deepEqual(customFrom('["ok", 7, null, " ", {"address":"c:3"}, {"name":"x"}]'), [
      { name: '', address: 'ok' }, { name: '', address: 'c:3' },
    ], 'only usable entries survive');
  });

  test('a saved server shows its name, falling back to the address when the name is blank', () => {
    assert.equal(serverName({ name: '家', address: 'a:1' }), '家');
    assert.equal(serverName({ name: '   ', address: 'a:1' }), 'a:1');
    assert.equal(serverName({ address: 'a:1' }), 'a:1');
    assert.equal(serverName(null), '');
  });

  test('the typed name is trimmed and capped to NAME_MAX', () => {
    assert.equal(cleanName('  我的服务器  '), '我的服务器');
    assert.equal(cleanName(undefined), '');
    assert.equal(cleanName('x'.repeat(NAME_MAX + 10)).length, NAME_MAX);
  });

  test('a scheme-less host:port is the ambiguous case the picker probes both ways', () => {
    for (const both of ['192.168.1.9:3000', '1.2.3.4:3000', 'example.com:8443', '[::1]:3000', 'localhost:3000', 'host:3000/path']) {
      assert.equal(ambiguousScheme(both), true, `${both} should try ws:// and wss://`);
    }
    for (const one of ['http://example.com:8443', 'wss://x.io', 'ws://x.io:3000', 'https://x.io', 'example.com', 'localhost', '', '   ']) {
      assert.equal(ambiguousScheme(one), false, `${one} needs no second attempt`);
    }
  });

  test('storage keys are namespaced under sp.shell.* so they never collide with the game"s own keys', () => {
    for (const k of [K_SERVER, K_AUTOSTART, K_LIST, K_CHOSEN, K_SEED]) assert.match(k, /^sp\.shell\./);
  });
});

// The fan-server list shipped inside the client. The addresses themselves were probed with the shipped picker code
// on 2026-10-05 (see ops docs/09 and the client README); what this lane can pin is that the table is well-formed,
// that seeding is additive, and that the two hosts measured as *not playable* never creep back in.
describe('the seeded fan-server list', () => {
  test('every entry is a usable address with a short name, and none of them is duplicated', () => {
    assert.ok(COMMUNITY_SERVERS.length >= 3, 'the point of the list is that a fresh install has servers to click');
    const seen = new Set();
    for (const e of COMMUNITY_SERVERS) {
      assert.equal(typeof e.name, 'string');
      assert.ok(e.name.trim().length > 0, `${e.address} needs a name (an empty one would show the raw URL)`);
      assert.ok(e.name.length <= NAME_MAX, `${e.name} is longer than the picker's own cap`);
      assert.equal(addressError(e.address), null, `${e.address} must be an address the picker accepts`);
      assert.ok(!seen.has(e.address), `${e.address} listed twice`);
      seen.add(e.address);
    }
  });

  test('the two measured-dead addresses stay out of the list', () => {
    // ark-proto.stardust.matce.cn answers HTTP but has no game service on /ws; xymx1234.github.io is a static page.
    const all = COMMUNITY_SERVERS.map((e) => e.address.toLowerCase()).join(' ');
    for (const dead of ['ark-proto', 'stardust', 'github.io', 'xymx1234']) {
      assert.ok(!all.includes(dead), `${dead} is not a server the client should pre-fill`);
    }
  });

  test('seeding a fresh install takes the whole list in order', () => {
    assert.deepEqual(missingSeeds([], COMMUNITY_SERVERS).map((e) => e.address), COMMUNITY_SERVERS.map((e) => e.address));
  });

  test('seeding never duplicates an address the player already has', () => {
    const owned = [{ name: '我自己填的', address: 'https://game.misyra.com/play' }];
    const add = missingSeeds(owned, COMMUNITY_SERVERS);
    assert.equal(add.some((e) => e.address.includes('misyra')), false, 'misyra is already there');
    assert.equal(add.length, COMMUNITY_SERVERS.length - 1, 'everything else still gets seeded');
    // The picker passes net.js's toWsUrl as the key, so the same server typed another way counts as present too.
    const key = (a) => a.replace(/^https?:\/\//i, '').toLowerCase();
    const withBare = [{ name: '', address: 'game.misyra.com/play' }];
    assert.equal(missingSeeds(withBare, COMMUNITY_SERVERS, key).some((e) => e.address.includes('misyra')), false);
  });

  test('garbage in the stored list cannot break seeding', () => {
    assert.deepEqual(missingSeeds(null, null), []);
    assert.deepEqual(missingSeeds([{ name: '', address: '  ' }], [{ name: 'x', address: '  ' }]), [], 'a blank address is never seeded');
    assert.deepEqual(missingSeeds([{}], COMMUNITY_SERVERS).length, COMMUNITY_SERVERS.length, 'an entry with no address blocks nothing');
  });

  test('the seed marker is a version number, so a bump can push a new batch', () => {
    assert.equal(typeof SEED_VERSION, 'number');
    assert.ok(Number.isInteger(SEED_VERSION) && SEED_VERSION >= 1, 'picker.js stores it as String(SEED_VERSION)');
  });
});

// What the picker tries, and what it says when nothing worked. `toWsUrl` (the game's, patched in by
// patches/game-client.patch) normalises first, so these are written the way candidateWsUrls sees them: the socket
// URL of the typed address. Addresses below are the real third-party servers a player pasted, 2026-10-05.
describe('which socket URLs a probe tries', () => {
  test('a typed path is kept, and its root twin is tried too', () => {
    // 'https://sp.rainya.me:10166/play' → toWsUrl → 'wss://sp.rainya.me:10166/play/ws'
    assert.deepEqual(orderCandidates('wss://sp.rainya.me:10166/play/ws', false), [
      'wss://sp.rainya.me:10166/play/ws', 'wss://sp.rainya.me:10166/ws',
    ], 'a server mounted at the root is unreachable if only the pasted path is tried');
  });

  test('a root address needs exactly one candidate', () => {
    assert.deepEqual(orderCandidates('wss://wei.linxia.dev/ws', false), ['wss://wei.linxia.dev/ws']);
    assert.deepEqual(orderCandidates('', false), []);
  });

  test('a scheme-less host:port still tries ws:// and wss://, path first', () => {
    assert.deepEqual(orderCandidates('ws://192.168.1.9:3000/ws', true), [
      'ws://192.168.1.9:3000/ws', 'wss://192.168.1.9:3000/ws',
    ]);
    assert.deepEqual(orderCandidates('ws://1.2.3.4:3000/play/ws', true), [
      'ws://1.2.3.4:3000/play/ws', 'ws://1.2.3.4:3000/ws', 'wss://1.2.3.4:3000/play/ws', 'wss://1.2.3.4:3000/ws',
    ], 'four guesses at most, best one first');
    const urls = orderCandidates('ws://h:3000/a/b/ws', true);
    assert.equal(new Set(urls).size, urls.length, 'never the same URL twice');
  });

  test('rootWsUrl only strips a real subpath', () => {
    assert.equal(rootWsUrl('wss://h:10166/play/ws'), 'wss://h:10166/ws');
    assert.equal(rootWsUrl('ws://h:3000/a/b/ws'), 'ws://h:3000/ws');
    assert.equal(rootWsUrl('wss://h/ws'), 'wss://h/ws', 'already the root one');
    assert.equal(rootWsUrl('wss://h'), 'wss://h');
    assert.equal(rootWsUrl(''), '');
  });

  test('otherScheme flips ws/wss and leaves anything else alone', () => {
    assert.equal(otherScheme('ws://h/ws'), 'wss://h/ws');
    assert.equal(otherScheme('wss://h:3000/play/ws'), 'ws://h:3000/play/ws');
    assert.equal(otherScheme('http://h/ws'), 'http://h/ws');
    assert.equal(otherScheme(undefined), '');
  });

  test('pathOf is what decides whether a failure mentions the path', () => {
    assert.equal(pathOf('https://host/play'), '/play');
    assert.equal(pathOf('host:3000/play/'), '/play');
    assert.equal(pathOf('host/play?room=AB'), '/play');
    assert.equal(pathOf('wss://host/a/b/ws'), '/a/b/ws');
    assert.equal(pathOf('https://host/'), '', 'a bare trailing slash is not a path');
    assert.equal(pathOf('host:3000'), '');
    assert.equal(pathOf(''), '');
    assert.equal(pathOf(null), '');
  });
});

describe('what a failed probe says', () => {
  test('a host that answers /healthz over HTTP is online even though /ws failed', () => {
    // game.xiaolubao.com answers 503 on /ws, ark-proto.stardust.matce.cn 401/403: alive, not a game endpoint.
    assert.match(probeReason({ online: true, hadPath: false }), /对方在线，但 \/ws 没通/);
    assert.match(probeReason({ online: true, hadPath: true }), /与该路径下的 \/ws 都没通/);
  });

  test('nothing is claimed when /healthz did not prove anything', () => {
    // A no-cors rejection proves nothing (an Android shell blocks plain http as mixed content), so the row keeps
    // the plain '无法连接' rather than a wrong '主机无响应'.
    assert.equal(probeReason({ online: false, hadPath: true }), '');
    assert.equal(probeReason({}), '');
  });

  test('a probe that worked never gets a failure clause, whatever else it learned', () => {
    // Live 2026-10-05: `sp.rainya.me:10166/play` opened the *root* /ws while still reporting /healthz online, so a
    // result can be both ok and online. Keying the clause on the failure only is what keeps that row green.
    assert.equal(probeReason({ ok: true, online: true, hadPath: true }), '');
    assert.equal(probeReason({ ok: true, online: false, hadPath: false }), '');
  });
});

// The DOM half cannot run here, but its import list can be checked against the pure module: index.html loads
// /js/shell/picker.js as a module, and one name that does not exist throws while evaluating it — which would leave
// every player staring at the boot screen with no picker and no test failure.
describe('the picker module graph', () => {
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const core = read('../shell/picker-core.js');
  const picker = read('../shell/picker.js');
  const exportsOf = (src) => new Set(
    [...src.matchAll(/export\s+(?:function|const|class)\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]));
  const importedBy = (src) => {
    const m = /import\s*\{([^}]*)\}\s*from\s*'\.\/picker-core\.js'/.exec(src);
    if (!m) return null;
    return new Set(m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
  };

  test('picker.js imports only names picker-core.js exports', () => {
    const imported = importedBy(picker);
    assert.ok(imported, "picker.js must import its rules from './picker-core.js'");
    for (const name of imported) {
      assert.ok(exportsOf(core).has(name), `picker-core.js does not export ${name}`);
    }
  });

  test('every rule picker.js calls is imported', () => {
    const imported = importedBy(picker);
    assert.ok(imported, "picker.js must import its rules from './picker-core.js'");
    const body = picker.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\s*$)/.test(line)).join('\n');
    const called = new Set([...body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
    for (const name of exportsOf(core)) {
      if (called.has(name)) assert.ok(imported.has(name), `picker.js calls ${name}() but never imports it`);
    }
  });
});
