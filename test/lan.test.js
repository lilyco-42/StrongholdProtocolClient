// Tests for the virtual-LAN sidecar (desktop/lan.mjs).
//
// Everything here runs without Electron, without a real TUN adapter and without the upstream binary: the
// manager takes `spawn`/`fetchImpl` by injection, and the pure helpers are checked directly. The one test that
// touches the filesystem uses a temp directory and a *fake* easytier-core script, so it never needs the 24 MB
// Windows binary (which CI builds download, not this suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  CONFIG_FILE, RPC_PORTAL, buildCoreArgs, coreBinaryName, createLanManager, describeStatus, lanCandidates,
  readLanConfig, redact, renderClientToml,
} from '../desktop/lan.mjs';

const GOOD = {
  networkName: 'stronghold-lan',
  networkSecret: 'S3CRET-value-32-chars',
  peers: ['tcp://sp.lain42.top:11010', 'udp://sp.lain42.top:11010'],
  directoryUrl: 'https://sp.lain42.top/api/lan/v1/rooms',
};

/* ------------------------------------------------------------------ pure helpers */

test('readLanConfig accepts a complete file and applies the defaults', () => {
  const { config, error } = readLanConfig(JSON.stringify(GOOD));
  assert.equal(error, undefined);
  assert.equal(config.networkName, 'stronghold-lan');
  assert.equal(config.peers.length, 2);
  assert.equal(config.officialVirtualIp, '10.126.126.1');
  assert.equal(config.port, 5150);
});

test('readLanConfig rejects each missing piece with a readable reason (never throws)', () => {
  assert.match(readLanConfig('{ not json').error, /不是合法 JSON/);
  assert.match(readLanConfig('[]').error, /缺少 networkName/);
  assert.match(readLanConfig(JSON.stringify({ ...GOOD, networkName: ' ' })).error, /缺少 networkName/);
  assert.match(readLanConfig(JSON.stringify({ ...GOOD, networkSecret: '' })).error, /缺少 networkSecret/);
  assert.match(readLanConfig(JSON.stringify({ ...GOOD, peers: [] })).error, /缺少 peers/);
});

