// test/lan-rooms.test.js — the picker half of the virtual-LAN channel (shell/lanRooms.js).
//
// The shell half lives in desktop/lan.mjs (test/lan.test.js). This file pins what the PICKER does with whatever
// the shell and the directory return — and, most importantly, the three rules the channel shares with
// docs/SERVER-LIST.md:
//
//   P1  a missing endpoint is normal (browser build, Android, iOS, the Tauri shell without the sidecar);
//   P2  an address from the directory is re-validated here and never auto-connected — a compromised or buggy
//       directory must not be able to point a player's client at an arbitrary host;
//   P3  purely additive — with nothing answering, the picker looks exactly as it did before.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LAN_DOWN_URL, LAN_ROOMS_URL, LAN_STATUS_URL, LAN_UP_URL,
  fetchLanRooms, fetchLanStatus, isPrivateIPv4, lanActionLabel, lanEntriesFrom, lanRoomEntry, lanSummary,
  setLanUp, splitAuthority,
} from '../shell/lanRooms.js';

/** A `fetch` that answers from a URL→{status,body} table and records every request it saw. */
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method ?? 'GET' });
    const hit = routes[String(url)];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => hit.body };
  };
  impl.seen = seen;
  return impl;
}

describe('isPrivateIPv4 / splitAuthority', () => {
  test('only loopback and the private ranges count as LAN addresses', () => {
    for (const ok of ['127.0.0.1', '10.126.126.1', '10.0.0.7', '192.168.1.5', '172.16.0.1', '172.31.255.254', '0.0.0.0']) {
      assert.equal(isPrivateIPv4(ok), true, ok);
    }
    for (const no of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '11.0.0.1', 'game.starst.site', '', '999.1.1.1', '1.2.3']) {
      assert.equal(isPrivateIPv4(no), false, no);
    }
  });

  test('splitAuthority requires an explicit, in-range port', () => {
    assert.deepEqual(splitAuthority('10.126.126.1:5150'), { host: '10.126.126.1', port: 5150 });
    assert.equal(splitAuthority('10.126.126.1'), null, 'no port means no authority');
    assert.equal(splitAuthority('10.126.126.1:0'), null);
    assert.equal(splitAuthority('10.126.126.1:70000'), null);
    assert.equal(splitAuthority(''), null);
  });
});

describe('lanRoomEntry — P2: the directory cannot aim the client at an arbitrary host', () => {
  const room = { virtualIp: '10.126.126.7', port: 5150, hostname: '小明', reachable: true, self: false, app: '0.2.4', humans: 3, rooms: 1 };

  test('a reachable private room becomes an entry', () => {
    const e = lanRoomEntry(room);
    assert.equal(e.address, '10.126.126.7:5150');
    assert.equal(e.lan, true);
    assert.equal(e.self, false);
    assert.match(e.note, /小明/);
    assert.match(e.note, /在线 3/);
    assert.match(e.note, /v0\.2\.4/);
  });

  test('an unreachable peer is dropped, not shown greyed out', () => {
    assert.equal(lanRoomEntry({ ...room, reachable: false }), null);
    assert.equal(lanRoomEntry({ ...room, reachable: undefined }), null);
  });

  test('a public address is refused even when the directory says it is reachable', () => {
    assert.equal(lanRoomEntry({ ...room, virtualIp: '8.8.8.8' }), null);
    assert.equal(lanRoomEntry({ ...room, virtualIp: 'evil.example.com' }), null);
  });

  test('a missing or bogus port is refused', () => {
    assert.equal(lanRoomEntry({ ...room, port: undefined }), null);
    assert.equal(lanRoomEntry({ ...room, port: 0 }), null);
    assert.equal(lanRoomEntry({ ...room, port: 'nope' }), null);
  });

  test('the official server keeps its own label', () => {
    const e = lanRoomEntry({ ...room, self: true, hostname: 'sp' });
    assert.equal(e.self, true);
    assert.match(e.label, /官方服/);
    assert.match(e.note, /官方服/);
  });
});

describe('lanEntriesFrom — P1/P3: anything unusable is simply not there', () => {
  test('a document without ok:true yields nothing', () => {
    assert.deepEqual(lanEntriesFrom(null), []);
    assert.deepEqual(lanEntriesFrom({}), []);
    assert.deepEqual(lanEntriesFrom({ ok: false, rooms: [{ virtualIp: '10.0.0.1', port: 5150, reachable: true }] }), []);
    assert.deepEqual(lanEntriesFrom({ ok: true }), []);
  });

  test('good entries survive and bad ones are filtered out of the same document', () => {
    const doc = {
      ok: true,
      rooms: [
        { virtualIp: '10.126.126.1', port: 5150, reachable: true, self: true },
        { virtualIp: '8.8.8.8', port: 5150, reachable: true },
        { virtualIp: '10.126.126.9', port: 5150, reachable: false },
        null,
      ],
    };
    const out = lanEntriesFrom(doc);
    assert.equal(out.length, 1);
    assert.equal(out[0].address, '10.126.126.1:5150');
  });
});

