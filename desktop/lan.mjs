// Virtual-LAN sidecar for the packaged desktop client.
//
// The client ships `easytier-core` (LGPL-3.0, unmodified upstream binary) plus a build-time `lan-config.json`.
// This module starts it with that config, watches it, and exposes four same-origin endpoints on the shell's
// loopback server so the picker (which runs inside the WebView at `http://127.0.0.1:<port>`) can offer
// "一键联机" without knowing any address, secret or CORS rule:
//
//   GET  /lan/status → { state, message, hint, official, rooms… }   (never contains the secret)
//   POST /lan/up     → bring the tunnel up (idempotent)
//   POST /lan/down   → tear it down (idempotent)
//   GET  /lan/rooms  → our LAN directory, proxied so the page needs no second origin
//
// Absent endpoints are normal: the browser build, the Android WebView and iOS have no shell, so the picker
// treats a 404 here exactly like "this build cannot do LAN play" and hides the section (same P1 rule as
// docs/SERVER-LIST.md).
//
// Why a config file instead of argv: `--network-secret` on a command line is world-readable through `ps`, and
// the secret is shared by every player. `lan-config.json` is read once and rewritten as a 0600 TOML under the
// user-data directory, which is what the child process actually gets.
//
// Windows needs Administrator to create the Wintun adapter. We do NOT silently elevate: a failed spawn is
// reported as `error` with an actionable hint, and the game stays fully playable without the tunnel.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const LAN_ROUTE_PREFIX = '/lan/';
export const CONFIG_FILE = 'lan-config.json';
/** Where the sidecar lives inside the packaged app (`extraResources`), relative to resources/. */
export const RESOURCE_SUBDIR = 'lan';
/** A fixed, uncommon RPC port so a player who also runs the official EasyTier GUI (which defaults to 15888) can
 *  keep both up; the two instances then differ by port and instance name. */
export const RPC_PORTAL = '127.0.0.1:15988';
export const DEV_NAME = 'stronghold-lan';

/** The upstream binary name for a platform. */
export function coreBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'easytier-core.exe' : 'easytier-core';
}

/**
 * Candidate `{dir, source}` roots that may hold the sidecar + config, best-first.
 * Mirrors payload-path.mjs: one list, shared by the Electron and Tauri shells.
 * The repo-build directory is flat (`build/lan/`) because a build only ever targets one platform at a time and
 * `tools/fetch-lan-core.mjs` places that platform's files there.
 */
export function lanCandidates({ env = {}, resourcesPath, repoRoot } = {}) {
  const out = [];
  if (env.SP_LAN_DIR) out.push({ dir: env.SP_LAN_DIR, source: 'SP_LAN_DIR' });
  if (resourcesPath) out.push({ dir: path.join(resourcesPath, RESOURCE_SUBDIR), source: 'resources' });
  if (repoRoot) out.push({ dir: path.join(repoRoot, 'build', RESOURCE_SUBDIR), source: 'repo build' });
  return out;
}

/**
 * Validate a parsed `lan-config.json`. Returns `{ config }` or `{ error }` — never throws, so a malformed
 * build-time file degrades to "联机不可用" instead of breaking the shell.
 *
 * Shape: { networkName, networkSecret, peers: ["tcp://host:11010", …], directoryUrl?, officialVirtualIp? }
 */
export function readLanConfig(raw) {
  let data;
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { error: `lan-config.json 不是合法 JSON：${e.message}` };
  }
  if (!data || typeof data !== 'object') return { error: 'lan-config.json 不是对象' };
  const networkName = String(data.networkName ?? '').trim();
  const networkSecret = String(data.networkSecret ?? '').trim();
  if (!networkName) return { error: 'lan-config.json 缺少 networkName' };
  if (!networkSecret) return { error: 'lan-config.json 缺少 networkSecret' };
  const peers = (Array.isArray(data.peers) ? data.peers : []).map((p) => String(p).trim()).filter(Boolean);
  if (!peers.length) return { error: 'lan-config.json 缺少 peers（至少要有一个共享节点）' };
  return {
    config: {
      networkName,
      networkSecret,
      peers,
      directoryUrl: String(data.directoryUrl ?? '').trim(),
      officialVirtualIp: String(data.officialVirtualIp ?? '10.126.126.1').trim(),
      port: Number.isFinite(Number(data.port)) ? Number(data.port) : 5150,
    },
  };
}

/** TOML the child actually reads. Kept separate from `buildCoreArgs` so the secret never reaches argv. */
export function renderClientToml(config, { rpcPortal = RPC_PORTAL, devName = DEV_NAME } = {}) {
  const lines = [
    `instance_name = "stronghold-client"`,
    `dhcp = true`,
    `rpc_portal = "${rpcPortal}"`,
    `listeners = []`,
    '',
    '[network_identity]',
    `network_name = ${tomlString(config.networkName)}`,
    `network_secret = ${tomlString(config.networkSecret)}`,
    '',
    ...config.peers.flatMap((uri) => ['[[peer]]', `uri = ${tomlString(uri)}`, '']),
    '[flags]',
    `dev_name = "${devName}"`,
    '',
  ];
  return lines.join('\n');
}

