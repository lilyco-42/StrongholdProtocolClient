// test/server-list.test.js — the client half of GET /servers.json (docs/SERVER-LIST.md).
//
// The server side lives in the game repository (test/http-servers.test.js in lilyco-42/Stronghold-Protocol).
// This file pins what the CLIENT does with whatever comes back — including, and especially, the cases where
// nothing usable comes back at all, because that is the normal state of every server on the network but ours.
//
// Every guard below is written so a mutation makes exactly one of them fail (the culture AGENTS.md §6 asks for).
// The one that matters most is `dismissed` — see the note in shell/serverList.js: without it a deleted server comes
// back on the next launch, which is a bug a player notices immediately and no other test here would catch.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FETCH_TIMEOUT_MS, MAX_ENTRIES, SERVERS_FORMAT_VERSION,
  addDismissed, fetchServers, newServerEntries, parseDismissed, pickServers, serversUrl,
} from '../shell/serverList.js';

/** The picker's de-duplication key, standing in for picker.js's `toWsUrl`-based `keyOf`. */
const keyOf = (a) => String(a).trim().replace(/\/+$/, '').replace(/^ws/, 'http').replace(/\/ws$/, '').toLowerCase();

describe('pickServers — what the client accepts out of a third-party body', () => {
  test('a usable body is picked up as-is', () => {
    const got = pickServers({ v: SERVERS_FORMAT_VERSION, name: 'x', servers: [{ name: 'A', address: 'https://a.example' }] }, { keyOf });
    assert.deepEqual(got, [{ name: 'A', address: 'https://a.example' }]);
  });

  test('an unknown format version is treated as no answer at all', () => {
    // NOT "parse what we can": a shape we do not know is how old and new clients read each other wrong (doc §10).
    assert.equal(pickServers({ v: SERVERS_FORMAT_VERSION + 1, servers: [{ name: 'A', address: 'https://a.example' }] }, { keyOf }), null);
  });

  test('a body that is not an object / has no servers array is no answer at all', () => {
    for (const bad of [null, undefined, 'text', 42, [], { v: 1 }, { v: 1, servers: 'nope' }, { servers: [] }]) {
      assert.equal(pickServers(bad, { keyOf }), null, `for ${JSON.stringify(bad)}`);
    }
  });

  test('an empty list is a valid answer (unlike no answer)', () => {
    assert.deepEqual(pickServers({ v: 1, servers: [] }, { keyOf }), [], 'the server exists and knows no others');
  });

  test('one broken entry drops that entry, never the list', () => {
    const got = pickServers({
      v: 1,
      servers: [
        { name: 'good', address: 'https://ok.example' },
        { name: 'no address' },
        { address: 'https://no-name.example' },
        { name: 'blank', address: '   ' },
        { name: 'nonstring', address: 42 },
        { name: 'spaces', address: 'https://has space.example' },
        'nonsense',
        7,
        null,
        { name: 'later', address: 'https://later.example' },
      ],
    }, { keyOf });
    assert.deepEqual(got.map((s) => s.name), ['good', 'later'], 'a third party\'s typo costs one row, not every row');
  });

  test('entries that normalise to the same key are de-duplicated within one response', () => {
    const got = pickServers({
      v: 1,
      servers: [
        { name: 'one', address: 'https://dup.example' },
        { name: 'two', address: 'https://dup.example/' },
      ],
    }, { keyOf });
    assert.deepEqual(got.map((s) => s.name), ['one']);
  });

  test('the entry count is capped', () => {
    const many = Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => ({ name: `s${i}`, address: `https://s${i}.example` }));
    assert.equal(pickServers({ v: 1, servers: many }, { keyOf }).length, MAX_ENTRIES);
  });

  test('name / note are truncated and capabilities are filtered, not fatal', () => {
    const got = pickServers({
      v: 1,
      servers: [{ name: 'x'.repeat(80), address: 'https://l.example', note: 'y'.repeat(200), caps: ['skins', 'diy', 'nonsense-cap', 7, ''] }],
    }, { keyOf });
    assert.equal(got[0].name.length, 32);
    assert.equal(got[0].note.length, 40);
    // Unknown capabilities pass through here (the client ignores what it does not know) — the picker only trusts
    // the ones it has UI for. What must NOT happen is the entry being thrown away over them.
    assert.deepEqual(got[0].caps, ['skins', 'diy', 'nonsense-cap']);
  });

  test('a missing caps field stays missing (absent means unknown, not "supports nothing")', () => {
    const got = pickServers({ v: 1, servers: [{ name: 'A', address: 'https://a.example' }] }, { keyOf });
    assert.equal('caps' in got[0], false, 'doc §4.2: absent = unknown = optimistic; [] = explicitly nothing');
  });
});

