// Which community servers are actually alive *as Stronghold servers* right now?
//
// Why this exists: `shell/picker-core.js` seeds a list of other people's servers into every install, and the
// picker cannot tell "not a Stronghold server" from "yours is down" — it can only open a socket. A `wss` handshake
// that succeeds proves almost nothing (any reverse proxy answers 101); the protocol-level answer is the frame the
// server sends back after `hello`: a real one replies `welcome` with a `playerId`, and — since 0.2.1 — its own
// `app` version. That is the bar this tool applies, and it is the precondition for adding an entry to the seed
// list (docs/SERVERS.md in the game repo, task #61).
//
// What it does to their servers, exactly: opens one WebSocket to `/ws`, sends one `hello` with a name that says
// it is a probe, reads until `welcome` or the timeout, and closes. No room is joined, no verb is sent, no bytes
// are pulled. Run it read-only; it never writes to anything.
//
// The `hello` frame has to satisfy `shared/protocol.js validateC2S` or every server — including a healthy one —
// answers `BAD_MSG`, which is a bug in this probe and not a finding about them. Two constraints bite, both from
// the game repo: `rid` must be an **integer** when present (`protocol.js:435`, a string is `bad rid`) and `name`
// must be a non-blank string of at most `NAME_MAX_LEN = 12` characters. `helloFrame` owns both rules and
// test/probe-community-servers.test.js pins them, because a `rid: 'probe1'` string once reported ten servers dead.
//
//   node tools/probe-community-servers.mjs                        # the seeded list
//   node tools/probe-community-servers.mjs --add '网友服 · foo=https://foo.example/'
//   node tools/probe-community-servers.mjs --timeout 6000 --name '探针'
//   node tools/probe-community-servers.mjs --control https://sp.lain42.top
//
// `--control` is the positive control: a server already known to answer `welcome` proves the outgoing frame is
// well-formed, so a `BAD_MSG` beside a green control is a real answer from that fork and not a measurement artifact.
//
// Exit code: 0 when every *seeded* server answers `welcome`; 1 when any of them does not — a dead entry should be
// removed from the list (players who already have it keep it, that is what the tombstone is for), and a candidate
// that only handshakes must not be added. Candidates given with `--add` are reported but never gate the exit code:
// they are the thing being decided, not a promise already made. A failing `--control` also exits 1, because then
// nothing else in this report means anything. 2 = the probe itself cannot run (a `--name` the protocol rejects).
//
// Vantage matters as much as the frame: a TUN-mode proxy resolves every host to `198.18.0.x` and fabricates both
// outages and error tables, so a workstation run is only trustworthy to the extent the printed `→ ip` is a real
// address. `.github/workflows/probe-servers.yml` runs this on a GitHub runner for that reason.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { COMMUNITY_SERVERS, addressError } from '../shell/picker-core.js';
import { toWsUrl } from './ws-url.mjs';

/** Mirrors `NAME_MAX_LEN` in the game repo's `shared/constants.js`. */
export const NAME_MAX_LEN = 12;
/** `hello` carries the protocol version the client ships; it has stayed 1 across releases. */
export const PROTOCOL_VERSION = 1;
/** `198.18.0.0/15` is what a TUN proxy hands out instead of the real address — see the header note. */
export const FAKE_IP = /^198\.1[89]\./;

/**
 * The one frame this probe sends. `validateC2S` rejects a `rid` that is present but not an integer, and a name that
 * is blank after trimming or longer than `NAME_MAX_LEN` — so both rules live here, asserted, instead of at a call
 * site where a future flag can break them silently and every healthy server then answers `BAD_MSG`.
 * @param {{ name?: string, version?: number, rid?: number }} [opts]
 */
export function helloFrame(opts = {}) {
  const name = String(opts.name ?? '探针');
  const rid = opts.rid ?? 1;
  if (!Number.isInteger(rid) || rid < 0 || rid > 2 ** 31) throw new TypeError(`rid 必须是 0..2^31 的整数，收到 ${JSON.stringify(rid)}`);
  if (!name.trim()) throw new TypeError('name 不能为空');
  if (name.length > NAME_MAX_LEN) throw new TypeError(`name 超过 NAME_MAX_LEN=${NAME_MAX_LEN}：「${name}」有 ${name.length} 个字符`);
  return { t: 'hello', rid, name, version: opts.version ?? PROTOCOL_VERSION };
}

/**
 * A one-line description of an inbound frame, for the verdict column. `errorMsg()` (`server/net.js:328`) puts the
 * machine code in `code`, the canned text in `msg`, and the actual reason in `detail` — reading only `code` is what
 * turned a probe bug into "ten dead servers", so the reason is always carried.
 * @param {any} msg
 */