function tomlString(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Arguments for the sidecar. Contains no secret — that lives in the TOML passed with `-c`. */
export function buildCoreArgs(configPath) {
  return ['-c', configPath];
}

/** Redact anything that could carry the secret, for logs and for the status payload. */
export function redact(text, secret) {
  const s = String(text ?? '');
  return secret ? s.split(secret).join('***') : s;
}

export const STATES = Object.freeze(['disabled', 'stopped', 'starting', 'up', 'degraded', 'error']);

/**
 * Human-readable status. Pure: give it the raw facts, get back what the picker shows.
 *
 * @param {{config: any|null, configError?: string, child: boolean, reachable: boolean|null, error?: string|null, pid?: number|null, since?: number|null}} f
 */
export function describeStatus(f) {
  const base = { state: 'disabled', message: '', hint: '', official: null };
  if (f.configError) return { ...base, state: 'error', message: `联机组件配置有误：${f.configError}`, hint: '请重新安装客户端，或向服主反馈。' };
  if (!f.config) return { ...base, state: 'disabled', message: '这个客户端没有内置联机组件。', hint: '从官网下载桌面版即可一键联机。' };
  if (f.error) {
    // On Windows a missing TUN adapter does NOT make `spawn` fail: easytier-core starts, cannot create the
    // adapter and exits within a second or two. So "it died right after starting" is the signal that actually
    // fires, and elevation is by far the most common cause of it.
    const hint = f.diedEarly
      ? '最常见的原因是 Windows 需要管理员权限才能创建虚拟网卡：关掉客户端，右键图标 →「以管理员身份运行」。'
      : /EPERM|EACCES|access is denied|requires elevation|需要提升/i.test(f.error)
        ? 'Windows 需要管理员权限才能创建虚拟网卡：右键客户端图标 →「以管理员身份运行」。'
        : '可以重试；不影响直接连官方服。';
    return { ...base, state: 'error', message: `联机启动失败：${f.error}`, hint };
  }
  if (f.child && f.reachable === true) {
    return {
      ...base,
      state: 'up',
      pid: f.pid ?? null,
      since: f.since ?? null,
      message: '联机已开启，可以看到局域网里的房间。',
      hint: '',
      official: { virtualIp: f.config.officialVirtualIp, port: f.config.port, reachable: true },
    };
  }
  if (f.child && f.reachable === false) {
    return {
      ...base,
      state: 'degraded',
      pid: f.pid ?? null,
      since: f.since ?? null,
      message: '虚拟局域网已连上，但还没探到官方服。',
      hint: '再等几秒；若是自建房间，直接看下面的局域网列表。',
      official: { virtualIp: f.config.officialVirtualIp, port: f.config.port, reachable: false },
    };
  }
  if (f.child) return { ...base, state: 'starting', pid: f.pid ?? null, since: f.since ?? null, message: '正在开启联机…', hint: '' };
  return { ...base, state: 'stopped', message: '联机未开启。', hint: '开启后可以玩局域网房间，也能少挤官方服。' };
}

/* ------------------------------------------------------------------- manager */

/**
 * Owns the child process and answers the four endpoints.
 *
 * Everything is injected (`spawn`, `fetchImpl`, `now`, `logger`) so the whole state machine is unit-testable
 * without Electron, without a real network and without the real binary.
 */
export function createLanManager({
  candidates = [],
  userDataDir,
  env = {},
  spawn = nodeSpawn,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = console,
  probeTimeoutMs = 1200,
} = {}) {
  const state = { config: null, configError: '', corePath: '', child: null, startedAt: null, lastError: null, diedEarly: false, reachable: null, configSource: '', tail: '' };

  function locate() {
    for (const { dir, source } of candidates) {
      const configPath = path.join(dir, CONFIG_FILE);
      const corePath = path.join(dir, coreBinaryName());
      let raw;
      try {
        raw = fs.readFileSync(configPath, 'utf8');
      } catch {
        continue; // no config here: not a LAN-capable build directory
      }
      const { config, error } = readLanConfig(raw);
      if (error) return { configError: error, source };
      if (!fs.existsSync(corePath)) return { configError: `找到了 ${CONFIG_FILE} 但同目录下没有 ${coreBinaryName()}`, source };
      return { config, corePath, configPath, source };
    }
    return null;
  }

  function load() {
    const found = locate();
    if (!found) { state.config = null; state.configError = ''; return; }
    if (found.configError) { state.config = null; state.configError = found.configError; state.configSource = found.source; return; }
    state.config = found.config;
    state.corePath = found.corePath;
    state.configSource = found.source;
    state.configError = '';
  }

  async function writeToml() {
    const dir = path.join(userDataDir, RESOURCE_SUBDIR);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'easytier-client.toml');
    // 0600: the secret lives here, not in argv.
    await fsp.writeFile(file, renderClientToml(state.config), { mode: 0o600 });
    return file;
  }

  async function probeOfficial() {
    if (!state.config) return null;
    const url = `http://${state.config.officialVirtualIp}:${state.config.port}/healthz`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(probeTimeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function refreshReachable() {
    state.reachable = state.child ? await probeOfficial() : null;
    return state.reachable;
  }

  /** Keep the tail of stderr: when the sidecar dies on startup, its own last words are the only real clue. */
  function remember(text) {
    const clean = redact(text, state.config?.networkSecret).trim();
    if (!clean) return;
    state.tail = `${state.tail}\n${clean}`.slice(-600);
  }

  async function start() {
    if (!state.config) load();
    if (!state.config) return status();
    if (state.child) return status();
    state.lastError = null;
    state.diedEarly = false;
    state.tail = '';
    let configPath;
    try {
      configPath = await writeToml();
    } catch (e) {
      state.lastError = `无法写入联机配置：${e.message}`;
      return status();
    }
    try {
      const child = spawn(state.corePath, buildCoreArgs(configPath), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout?.on('data', (b) => { remember(b.toString()); logger.log?.('[lan]', redact(b.toString(), state.config.networkSecret).trim()); });
      child.stderr?.on('data', (b) => { remember(b.toString()); logger.warn?.('[lan]', redact(b.toString(), state.config.networkSecret).trim()); });
      child.on('error', (e) => { state.lastError = e.code === 'EPERM' ? 'EPERM: 需要管理员权限' : e.message; state.child = null; });
      child.on('exit', (code, signal) => {
        if (state.child === child) {
          const lived = now() - (state.startedAt ?? now());
          state.child = null;
          if (code && code !== 0) {
            // A TUN adapter that cannot be created kills the sidecar in about a second; see describeStatus.
            state.diedEarly = lived < 8000;
            state.lastError = `easytier-core 退出，代码 ${code}${signal ? ` (${signal})` : ''}${state.tail ? `：${state.tail.split('\n').filter(Boolean).pop()}` : ''}`;
          }
        }
      });
      state.child = child;
      state.startedAt = now();
      // Give it a moment to create the adapter before the first reachability probe.
      await new Promise((r) => setTimeout(r, 1500));
      await refreshReachable();
    } catch (e) {
      state.lastError = e.message;
      state.child = null;
    }
    return status();
  }

  function stop() {
    const child = state.child;
    state.child = null;
    state.reachable = null;
    state.startedAt = null;
    if (!child) return status();
    try { child.kill(); } catch { /* already gone */ }
    return status();
  }

  function status() {
    return {
      ok: true,
      schemaVersion: 1,
      ...describeStatus({
        config: state.config,
        configError: state.configError,
        child: Boolean(state.child),
        reachable: state.reachable,
        error: state.lastError,
        diedEarly: state.diedEarly,
        pid: state.child?.pid ?? null,
        since: state.startedAt,
      }),
      source: state.configSource || null,
      directoryUrl: state.config?.directoryUrl || '',
    };
  }

  async function rooms() {
    if (!state.config && !state.configError) load(); // /lan/rooms may be the first call in a fresh process
    const url = state.config?.directoryUrl;
    if (!url) return { ok: false, error: { code: 'NO_DIRECTORY' } };
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } });
      if (!res.ok) return { ok: false, error: { code: 'DIRECTORY_HTTP_' + res.status } };
      const doc = await res.json();
      if (!doc || doc.ok !== true) return { ok: false, error: { code: 'DIRECTORY_BAD_BODY' } };
      return doc;
    } catch (e) {
      return { ok: false, error: { code: 'DIRECTORY_UNREACHABLE', message: String(e?.message ?? e) } };
    }
  }

  /** Handle a `/lan/*` request. Returns true when the request was ours. */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(LAN_ROUTE_PREFIX)) return false;
    const route = url.pathname.slice(LAN_ROUTE_PREFIX.length).replace(/\/+$/, '');
    const json = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : text);
    };
    if (route === 'status' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!state.config && !state.configError) load();
      await refreshReachable();
      return json(200, status()), true;
    }
    if (route === 'up' && req.method === 'POST') return json(200, await start()), true;
    if (route === 'down' && req.method === 'POST') return json(200, stop()), true;
    if (route === 'rooms' && (req.method === 'GET' || req.method === 'HEAD')) return json(200, await rooms()), true;
    return json(404, { ok: false, error: { code: 'NOT_FOUND' } }), true;
  }

  /** Re-read lan-config.json (a dev convenience; packaged builds never change it). */
  function reload() { load(); return status(); }

  return { handle, start, stop, status, rooms, reload, _state: state };
}