describe('newServerEntries — what actually gets added to the player\'s list', () => {
  const picked = [
    { name: 'A', address: 'https://a.example' },
    { name: 'B', address: 'https://b.example' },
    { name: 'C', address: 'https://c.example' },
  ];

  test('entries the player already has are skipped', () => {
    const got = newServerEntries(picked, [keyOf('https://a.example')], [], keyOf);
    assert.deepEqual(got.map((s) => s.name), ['B', 'C']);
  });

  test('an address the player typed by hand never gets a second copy', () => {
    // picker.js passes toWsUrl as keyOf, so `host`, `https://host/` and `wss://host/ws` are one server.
    const verbose = [{ name: 'A', address: 'wss://a.example/ws' }];
    assert.deepEqual(newServerEntries(verbose, [keyOf('https://a.example')], [], keyOf), []);
  });

  test('an entry the player deleted does NOT come back — the whole reason `dismissed` exists', () => {
    const got = newServerEntries(picked, [], [keyOf('https://b.example')], keyOf);
    assert.deepEqual(got.map((s) => s.name), ['A', 'C'], 'without this, deleting a server is undone on the next launch');
  });

  test('deleted entries survive across launches while new ones still arrive', () => {
    // Second run: B is still gone, and a server that added D in the meantime still reaches the player.
    const next = [...picked, { name: 'D', address: 'https://d.example' }];
    const got = newServerEntries(next, [keyOf('https://a.example')], [keyOf('https://b.example')], keyOf);
    assert.deepEqual(got.map((s) => s.name), ['C', 'D']);
  });

  test('nothing picked means nothing added', () => {
    assert.deepEqual(newServerEntries([], [keyOf('https://a.example')], [], keyOf), []);
  });
});

describe('the dismissed set', () => {
  test('round-trips and keeps the newest entry', () => {
    let text = null;
    text = addDismissed(text, 'a');
    text = addDismissed(text, 'b');
    assert.deepEqual(parseDismissed(text), ['a', 'b']);
  });

  test('re-adding the same key moves it to the end instead of duplicating it', () => {
    let text = addDismissed(addDismissed(null, 'a'), 'b');
    text = addDismissed(text, 'a');
    assert.deepEqual(parseDismissed(text), ['b', 'a']);
  });

  test('unreadable storage is treated as "nothing dismissed", never throws', () => {
    for (const bad of [null, '', '{not json', '{}', '"x"', '[1,2,3]', '[null]']) {
      assert.deepEqual(parseDismissed(bad), [], `for ${JSON.stringify(bad)}`);
    }
  });

  test('the set stays bounded', () => {
    let text = null;
    for (let i = 0; i < 260; i++) text = addDismissed(text, `k${i}`);
    const list = parseDismissed(text);
    assert.equal(list.length, 200);
    assert.equal(list[list.length - 1], 'k259', 'the newest deletions are the ones that must be remembered');
  });
});

describe('fetchServers — every failure is the same "no answer"', () => {
  const ok = (body) => ({ ok: true, json: async () => body });

  test('a good response comes back parsed', async () => {
    const body = { v: 1, servers: [] };
    assert.deepEqual(await fetchServers('https://x/servers.json', { fetchFn: async () => ok(body) }), body);
  });

  test('404 is null, not an error (P1: most servers have no such route)', async () => {
    assert.equal(await fetchServers('https://x/servers.json', { fetchFn: async () => ({ ok: false, status: 404 }) }), null);
  });

  test('a non-2xx answer is discarded even when it carries a parseable body', async () => {
    // The distinguishing case: a server that answers 404 with a JSON error page must not have that page read as a
    // server list. (The test above cannot tell `!res.ok` from a missing `json()` — this one can.)
    const body = { v: 1, servers: [{ name: 'FromAnErrorPage', address: 'https://nope.example' }] };
    const got = await fetchServers('https://x/servers.json', { fetchFn: async () => ({ ok: false, status: 404, json: async () => body }) });
    assert.equal(got, null, 'only a 2xx body is a list');
  });

  test('a network / CORS failure is null', async () => {
    const boom = async () => { throw new TypeError('Failed to fetch'); };
    assert.equal(await fetchServers('https://x/servers.json', { fetchFn: boom }), null);
  });

  test('bad JSON is null', async () => {
    const fn = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } });
    assert.equal(await fetchServers('https://x/servers.json', { fetchFn: fn }), null);
  });

  test('a hanging request times out to null instead of stalling the picker', async () => {
    const hang = () => new Promise(() => {});
    const started = Date.now();
    const got = await fetchServers('https://x/servers.json', { fetchFn: hang, timeoutMs: 50 });
    assert.equal(got, null);
    assert.ok(Date.now() - started < 2000, 'a dead server must not hold the picker open');
  });

  test('no url / no fetch at all is null, not a throw', async () => {
    assert.equal(await fetchServers(''), null);
    assert.equal(await fetchServers(null), null);
  });

  test('the default timeout is bounded', () => {
    assert.ok(FETCH_TIMEOUT_MS > 0 && FETCH_TIMEOUT_MS <= 10_000);
  });
});

describe('serversUrl', () => {
  test('builds from an http base, tolerating a trailing slash', () => {
    assert.equal(serversUrl('https://sp.lain42.top'), 'https://sp.lain42.top/servers.json');
    assert.equal(serversUrl('https://sp.lain42.top/'), 'https://sp.lain42.top/servers.json');
    assert.equal(serversUrl('http://127.0.0.1:47821'), 'http://127.0.0.1:47821/servers.json');
  });

  test('refuses a base that is not http(s) — the caller then treats it as no answer', () => {
    for (const bad of ['', null, undefined, 'sp.lain42.top', 'ws://sp.lain42.top/ws', 'file:///x']) {
      assert.equal(serversUrl(bad), null, `for ${JSON.stringify(bad)}`);
    }
  });
});
