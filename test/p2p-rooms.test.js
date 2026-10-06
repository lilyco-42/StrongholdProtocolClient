// Rules of the decentralized lobby (shell/p2p/rooms.js), plus a gate on the vendored P2P bundle.
//
// The transport half needs a real browser (link.js is verified end-to-end against two live pages, not here). What is
// pinned here is the part where a wrong answer is *silent*: a list that shows the same server twice, keeps a peer
// that already left, or blanks out a nameless advert all look like "the network is weird" to a player and never
// raise an error. Same stance as picker.test.js: dependency-free, `node --test` straight from a fresh clone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ADVERT_TTL_MS, MAX_ROOMS, makeAdvert, mergeAdverts, roomKey } from '../shell/p2p/rooms.js';
// The payload gate's own patterns, imported rather than re-typed — if the gate learns a new reference form, this
// test must inherit it, otherwise the vendored bundle could start failing CI with this test still green.
import { OUTBOUND } from '../tools/check-payload-offline.mjs';

describe('the decentralized lobby list', () => {
  test('the same server advertised under two paths is one row, not two', () => {
    const merged = mergeAdverts(
      [
        { address: 'wss://h.example/play/ws', name: 'A', at: 1000 },
        { address: 'wss://h.example/ws', name: 'B', at: 1001 },
      ],
      { now: 1001 },
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].address, 'wss://h.example/ws');
  });

  test('the newest advert for a server wins — a renamed room must not show its old name', () => {
    const merged = mergeAdverts(
      [
        { address: 'wss://h/ws', name: '旧名', at: 500 },
        { address: 'wss://h/ws', name: '新名', at: 900 },
      ],
      { now: 900 },
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, '新名');
  });

  test('a peer that stopped refreshing disappears instead of leaving a dead server on screen', () => {
    assert.equal(mergeAdverts([{ address: 'wss://h/ws', at: 0 }], { now: ADVERT_TTL_MS }).length, 1);
    assert.deepEqual(mergeAdverts([{ address: 'wss://h/ws', at: 0 }], { now: ADVERT_TTL_MS + 1 }), []);
  });

  test('input order does not matter — adverts arrive in socket order, not sorted', () => {
    const a = { address: 'wss://a/ws', at: 5 };
    const b = { address: 'wss://b/ws', at: 7 };
    const c = { address: 'wss://c/ws', at: 6 };
    const order = (list) => mergeAdverts(list, { now: 10 }).map((r) => r.address);
    assert.deepEqual(order([a, b, c]), order([c, a, b]));
    assert.deepEqual(order([a, b, c]), order([b, c, a]));
  });

  test('an advert with no usable address is dropped, not listed as an empty row', () => {
    assert.equal(makeAdvert({ name: '没有地址' }), null);
    assert.equal(makeAdvert({ address: '   ' }), null);
    assert.equal(makeAdvert(null), null);
    assert.deepEqual(mergeAdverts([{ name: 'x' }, { address: '' }], { now: 0 }), []);
  });

  test('a nameless advert falls back to its address rather than rendering blank', () => {
    const [room] = mergeAdverts([{ address: 'wss://h:10166/ws', at: 1 }], { now: 1 });
    assert.equal(room.name, 'wss://h:10166/ws');
  });

  test('a peer publishing endlessly cannot grow the list past the cap', () => {
    const flood = Array.from({ length: MAX_ROOMS + 20 }, (_, i) => ({ address: `wss://h${i}/ws`, at: i }));
    assert.equal(mergeAdverts(flood, { now: 1000 }).length, MAX_ROOMS);
  });

  test('an advert stamped in the future is kept — clock skew must not delete a live peer', () => {
    assert.equal(mergeAdverts([{ address: 'wss://h/ws', at: 5000 }], { now: 1000 }).length, 1);
  });

  test('equal timestamps order by name, so an unstable clock cannot shuffle the list every render', () => {
    const merged = mergeAdverts(
      [
        { address: 'wss://b/ws', name: 'bbb', at: 9 },
        { address: 'wss://a/ws', name: 'aaa', at: 9 },
      ],
      { now: 9 },
    );
    assert.deepEqual(merged.map((r) => r.name), ['aaa', 'bbb']);
  });

  test('merging never mutates what it was handed — the caller keeps sending the same echoable advert', () => {
    const input = [{ address: 'wss://h/play/ws', name: '', at: 5 }];
    const untouched = JSON.parse(JSON.stringify(input));
    mergeAdverts(input, { now: 6 });
    assert.deepEqual(input, untouched);
  });

  test('an empty or junk input list is an empty list, never a throw', () => {
    assert.deepEqual(mergeAdverts([], { now: 0 }), []);
    assert.deepEqual(mergeAdverts(undefined, { now: 0 }), []);
    assert.deepEqual(mergeAdverts([null, 42, 'x', {}], { now: 0 }), []);
  });

  test('roomKey normalises a subpath mount to the root socket, and leaves a root one alone', () => {
    assert.equal(roomKey('wss://h.example/play/ws'), 'wss://h.example/ws');
    assert.equal(roomKey('wss://h.example/ws'), 'wss://h.example/ws');
    assert.equal(roomKey('  '), '');
  });
});

describe('the vendored P2P bundle stays offline-clean', () => {
  const bundle = readFileSync(new URL('../shell/p2p/vendor/trystero.js', import.meta.url), 'utf8');

  test('trystero carries no outbound reference the payload gate would reject', () => {
    // Measured 2026-10-06: 0 hits. A re-vendor that introduces one would otherwise ship a payload that fails the
    // CI gate `零外部依赖（闸门）` — and that gate runs *after* the release, not before the commit.
    const hits = [...new Set(OUTBOUND.flatMap((rx) => [...bundle.matchAll(rx)].map((m) => m[1])))];
    assert.deepEqual(hits, [], `payload 闸门会拦下：${hits.slice(0, 3).join(', ')}`);
  });

  test('the bundle is self-contained — no bare import survives the build', () => {
    assert.equal(/(?:^|[;\s])import\s*[({"']/.test(bundle), false);
  });
});