test('renderClientToml keeps the secret out of argv and quotes it safely', () => {
  const { config } = readLanConfig(JSON.stringify({ ...GOOD, networkSecret: 'a"b\\c' }));
  const toml = renderClientToml(config);
  assert.match(toml, /network_name = "stronghold-lan"/);
  assert.match(toml, /network_secret = "a\\"b\\\\c"/);
  assert.match(toml, /dhcp = true/); // a client must get an address, otherwise no TUN is created at all
  assert.match(toml, new RegExp(`rpc_portal = "${RPC_PORTAL.replace('.', '\\.')}"`));
  assert.match(toml, /uri = "tcp:\/\/sp\.lain42\.top:11010"/);
  assert.deepEqual(buildCoreArgs('/tmp/x.toml'), ['-c', '/tmp/x.toml']);
});

test('redact removes the shared secret from anything we log', () => {
  const { config } = readLanConfig(JSON.stringify(GOOD));
  assert.equal(redact(`peer joined secret=${GOOD.networkSecret} ok`, GOOD.networkSecret), 'peer joined secret=*** ok');
  assert.equal(redact('nothing to hide', GOOD.networkSecret), 'nothing to hide');
  assert.equal(redact(null, GOOD.networkSecret), '');
});

test('coreBinaryName is platform specific', () => {
  assert.equal(coreBinaryName('win32'), 'easytier-core.exe');
  assert.equal(coreBinaryName('linux'), 'easytier-core');
  assert.equal(coreBinaryName('darwin'), 'easytier-core');
});

test('lanCandidates is best-first and includes both packaged and dev locations', () => {
  const list = lanCandidates({ env: { SP_LAN_DIR: 'D:/override' }, resourcesPath: 'C:/app/resources', repoRoot: 'D:/repo' });
  assert.deepEqual(list.map((c) => c.source), ['SP_LAN_DIR', 'resources', 'repo build']);
  assert.equal(list[1].dir, path.join('C:/app/resources', 'lan'));
  assert.equal(list[2].dir, path.join('D:/repo', 'build', 'lan'));
});

/* ------------------------------------------------------------------ status machine */

test('describeStatus: no config at all means disabled, not an error', () => {
  const s = describeStatus({ config: null, child: false, reachable: null });
  assert.equal(s.state, 'disabled');
  assert.match(s.message, /没有内置联机组件/);
});

test('describeStatus: a broken config is an error with a reinstall hint', () => {
  const s = describeStatus({ config: null, configError: '缺少 peers', child: false, reachable: null });
  assert.equal(s.state, 'error');
  assert.match(s.hint, /重新安装/);
});

test('describeStatus: EPERM turns into the Windows Administrator hint', () => {
  const s = describeStatus({ config: GOOD, child: false, reachable: null, error: 'EPERM: 需要管理员权限' });
  assert.equal(s.state, 'error');
  assert.match(s.hint, /以管理员身份运行/);
});

test('describeStatus: a sidecar that died on startup gets the Administrator hint too', () => {
  // The case that actually happens on Windows: `spawn` succeeds, easytier-core cannot create the TUN adapter
  // and exits. The message is a plain exit code, so the hint must not be driven by an EPERM string match.
  const s = describeStatus({ config: GOOD, child: false, reachable: null, error: 'easytier-core 退出，代码 1：failed to create tun device', diedEarly: true });
  assert.equal(s.state, 'error');
  assert.match(s.hint, /以管理员身份运行/);
  // ...but a sidecar that ran for a while and then died is NOT an elevation problem, and must not say so.
  const later = describeStatus({ config: GOOD, child: false, reachable: null, error: 'easytier-core 退出，代码 1', diedEarly: false });
  assert.equal(later.state, 'error');
  assert.doesNotMatch(later.hint, /以管理员身份运行/);
});

test('describeStatus: child alive + official reachable = up; alive but unreachable = degraded', () => {
  assert.equal(describeStatus({ config: GOOD, child: true, reachable: true, pid: 42 }).state, 'up');
  const degraded = describeStatus({ config: GOOD, child: true, reachable: false, pid: 42 });
  assert.equal(degraded.state, 'degraded');
  assert.match(degraded.message, /还没探到官方服/);
  assert.equal(describeStatus({ config: GOOD, child: true, reachable: null }).state, 'starting');
  assert.equal(describeStatus({ config: GOOD, child: false, reachable: null }).state, 'stopped');
});

test('describeStatus never carries the secret', () => {
  for (const f of [{ config: null }, { config: GOOD, child: true, reachable: true }, { config: GOOD, child: false, error: 'EPERM' }]) {
    assert.doesNotMatch(JSON.stringify(describeStatus(f)), /S3CRET/);
  }
});

/* ------------------------------------------------------------------ manager wiring */

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('exit', 0, 'SIGTERM'); return true; };
  return child;
}

function tempLanDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lan-'));
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(GOOD));
  fs.writeFileSync(path.join(dir, coreBinaryName()), '#!/bin/sh\nexit 0\n');
  return dir;
}

function fakeReq(method, url) {
  const res = {
    status: 0, headers: null, body: '', ended: false,
    writeHead(code, headers) { this.status = code; this.headers = headers; },
    end(text) { this.body = text ?? ''; this.ended = true; },
  };
  return [{ method, url }, res];
}

test('manager reports disabled when nothing is installed, and still answers /lan/status', async () => {
  const mgr = createLanManager({ candidates: [{ dir: '/nonexistent/lan', source: 'resources' }], userDataDir: os.tmpdir() });
  const [req, res] = fakeReq('GET', '/lan/status');
  assert.equal(await mgr.handle(req, res), true);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).state, 'disabled');
});

test('manager ignores requests outside /lan/', async () => {
  const mgr = createLanManager({ candidates: [], userDataDir: os.tmpdir() });
  const [req, res] = fakeReq('GET', '/index.html');
  assert.equal(await mgr.handle(req, res), false);
  assert.equal(res.ended, false);
});