export function describeFrame(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return String(msg).slice(0, 40);
  if (msg.t === 'error' || msg.t === 'helloError') {
    const bits = [msg.code, msg.detail || msg.msg].filter(Boolean).map((s) => String(s).slice(0, 60));
    return `${msg.t}${bits.length ? ` ${bits.join(' · ')}` : ''}`;
  }
  return String(msg.t || '?').slice(0, 40);
}

/**
 * Resolve the socket's real address so a poisoned vantage shows up in the report itself, rather than ranking
 * servers by which ones the local proxy happened to tunnel.
 */
export async function resolvedIp(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/^v6-/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  try {
    const r = await lookup(host, { all: false });
    return r.address;
  } catch (e) {
    return `解析失败:${e.code || e.message}`;
  }
}

/**
 * A WebSocket `error` event carries no reason, so rows said `连不上（error）` and told us nothing about whether the
 * server is down or our own egress is. A bare socket to the same host:port separates them: `ECONNREFUSED` is a dead
 * process, a TLS error is a certificate problem, and a `TCP 通` the WebSocket then contradicts is this machine —
 * though under a TUN proxy even that only proves the proxy is listening.
 */
export function tcpProbe(host, port, tls) {
  return new Promise((resolve) => {
    const sock = (tls ? tlsConnect : netConnect)({ host, port, servername: tls ? host : undefined, timeout: 5000 });
    const finish = (verdict) => { sock.destroy(); resolve(verdict); };
    sock.on(tls ? 'secureConnect' : 'connect', () => finish('TCP 通'));
    sock.on('timeout', () => finish('TCP 超时'));
    // `tls` emits 'error' for both transport and certificate failures; the code is the part worth keeping.
    sock.on('error', (e) => finish(`${tls ? 'TLS' : 'TCP'}:${e.code || e.message}`));
  });
}

/**
 * One server, one verdict. `welcome` is the only answer that means "this is a Stronghold server".
 * @param {{ address: string, name?: string }} target
 * @param {{ timeoutMs?: number, frame?: ReturnType<typeof helloFrame>, diagnose?: boolean }} [opts]
 */
export async function probe(target, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const frame = opts.frame ?? helloFrame({});
  const out = { ...target, ws: '', ip: '', tcp: '', verdict: '', app: '', detail: '', ms: 0 };
  const t0 = Date.now();
  // `toWsUrl` accepts anything — `这不是地址` becomes `wss://这不是地址/ws` and a typo would then be reported as a
  // server that died. `addressError` is the picker's own rule, so the probe calls an address unusable in exactly
  // the cases the player's own picker would.
  const bad = addressError(target.address);
  if (bad) { out.verdict = '坏地址'; out.detail = bad; return out; }
  const url = toWsUrl(target.address);
  out.ws = url;
  if (opts.diagnose !== false) {
    const parsed = new URL(url);
    out.ip = await resolvedIp(url);
    out.tcp = await tcpProbe(parsed.hostname.replace(/^\[|\]$/g, ''), Number(parsed.port) || (parsed.protocol === 'wss:' ? 443 : 80), parsed.protocol === 'wss:');
  }
  return new Promise((resolve) => {
    if (typeof globalThis.WebSocket !== 'function') {
      out.verdict = '探针跑不起来'; out.detail = '没有全局 WebSocket（需要 Node ≥ 22.4）';
      out.ms = Date.now() - t0; resolve(out); return;
    }
    let ws;
    try { ws = new WebSocket(url); } catch (e) {
      out.verdict = '连不上'; out.detail = String(e && e.message || e);
      out.ms = Date.now() - t0; resolve(out); return;
    }
    let seen = null;
    const done = (verdict, detail = '') => {
      if (out.verdict) return;
      out.verdict = verdict;
      out.detail = detail;
      out.ms = Date.now() - t0;
      try { ws.close(); } catch { /* already gone */ }
      resolve(out);
    };
    const timer = setTimeout(() => done('只握手不回 welcome', seen ? `收到 ${seen}` : '没收到任何帧'), timeoutMs);
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify(frame));
      } catch (e) {
        clearTimeout(timer);
        done('发不出 hello', String(e && e.message || e));
      }
    });
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(String(ev.data)); } catch { /* not json */ }
      if (!msg || typeof msg !== 'object') { seen = String(ev.data).slice(0, 40); return; }
      if (msg.t === 'welcome') {
        clearTimeout(timer);
        out.app = typeof msg.app === 'string' ? msg.app : '(不带 app 字段)';
        done('welcome', msg.resumed ? 'resumed' : '');
        return;
      }
      seen = describeFrame(msg);
      // Anything that is not welcome: a fork that refuses hello says so, and that is a "do not seed" answer.
      if (msg.t === 'error' || msg.t === 'helloError') { clearTimeout(timer); done('hello 被拒', seen); }
    });
    ws.addEventListener('error', () => { clearTimeout(timer); done('连不上', seen || 'WebSocket error'); });
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      done(out.verdict || '只握手不回 welcome', seen || `close code=${ev.code ?? '?'}`);
    });
  });
}

