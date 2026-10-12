#!/usr/bin/env node
// Assemble the desktop client's virtual-LAN sidecar: download the pinned upstream EasyTier release, extract the
// few files a client needs into `build/lan/`, and write `lan-config.json` from build-time environment variables.
//
//   node tools/fetch-lan-core.mjs [--platform win32|linux|darwin] [--out build/lan] [--check]
//
// Why a download at build time rather than a vendored binary: EasyTier is LGPL-3.0, so we ship the *unmodified*
// upstream binary as a separate process and keep the provenance (version, URL, sha256) in `lan-core.json`. That
// is also why nothing here patches or rebuilds it — "mere aggregation" plus a replaceable binary is the whole
// point, and a player who prefers the official EasyTier build can drop it in `SP_LAN_DIR` instead.
//
// The network secret is NOT in this repository: it arrives as SP_LAN_NETWORK_SECRET (a CI secret) and is written
// into `lan-config.json`, which is what the shell reads. Without it, the LAN section reports `disabled` and the
// client is a normal client — so a fork or a local build degrades instead of failing.
//
// GitHub release downloads are unreachable from mainland China and were measured at ~34 KB/s from our own server
// (2026-10-13), so the default is a mirror; `SP_LAN_MIRROR` overrides it and `SP_LAN_DIRECT_URL=1` bypasses it.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.join(HERE, '..');

export const DEFAULT_VERSION = 'v2.6.4';
/** Measured fastest of the four mirrors tried on 2026-10-13 (1.88 MB/s vs 253/118/76 KB/s). */
export const DEFAULT_MIRROR = 'https://gh.dev.438250.xyz/';

/**
 * Files each platform needs. The Windows build additionally needs the TUN driver and the packet capture shims;
 * `easytier-cli` and the bundled web console are deliberately left out (the shell reports status by probing
 * 10.126.126.1:5150 instead, which saves 10 MB per installer).
 */
export const PLATFORM_FILES = Object.freeze({
  win32: ['easytier-core.exe', 'wintun.dll', 'Packet.dll', 'WinDivert64.sys'],
  linux: ['easytier-core'],
  darwin: ['easytier-core'],
});

/** Release-asset name fragment per platform/arch. */
export function assetPattern(platform, arch) {
  if (platform === 'win32') return arch === 'arm64' ? /^easytier-windows-arm64-.*\.zip$/ : /^easytier-windows-x86_64-.*\.zip$/;
  if (platform === 'linux') return arch === 'arm64' ? /^easytier-linux-aarch64-.*\.zip$/ : /^easytier-linux-x86_64-.*\.zip$/;
  if (platform === 'darwin') return arch === 'arm64' ? /^easytier-macos-aarch64-.*\.zip$/ : /^easytier-macos-x86_64-.*\.zip$/;
  return null;
}

export function pickAsset(assets, platform, arch) {
  const re = assetPattern(platform, arch);
  if (!re) return null;
  const hit = (assets ?? []).find((a) => re.test(String(a?.name ?? '')));
  return hit ? hit.name : null;
}

