// Tests for tools/fetch-lan-core.mjs — the build-time sidecar fetcher.
//
// Only the pure parts run here: no download, no unzip, no network. CI runs the real thing; these tests pin the
// decisions that would otherwise ship a broken or mis-licensed installer (wrong asset for the arch, a config
// written without a secret, a mirror URL built twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MIRROR, DEFAULT_VERSION, PLATFORM_FILES, assetPattern, buildLanConfig, pickAsset, sha256 } from '../tools/fetch-lan-core.mjs';

const ASSETS = [
  { name: 'easytier-linux-x86_64-v2.6.4.zip' },
  { name: 'easytier-linux-aarch64-v2.6.4.zip' },
  { name: 'easytier-windows-x86_64-v2.6.4.zip' },
  { name: 'easytier-windows-arm64-v2.6.4.zip' },
  { name: 'easytier-macos-x86_64-v2.6.4.zip' },
  { name: 'easytier-macos-aarch64-v2.6.4.zip' },
  { name: 'app-x86_64-release.apk' },
];

test('the pinned version is a tag, not a branch', () => {
  assert.match(DEFAULT_VERSION, /^v\d+\.\d+\.\d+$/);
});

test('pickAsset chooses the right archive per platform and arch', () => {
  assert.equal(pickAsset(ASSETS, 'win32', 'x64'), 'easytier-windows-x86_64-v2.6.4.zip');
  assert.equal(pickAsset(ASSETS, 'win32', 'arm64'), 'easytier-windows-arm64-v2.6.4.zip');
  assert.equal(pickAsset(ASSETS, 'linux', 'x64'), 'easytier-linux-x86_64-v2.6.4.zip');
  assert.equal(pickAsset(ASSETS, 'linux', 'arm64'), 'easytier-linux-aarch64-v2.6.4.zip');
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64'), 'easytier-macos-aarch64-v2.6.4.zip');
  // Never pick the Android app: it is a full app, not a sidecar.
  assert.equal(pickAsset(ASSETS, 'win32', 'x64')?.endsWith('.apk'), false);
});

test('pickAsset refuses an unsupported platform instead of guessing', () => {
  assert.equal(assetPattern('freebsd', 'x64'), null);
  assert.equal(pickAsset(ASSETS, 'freebsd', 'x64'), null);
});

test('PLATFORM_FILES carries the Windows TUN driver and skips the CLI', () => {
  assert.deepEqual(PLATFORM_FILES.win32, ['easytier-core.exe', 'wintun.dll', 'Packet.dll', 'WinDivert64.sys']);
  assert.deepEqual(PLATFORM_FILES.linux, ['easytier-core']);
  for (const files of Object.values(PLATFORM_FILES)) {
    assert.equal(files.some((f) => f.includes('cli')), false, 'easytier-cli is intentionally not bundled');
    assert.equal(files.some((f) => f.includes('web')), false, 'the bundled web console is not shipped');
  }
});

test('buildLanConfig refuses to write a config without every secret', () => {
  assert.equal(buildLanConfig({}).skip, true);
  assert.equal(buildLanConfig({ SP_LAN_NETWORK_NAME: 'n' }).skip, true);
  assert.equal(buildLanConfig({ SP_LAN_NETWORK_NAME: 'n', SP_LAN_NETWORK_SECRET: 's' }).skip, true, 'peers are required too');
  assert.match(buildLanConfig({ SP_LAN_NETWORK_NAME: 'n' }).reason, /SP_LAN_PEERS/);
});

test('buildLanConfig splits peers and applies the documented defaults', () => {
  const { config } = buildLanConfig({
    SP_LAN_NETWORK_NAME: 'stronghold-lan',
    SP_LAN_NETWORK_SECRET: 'secret',
    SP_LAN_PEERS: 'tcp://sp.lain42.top:11010 udp://sp.lain42.top:11010',
  });
  assert.deepEqual(config.peers, ['tcp://sp.lain42.top:11010', 'udp://sp.lain42.top:11010']);
  assert.equal(config.directoryUrl, 'https://sp.lain42.top/api/lan/v1/rooms');
  assert.equal(config.officialVirtualIp, '10.126.126.1');
  assert.equal(config.port, 5150);
});

test('buildLanConfig accepts a comma separated peer list too', () => {
  const { config } = buildLanConfig({ SP_LAN_NETWORK_NAME: 'n', SP_LAN_NETWORK_SECRET: 's', SP_LAN_PEERS: 'a,b' });
  assert.deepEqual(config.peers, ['a', 'b']);
});

test('the default mirror is the measured-fast one and is a prefix, not a full URL', () => {
  assert.equal(DEFAULT_MIRROR, 'https://gh.dev.438250.xyz/');
  assert.equal(DEFAULT_MIRROR.endsWith('/'), true);
});

test('sha256 is stable and hex', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