describe('lanActionLabel / lanSummary', () => {
  test('the button offers a way back once the tunnel is up, and nothing at all when there is no sidecar', () => {
    assert.equal(lanActionLabel({ state: 'up' }), '关闭联机');
    assert.equal(lanActionLabel({ state: 'degraded' }), '关闭联机');
    assert.equal(lanActionLabel({ state: 'starting' }), '关闭联机');
    assert.equal(lanActionLabel({ state: 'stopped' }), '开启联机');
    assert.equal(lanActionLabel({ state: 'error' }), '开启联机');
    // `disabled` is the browser/Android/iOS case: offering a button that cannot work is exactly what P1 forbids.
    assert.equal(lanActionLabel({ state: 'disabled' }), '');
    assert.equal(lanActionLabel(null), '');
  });

  test('the summary only counts rooms when the tunnel is actually up', () => {
    assert.equal(lanSummary({ state: 'up', message: '联机已开启' }, 3), '联机已开启 · 发现 3 个房间');
    assert.equal(lanSummary({ state: 'up', message: '联机已开启' }, 0), '联机已开启');
    assert.equal(lanSummary({ state: 'stopped', message: '联机未开启' }, 3), '联机未开启');
    assert.equal(lanSummary(null, 3), '');
  });
});

describe('the four requests', () => {
  test('the URLs are same-origin paths, not absolute URLs', () => {
    for (const u of [LAN_STATUS_URL, LAN_ROOMS_URL, LAN_UP_URL, LAN_DOWN_URL]) {
      assert.match(u, /^\/lan\//);
    }
  });

  test('fetchLanStatus returns null for a 404 shell — the browser/Android/iOS case, never a throw', async () => {
    assert.equal(await fetchLanStatus(fakeFetch({})), null);
    assert.equal(await fetchLanStatus(async () => { throw new Error('no shell'); }), null);
    assert.equal(await fetchLanStatus(fakeFetch({ [LAN_STATUS_URL]: { body: { ok: false } } })), null);
  });

  test('fetchLanStatus passes a real document through', async () => {
    const doc = { ok: true, state: 'stopped', message: '联机未开启' };
    assert.deepEqual(await fetchLanStatus(fakeFetch({ [LAN_STATUS_URL]: { body: doc } })), doc);
  });

  test('setLanUp POSTs to /lan/up or /lan/down, and a failure is null rather than an exception', async () => {
    const up = fakeFetch({ [LAN_UP_URL]: { body: { ok: true, state: 'starting' } } });
    assert.equal((await setLanUp(true, up)).state, 'starting');
    assert.deepEqual(up.seen, [{ url: LAN_UP_URL, method: 'POST' }]);

    const down = fakeFetch({ [LAN_DOWN_URL]: { body: { ok: true, state: 'stopped' } } });
    assert.equal((await setLanUp(false, down)).state, 'stopped');
    assert.deepEqual(down.seen, [{ url: LAN_DOWN_URL, method: 'POST' }]);

    assert.equal(await setLanUp(true, async () => { throw new Error('nope'); }), null);
  });
});

describe('fetchLanRooms — shell proxy first, then the directory directly', () => {
  const doc = { ok: true, rooms: [{ virtualIp: '10.126.126.1', port: 5150, reachable: true }] };
  const DIRECTORY = 'https://sp.lain42.top/api/lan/v1/rooms';

  test('the shell proxy is used when it answers', async () => {
    const f = fakeFetch({ [LAN_ROOMS_URL]: { body: doc }, [DIRECTORY]: { body: { ok: true, rooms: [] } } });
    assert.deepEqual(await fetchLanRooms(f, DIRECTORY), doc);
    assert.deepEqual(f.seen.map((r) => r.url), [LAN_ROOMS_URL], 'no second request when the proxy worked');
  });

  test('a shell without the proxy falls back to the directory URL (the Tauri shell, which has no TLS stack)', async () => {
    const f = fakeFetch({ [DIRECTORY]: { body: doc } });
    assert.deepEqual(await fetchLanRooms(f, DIRECTORY), doc);
    assert.deepEqual(f.seen.map((r) => r.url), [LAN_ROOMS_URL, DIRECTORY]);
  });

  test('with no directory URL and no proxy, nothing is asked twice and null comes back', async () => {
    const f = fakeFetch({});
    assert.equal(await fetchLanRooms(f, ''), null);
    assert.deepEqual(f.seen.map((r) => r.url), [LAN_ROOMS_URL]);
  });

  test('a directory that answers a non-ok body is null, not a half-parsed document', async () => {
    const f = fakeFetch({ [DIRECTORY]: { body: { ok: false, error: { code: 'NOPE' } } } });
    assert.equal(await fetchLanRooms(f, DIRECTORY), null);
  });

  test('a directory that throws is null (P3: additive, never an error surface)', async () => {
    const f = async () => { throw new Error('offline'); };
    assert.equal(await fetchLanRooms(f, DIRECTORY), null);
  });
});