/** Build the `lan-config.json` body from environment variables. Returns `{config}` or `{skip, reason}`. */
export function buildLanConfig(env = {}) {
  const networkName = String(env.SP_LAN_NETWORK_NAME ?? '').trim();
  const networkSecret = String(env.SP_LAN_NETWORK_SECRET ?? '').trim();
  const peers = String(env.SP_LAN_PEERS ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!networkName || !networkSecret || !peers.length) {
    return { skip: true, reason: 'SP_LAN_NETWORK_NAME / SP_LAN_NETWORK_SECRET / SP_LAN_PEERS 未全部提供' };
  }
  return {
    config: {
      networkName,
      networkSecret,
      peers,
      directoryUrl: String(env.SP_LAN_DIRECTORY_URL ?? 'https://sp.lain42.top/api/lan/v1/rooms').trim(),
      officialVirtualIp: String(env.SP_LAN_OFFICIAL_IP ?? '10.126.126.1').trim(),
      port: Number(env.SP_LAN_GAME_PORT ?? 5150),
    },
  };
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * GET with a hard timeout.
 *
 * The timeout is not decoration: a mirror that accepts the TCP connection and then stalls (measured behaviour
 * through a domestic proxy) would otherwise hang the CI job until GitHub's own 6-hour limit. `AbortSignal.timeout`
 * turns that into a normal failure, which `main()` already knows how to degrade from.
 */
async function fetchOk(url, timeoutMs = 60000) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Release metadata is small and the API rate-limits; a short timeout keeps a slow API from blocking the build. */
const META_TIMEOUT_MS = 15000;
/** The archive is ~10 MB. At the measured-worst 34 KB/s that is ~5 min, so the default is generous on purpose. */
const DOWNLOAD_TIMEOUT_MS = Number(process.env.SP_LAN_TIMEOUT_MS || 300000);

function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // Windows runners have no `unzip` on PATH but always have PowerShell; the Unix runners are the reverse.
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`]]
      : ['unzip', ['-o', '-q', zipPath, '-d', destDir]];
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
  const platform = arg('platform', process.platform);
  const arch = arg('arch', process.arch);
  const outDir = path.resolve(CLIENT_ROOT, arg('out', path.join('build', 'lan')));
  const version = process.env.SP_LAN_VERSION || DEFAULT_VERSION;
  const mirror = process.env.SP_LAN_MIRROR ?? DEFAULT_MIRROR;
  const checkOnly = argv.includes('--check');
  // A failed download must not break the whole client build: without a sidecar the picker just hides the
  // 联机 card. `--require` (or SP_LAN_REQUIRED=1) flips that to fatal for a release where it is mandatory.
  const required = argv.includes('--require') || process.env.SP_LAN_REQUIRED === '1';

  const { config, skip, reason } = buildLanConfig(process.env);

  // 1) Which asset?
  let asset = null;
  try {
    const body = await fetchOk(`https://api.github.com/repos/EasyTier/EasyTier/releases/tags/${version}`, META_TIMEOUT_MS);
    asset = pickAsset(JSON.parse(body.toString()).assets, platform, arch);
  } catch (e) {
    console.warn(`[lan] release 元数据获取失败（${e.message}），改用推断的文件名`);
  }
  if (!asset) {
    asset = platform === 'win32' ? `easytier-windows-x86_64-${version}.zip`
      : platform === 'linux' ? `easytier-linux-x86_64-${version}.zip`
        : `easytier-macos-x86_64-${version}.zip`;
  }
  const direct = `${mirror}${mirror.endsWith('/') ? '' : '/'}https://github.com/EasyTier/EasyTier/releases/download/${version}/${asset}`;

  console.log(`[lan] 平台 ${platform}/${arch}，资产 ${asset}`);
  console.log(`[lan] 版本 ${version}，镜像 ${process.env.SP_LAN_DIRECT_URL ? '(直连)' : mirror}`);
  if (checkOnly) {
    console.log(`[lan] --check：配置 ${skip ? `将跳过（${reason}）` : '就绪'}；输出目录 ${outDir}`);
    return;
  }

  // electron-builder's `extraResources: [{from: '../build/lan'}]` needs the directory to exist even when the
  // download below fails, or the entire desktop build aborts on a mirror hiccup.
  await fsp.mkdir(outDir, { recursive: true });

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-lan-core-'));
  try {
    let zipBuf;
    try {
      zipBuf = await fetchOk(process.env.SP_LAN_DIRECT_URL ? direct.replace(mirror, '') : direct, DOWNLOAD_TIMEOUT_MS);
    } catch (e) {
      if (required) throw e;
      console.warn(`[lan] 下载失败（${e.message}）—— 打出的客户端将不含联机组件，其余功能不受影响。`);
      console.warn(`[lan] 需要强制成功时加 --require，或设 SP_LAN_REQUIRED=1。`);
      await writeProvenance(outDir, { version, asset, url: direct, platform, arch, files: [], error: String(e.message ?? e) });
      return;
    }
    const zipPath = path.join(tmp, asset);
    await fsp.writeFile(zipPath, zipBuf);
    const digest = sha256(zipBuf);
    console.log(`[lan] 下载完成 ${zipBuf.length} 字节，sha256 ${digest}`);
    await unzip(zipPath, tmp);

    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.mkdir(outDir, { recursive: true });
    const wanted = PLATFORM_FILES[platform];
    if (!wanted) throw new Error(`不支持的平台 ${platform}`);
    const found = [];
    for (const name of wanted) {
      const src = await findFile(tmp, name);
      if (!src) throw new Error(`${asset} 里没有 ${name}（上游改了打包布局？）`);
      await fsp.copyFile(src, path.join(outDir, name));
      if (name.startsWith('easytier-core')) await fsp.chmod(path.join(outDir, name), 0o755);
      found.push(name);
    }

    // 2) The config the shell reads. Absent secrets = feature disabled, never a broken build.
    if (skip) {
      console.warn(`[lan] 跳过 lan-config.json：${reason}`);
      console.warn('[lan] 这样打出来的客户端「联机」一栏会显示为未配置，其余功能不受影响。');
    } else {
      await fsp.writeFile(path.join(outDir, 'lan-config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      console.log(`[lan] 写入 lan-config.json（网络名 ${config.networkName}，${config.peers.length} 个共享节点）`);
    }

    // 3) Provenance, for the LGPL trail and for "did the artifact really change" checks.
    await writeProvenance(outDir, { version, asset, url: direct, sha256: digest, platform, arch, files: found });
    console.log(`[lan] 完成 → ${outDir}（${found.join(', ')}）`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/** Write `lan-core.json`: the LGPL trail, and the record of what this build actually put in the sidecar. */
async function writeProvenance(outDir, { version, asset, url, sha256: digest, platform, arch, files, error }) {
  await fsp.writeFile(path.join(outDir, 'lan-core.json'), JSON.stringify({
    source: 'https://github.com/EasyTier/EasyTier',
    version, asset, url, sha256: digest ?? null, license: 'LGPL-3.0',
    files, platform, arch,
    ...(error ? { error } : {}),
    note: 'unmodified upstream binary; ship this file and EasyTier\'s LICENSE with the installer',
  }, null, 2) + '\n');
}

/** Find a file by basename anywhere under `dir`. */
async function findFile(dir, name) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}` || path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`[lan] 失败：${e.message}`); process.exit(1); });
}