/** `--add '网友服 · foo=https://foo.example/'` may be repeated; those entries are candidates, not promises. */
export function parseArgv(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const targets = [{ name: '对照 · 官方服', address: arg('--control', 'https://sp.lain42.top'), control: true }];
  for (const s of COMMUNITY_SERVERS) targets.push({ ...s, seeded: true });
  const bad = [];
  for (let i = argv.indexOf('--add'); i >= 0; i = argv.indexOf('--add', i + 1)) {
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) break;
    const eq = val.indexOf('=');
    if (eq <= 0) { bad.push(val); continue; }
    targets.push({ name: val.slice(0, eq), address: val.slice(eq + 1), seeded: false });
  }
  return { targets, bad, timeoutMs: Number(arg('--timeout', 8000)), name: arg('--name', '探针') };
}

/** The ranking rules, split from the printing so a test can assert them without touching a socket. */
export function summarize(results) {
  const control = results.find((r) => r.control);
  const deadControl = !control || control.verdict !== 'welcome';
  // The control row is not a seed: counting it in the alive tally would report 6/10 for a list with five entries.
  const seeds = results.filter((r) => r.seeded && !r.control);
  const dead = seeds.filter((r) => r.verdict !== 'welcome');
  return {
    control,
    deadControl,
    seeds,
    dead,
    alive: seeds.filter((r) => r.verdict === 'welcome'),
    code: deadControl || dead.length ? 1 : 0,
  };
}

async function main() {
  const { targets, bad, timeoutMs, name } = parseArgv(process.argv.slice(2));
  for (const v of bad) console.error(`--add 要写成 '名字=地址'，收到：${v}`);
  let frame;
  try {
    frame = helloFrame({ name });
  } catch (e) {
    console.error(`[probe-servers] ${e.message} —— 换一个 ≤${NAME_MAX_LEN} 个字符的名字；服务器拒绝长名字不是对方的答案`);
    process.exit(2);
  }

  console.log(`探测 ${targets.length} 台（hello→welcome，超时 ${timeoutMs} ms；frame=${JSON.stringify(frame)}；不进房、不发其它动词）\n`);
  const results = [];
  for (const t of targets) {
    const r = await probe(t, { timeoutMs, frame });
    results.push(r);
    const tag = r.control ? '对照' : r.seeded ? '种子' : '候选';
    // Under a TUN proxy the resolved address belongs to the proxy itself, so *every* per-host diagnostic on this
    // row — TCP reachability included — measures the proxy, not that server.
    const poisoned = FAKE_IP.test(r.ip);
    if (!poisoned && r.tcp === 'TCP 通' && r.verdict === '连不上') console.log('     ← TCP 通而 WS 挂：本机出口问题，不是对方宕机');
    console.log(`${tag}  ${(r.name || '').padEnd(24)} ${r.verdict.padEnd(22)} app=${(r.app || '—').padEnd(9)} ${String(r.ms).padStart(5)} ms  ${r.ws}${r.ip ? ` → ${r.ip}` : ''}${r.tcp ? ` [${r.tcp}${poisoned ? '·代理自身' : ''}]` : ''}${poisoned ? ' ← 代理假 IP，本行不可信' : ''}${r.detail ? `   (${r.detail})` : ''}`);
  }

  const sum = summarize(results);
  if (sum.deadControl) {
    const c = sum.control;
    console.error(`\n对照（${c ? c.ws : '——'}）没有回 welcome —— ${c ? `${c.verdict}${c.detail ? `（${c.detail}）` : ''}` : '缺少对照条目'}`);
    console.error('对照失败 ⇒ 这张表的排名无效：要么本机出口被代理污染，要么 hello 帧本身不对。先修探针，再谈网友服死活。');
  }
  const candidates = results.filter((r) => !r.seeded && !r.control);
  console.log(`\n种子活着（回 welcome）：${sum.alive.length}/${sum.seeds.length}；候选活着：${candidates.filter((r) => r.verdict === 'welcome').length}/${candidates.length}`);
  if (sum.dead.length) {
    console.error('\n以下种子条目已经不回 welcome —— 要么从 COMMUNITY_SERVERS 里删掉（已有的人会保留自己的副本，tombstone 只管新增），要么改成它现在的规范地址：');
    for (const r of sum.dead) console.error(`  ${r.name}  ${r.ws}  → ${r.verdict}${r.detail ? `（${r.detail}）` : ''}`);
  } else if (!sum.deadControl) {
    console.log('种子列表全部有效。');
  }
  process.exit(sum.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