test('manager brings the tunnel up with a config file (not argv) and reports up', async () => {
  const dir = tempLanDir();
  const spawned = [];
  const child = fakeChild();
  const mgr = createLanManager({
    candidates: [{ dir, source: 'resources' }],
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ud-')),
    spawn: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return child; },
    fetchImpl: async () => ({ ok: true }),
    logger: { log() {}, warn() {} },
  });
  const [req, res] = fakeReq('POST', '/lan/up');
  await mgr.handle(req, res);
  const body = JSON.parse(res.body);
  assert.equal(body.state, 'up');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args[0], '-c');
  assert.doesNotMatch(JSON.stringify(spawned[0].args), /S3CRET/); // the whole point of the config file
  const toml = fs.readFileSync(spawned[0].args[1], 'utf8');
  assert.match(toml, /network_secret = "S3CRET-value-32-chars"/);
  // 0600 is requested for the file that carries the secret. Windows has no POSIX permission bits at all
  // (stat reports 0666 there), so the assertion is POSIX-only — see desktop/lan.mjs.
  if (process.platform !== 'win32') {
    const mode = fs.statSync(spawned[0].args[1]).mode & 0o777;
    assert.equal(mode, 0o600, `config must be 0600, got ${mode.toString(8)}`);
  }

  // Second /lan/up is a no-op (idempotent), and /lan/down kills the child.
  await mgr.handle(...fakeReq('POST', '/lan/up'));
  assert.equal(spawned.length, 1);
  const [dreq, dres] = fakeReq('POST', '/lan/down');
  await mgr.handle(dreq, dres);
  assert.equal(JSON.parse(dres.body).state, 'stopped');
  assert.equal(child.killed, true);
});

test('manager surfaces a spawn failure as error (e.g. Windows without Administrator)', async () => {
  const dir = tempLanDir();
  const child = fakeChild();
  const mgr = createLanManager({
    candidates: [{ dir, source: 'resources' }],
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ud-')),
    spawn: () => { setTimeout(() => child.emit('error', Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })), 0); return child; },
    fetchImpl: async () => { throw new Error('unreachable'); },
    logger: { log() {}, warn() {} },
  });
  const [req, res] = fakeReq('POST', '/lan/up');
  await mgr.handle(req, res);
  const body = JSON.parse(res.body);
  assert.equal(body.state, 'error');
  assert.match(body.hint, /以管理员身份运行/);
});

test('manager reports a sidecar that dies on startup, and keeps its last words', async () => {
  const dir = tempLanDir();
  const child = fakeChild();
  const mgr = createLanManager({
    candidates: [{ dir, source: 'resources' }],
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ud-')),
    spawn: () => {
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('failed to create tun device: access is denied\n'));
        child.emit('exit', 1, null);
      }, 0);
      return child;
    },
    fetchImpl: async () => { throw new Error('unreachable'); },
    logger: { log() {}, warn() {} },
  });
  const [req, res] = fakeReq('POST', '/lan/up');
  await mgr.handle(req, res);
  const body = JSON.parse(res.body);
  assert.equal(body.state, 'error');
  assert.match(body.message, /代码 1/);
  assert.match(body.message, /access is denied/, 'the sidecar own last stderr line is the only real clue');
  assert.match(body.hint, /以管理员身份运行/);
  assert.equal(mgr._state.diedEarly, true);
});

test('the shared secret never reaches the status payload or the captured stderr tail', async () => {
  const dir = tempLanDir();
  const child = fakeChild();
  const mgr = createLanManager({
    candidates: [{ dir, source: 'resources' }],
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ud-')),
    spawn: () => {
      setTimeout(() => {
        child.stderr.emit('data', Buffer.from(`handshake with ${GOOD.networkSecret} refused\n`));
        child.emit('exit', 1, null);
      }, 0);
      return child;
    },
    fetchImpl: async () => { throw new Error('unreachable'); },
    logger: { log() {}, warn() {} },
  });
  const [req, res] = fakeReq('POST', '/lan/up');
  await mgr.handle(req, res);
  assert.doesNotMatch(res.body, /S3CRET/, 'the sidecar may echo the secret; the status must not');
});

test('manager proxies the directory and degrades when it is missing or unreachable', async () => {  const dir = tempLanDir();
  const ok = createLanManager({
    candidates: [{ dir, source: 'resources' }],
    userDataDir: os.tmpdir(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, rooms: [{ virtualIp: '10.126.126.2' }] }) }),
  });
  const [roomsReq, roomsRes] = fakeReq('GET', '/lan/rooms');
  await ok.handle(roomsReq, roomsRes);
  assert.equal(JSON.parse(roomsRes.body).rooms.length, 1);

  const bad = createLanManager({
    candidates: [{ dir, source: 'resources' }],
    userDataDir: os.tmpdir(),
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  const [badReq, badRes] = fakeReq('GET', '/lan/rooms');
  await bad.handle(badReq, badRes);
  assert.equal(JSON.parse(badRes.body).error.code, 'DIRECTORY_UNREACHABLE');
});
