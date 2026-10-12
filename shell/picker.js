// Shell server picker — packaged clients only (never part of the game repo).
//
// Copied verbatim into the payload as /js/shell/picker.js (tools/package-client.mjs), so the relative imports below
// are payload paths: public/js/net.js is ../net.js, and the pure rules are ./picker-core.js.
//
// The payload's index.html loads this module *before* /js/main.js; ES module order guarantees it runs first, so it
// can set `globalThis.__SP_SERVER__` (read by public/js/net.js through resolveServerTarget) before the game opens
// its socket. The browser build has no such file and stays pinned to its own origin.
//
// Layout (Minecraft-like): a main page offers 单人游戏 / 多人游戏. 单人游戏 is reserved — the game has no
// server-less mode (the lobby/room/match lifecycle is server-authoritative) — so it only explains itself. 多人游戏
// opens the server list, where the player can add a server (name + address), connect directly to a typed address,
// or join a listed/remembered one.
//
// Behaviour
//   * a remembered choice in localStorage decides the server for the next launch;
//   * desktop shells skip the UI once something is remembered (reopen with F2 / --choose-server);
//   * Android always shows it — a phone has no F2 and this is the only way to switch servers there;
//   * probing opens a real /ws socket (the channel the game itself uses), so it needs no CORS headers, and it tries
//     every guess at once: ws/wss × typed-path/root. A /healthz that answers at all is what turns the bare
//     "无法连接" into "对方在线，但 /ws 没通", which is the difference the player can act on.
//   * the fan servers listed in picker-core.js (COMMUNITY_SERVERS) are seeded into the player's own editable list on
//     the first launch per SEED_VERSION, so a server that goes dark can be deleted and stays deleted.

import { toHttpUrl, toWsUrl } from '../net.js';
import {
  BUILTIN_SERVERS, COMMUNITY_SERVERS, K_AUTOSTART, K_CHOSEN, K_LIST, K_SEED, K_SERVER, NAME_MAX, SEED_VERSION,
  addressError, ambiguousScheme, autostartOn, cleanName, customFrom, isAndroidUA, isFullscreenHotkey, isPickerHotkey, missingSeeds, orderCandidates,
  pathOf, probeReason, rootWsUrl, serverName, shellFullscreenUrl, shouldShowPicker, forEachLimited,
} from './picker-core.js';
// The second server-list channel (docs/SERVER-LIST.md): ask a server which other servers it recommends. Absent
// endpoint / no CORS / a dead host are all the same "no answer" and change nothing — see shell/serverList.js.
import { K_DISMISSED, addDismissed, fetchServers, newServerEntries, parseDismissed, pickServers, serversUrl } from './serverList.js';
// The virtual-LAN channel: the desktop shell's easytier sidecar answers /lan/* on this same origin, so a player who
// downloads the exe can play on the LAN without installing anything else. No shell (browser/Android/iOS) = 404 =
// "this build cannot do LAN play", and the section is hidden — see shell/lanRooms.js.
import { fetchLanRooms, fetchLanStatus, lanActionLabel, lanEntriesFrom, lanSummary, setLanUp } from './lanRooms.js';

// Cross-region mobile TLS handshakes sometimes need more than four seconds.
const PROBE_TIMEOUT_MS = 6500;
// Limit simultaneous host TLS/WebSocket handshakes when opening the server list.
const MAX_SERVER_PROBES = 2;
const PONG_WAIT_MS = 1200; // protocol RTT sample timeout, independent of handshake
const isAndroid = () => isAndroidUA(globalThis.navigator?.userAgent);

/**
 * The address the payload was built for (runtime-config.js), captured before a remembered choice overrides
 * `__SP_SERVER__` further down — otherwise that remembered address would be listed as the "默认" one.
 */
const PAYLOAD_SERVER = typeof globalThis.__SP_SERVER__ === 'string' ? globalThis.__SP_SERVER__.trim() : '';

/** localStorage/sessionStorage that never throws (disabled storage, private mode). */
function store(kind) {
  try {
    return globalThis[kind] || null;
  } catch {
    return null;
  }
}

function readItem(key, kind) {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeItem(key, value, kind) {
  try {
    if (value === null || value === undefined) store(kind)?.removeItem(key);
    else store(kind)?.setItem(key, value);
  } catch { /* ignore */ }
}

/** The address the payload was built for (runtime-config.js). */
function buildDefault() {
  return PAYLOAD_SERVER || BUILTIN_SERVERS[0].address;
}

/** Normalised socket URL of an address ('' → null). toWsUrl normalises rather than validates; addressError does that. */
const keyOf = (address) => (typeof address === 'string' && address.trim() ? toWsUrl(address) : null);

/**
 * The socket URL the game boots with — a pasted path is dropped unless it already *is* the socket.
 *
 * `public/js/net.js` takes exactly one URL and never retries, and the game server rejects every other path:
 * `server/index.js` answers the upgrade only for `rawPath === '/ws'` and `reject(404, 'Not Found')` otherwise.
 * Measured 2026-10-07 on all ten seeded servers: root `/ws` → 101 on 10/10, while the three seeded addresses that
 * carry a path (`https://game.misyra.com/play`, `https://game.rainya.me/play`, `https://sp.rainya.me:10166/play`)
 * return **404** at `<path>/ws`. The picker probes both mounts, so its row can read 可连接 while the game —
 * handed the typed address after a failed or skipped probe — shows the player a bare "Not Found".
 */
export const bootUrlOf = (address) => {
  const s = typeof address === 'string' ? address.trim() : '';
  if (!s) return '';
  const ws = toWsUrl(s);
  return ws ? rootWsUrl(ws) : s;
};

/** Escape interpolated text: /healthz comes from a remote server, so its fields are never trusted as markup. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Custom entries the user added, newest first. */
function customServers() {
  return customFrom(readItem(K_LIST, 'localStorage'));
}

/**
 * Copy the community servers into the player's editable list, once per SEED_VERSION. They go in `K_LIST` rather than
 * `BUILTIN_SERVERS` so a server that goes dark can be deleted for good — and the marker is what keeps it deleted
 * instead of coming back on the next launch. Bump SEED_VERSION in picker-core.js to push a new batch.
 */
function seedCommunityServers() {
  if (readItem(K_SEED, 'localStorage') === String(SEED_VERSION)) return;
  const existing = customServers();
  const add = missingSeeds(existing, COMMUNITY_SERVERS, (a) => (a.trim() ? toWsUrl(a) : ''));
  if (add.length) writeItem(K_LIST, JSON.stringify(existing.concat(add)), 'localStorage');
  writeItem(K_SEED, String(SEED_VERSION), 'localStorage');
}

/**
 * Rooms currently advertised on the virtual LAN, as picker entries. Module-level because `serverList()` (also
 * module-level, and used by tests) has to see them. Never persisted: a LAN room exists only while its host is
 * online, so writing it into `K_LIST` would leave the player with dead rows to delete by hand.
 */
let lanEntries = [];

/** Every entry the picker lists, de-duplicated on the normalised socket URL. */
export function serverList() {
  const seen = new Set();
  const out = [];
  const entries = [
    ...BUILTIN_SERVERS,
    { address: buildDefault(), label: '默认服务器', note: '' },
    ...customServers().map((e) => ({ address: e.address, label: serverName(e), note: '' })),
    ...lanEntries,
  ];
  for (const s of entries) {
    const key = keyOf(s.address);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...s, key, http: toHttpUrl(s.address) });
  }
  return out;
}

/**
 * Socket URLs to try for a typed address, best guess first. Two guesses the player cannot make from the outside:
 * the scheme (a self-hosted server on a public IP wants plain `ws://`, a TLS reverse proxy on an odd port wants
 * `wss://`) and the mount (players paste the URL of the *page* they were given, `https://host/play`, but most
 * servers only answer on the root `/ws`). See picker-core.js's orderCandidates.
 * @param {string} address
 * @returns {string[]}
 */
export function candidateWsUrls(address) {
  const raw = String(address ?? '').trim();
  if (!raw) return [];
  return orderCandidates(toWsUrl(raw), ambiguousScheme(raw));
}

/** The web (http) URL of an already-normalised socket URL. */
const httpUrlOf = (wsUrl) => wsUrl.replace(/^ws/, 'http').replace(/\/ws$/, '');

/**
 * One attempt: confirms hello/welcome, sends one ping for application RTT, and reads /healthz when allowed.
 * @param {string} wsUrl an address already normalised by candidateWsUrls
 * @returns {Promise<{ ok: boolean, ms: number, info?: object, online: boolean }>} `online` is proven by /healthz
 *          answering over HTTP, which is the only way to tell "wrong server" from "no server" in a browser
 */
function probeOnce(wsUrl, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let socket = null;
    let timer = null;
    let opened = false; // protocol welcome, not merely HTTP 101
    let handshakeFailed = false;
    let pingSent = null;
    let rttMs = null;
    let pongTimer = null;
    let welcomeApp = '';
    let timedOut = false;
    let settled = false;
    let healthDone = false;
    let failWait = false;
    let info;
    let online = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pongTimer) clearTimeout(pongTimer);
      try { socket?.close(); } catch { /* already closed */ }
      resolve({ ok: opened, ms: Date.now() - started, rttMs, info, online, timedOut });
    };

    // A failed socket is only reported once /healthz has had its say: an instant 403/503 handshake would otherwise
    // always beat the fetch, and '对方在线，但 /ws 没通' is the part the player can act on.
    const fail = () => { handshakeFailed = true; if (healthDone) finish(); else failWait = true; };
    const healthSettled = () => { healthDone = true; if (failWait || (opened && rttMs !== null)) finish(); };

    timer = setTimeout(() => { timedOut = !opened && !handshakeFailed; finish(); }, timeoutMs);

    const health = `${httpUrlOf(wsUrl)}/healthz`;
    // Best effort, never blocking: /healthz usually has no CORS headers, and that is the server's business.
    fetch(health, { cache: 'no-store' })
      .then((r) => {
        online = true;
        return r.json();
      })
      .then((json) => {
        info = { ...(json && typeof json === 'object' && !Array.isArray(json) ? json : {}), ...(welcomeApp ? { app: welcomeApp } : {}) };
        healthSettled();
      }, () => {
        // No CORS (or an HTML error body): ask again without it. A `no-cors` fetch resolves for *any* HTTP status, so
        // a resolve proves the host is alive; a rejection proves nothing (Android blocks plain http as mixed content).
        fetch(health, { mode: 'no-cors', cache: 'no-store' })
          .then(() => { online = true; }, () => { /* nothing learned */ })
          .then(healthSettled, healthSettled);
      });

    try {
      socket = new WebSocket(wsUrl);
    } catch {
      fail();
      return;
    }
    socket.onopen = () => {
      try {
        // A proxy's HTTP 101 is not proof that this is a usable game server.
        // Server protocol requires a numeric rid and a name no longer than 12.
        socket.send(JSON.stringify({ t: 'hello', rid: 1, name: '探针', version: 1 }));
      } catch { fail(); }
    };
    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'welcome' && !opened) {
        opened = true;
        online = true;
        if (typeof msg.app === 'string' && msg.app.trim()) { welcomeApp = msg.app.trim(); info = { ...(info || {}), app: welcomeApp }; }
        pingSent = Date.now();
        try {
          socket.send(JSON.stringify({ t: 'ping', c: pingSent }));
          pongTimer = setTimeout(finish, Math.min(PONG_WAIT_MS, timeoutMs));
        } catch { finish(); }
      } else if (msg.t === 'pong' && opened && pingSent !== null && msg.c === pingSent) {
        rttMs = Math.max(0, Date.now() - pingSent);
        if (healthDone || info?.app) finish();
        else { clearTimeout(pongTimer); pongTimer = setTimeout(finish, 350); }
      } else if (!opened && (msg.t === 'error' || msg.t === 'helloError')) {
        fail();
      }
    };
    socket.onerror = () => { if (!opened) fail(); else finish(); };
    socket.onclose = () => { if (!opened) fail(); else finish(); };
  });
}

/**
 * Is `address` a live game server? Checks the channel the game itself will use, so a green row means the player can
 * actually get in. Every candidate (scheme × mount) is tried at once — one handshake each, so covering more guesses
 * costs no waiting — and only the best guess is retried when all of them fail (a slow handshake must not turn into a
 * misleading "无法连接").
 * @param {string} address
 * @param {number} [timeoutMs] per attempt
 * @param {number} [attempts] retries of the first candidate
 * @returns {Promise<{ ok: boolean, ms: number, info?: object, online: boolean, hadPath: boolean, url?: string }>}
 *          `url` is the socket URL that worked
 */
export async function probe(address, timeoutMs = PROBE_TIMEOUT_MS, attempts = 2) {
  const candidates = candidateWsUrls(address);
  const hadPath = pathOf(address) !== '';
  if (!candidates.length) return { ok: false, ms: 0, online: false, hadPath };
  // A single successful WebSocket proves reachability. Do not wait for a
  // dead alternative mount to time out before reporting success.
  const raced = new Array(candidates.length);
  let remaining = candidates.length;
  const good = await new Promise((resolve) => {
    candidates.forEach((url, i) => {
      void probeOnce(url, timeoutMs).then((r) => {
        raced[i] = { ...r, url };
        if (r.ok) resolve(raced[i]);
        else if (--remaining === 0) resolve(null);
      });
    });
  });
  if (good) return { ...good, hadPath };
  const failed = raced.filter(Boolean);
  if (attempts > 1) {
    const again = { ...(await probeOnce(candidates[0], timeoutMs)), url: candidates[0] };
    if (again.ok) return { ...again, hadPath };
    return {
      ok: false, ms: again.ms, info: again.info ?? failed.find((r) => r.info)?.info,
      online: again.online || failed.some((r) => r.online), timedOut: again.timedOut || failed.some((r) => r.timedOut),
      hadPath,
    };
  }
  return {
    ok: false, ms: Math.max(0, ...failed.map((r) => r.ms)), info: failed.find((r) => r.info)?.info,
    online: failed.some((r) => r.online), timedOut: failed.some((r) => r.timedOut), hadPath,
  };
}

const CSS = `
.sp-pick{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:#0c0f0e;color:#c3cbc7;font-family:"Noto Sans SC","Oxanium",system-ui,sans-serif;padding:16px;
  overflow:auto;-webkit-user-select:none;user-select:none}
.sp-pick__box{width:min(680px,100%);display:flex;flex-direction:column;gap:14px}
.sp-pick__title{font-size:20px;letter-spacing:.14em;color:#e8f1ee;font-weight:700}
.sp-pick__sub{font-size:12px;color:#7d8a86;margin-top:4px;letter-spacing:.1em}
.sp-pick__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.sp-pick__list{display:flex;flex-direction:column;gap:8px}
.sp-pick__card{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #26302d;border-radius:10px;
  background:#121715;cursor:pointer;min-height:56px}
.sp-pick__card:hover{border-color:#3b4a45}
.sp-pick__card.is-sel{border-color:#4ed8af;box-shadow:0 0 0 1px #4ed8af inset}
.sp-pick__dot{width:9px;height:9px;border-radius:50%;background:#5a6663;flex:0 0 auto}
.sp-pick__dot.is-ok{background:#4ed8af;box-shadow:0 0 8px #4ed8af88}
.sp-pick__dot.is-bad{background:#e0635f}
.sp-pick__name{font-size:15px;color:#e8f1ee;font-weight:600}
.sp-pick__addr{font-size:12px;color:#7d8a86;margin-top:2px;word-break:break-all}
.sp-pick__state{font-size:12px;color:#7d8a86;margin-left:auto;text-align:right;white-space:nowrap}
.sp-pick__del{color:#7d8a86;background:none;border:0;font-size:16px;cursor:pointer;padding:0 4px}
.sp-pick__del:hover{color:#e0635f}
.sp-pick__row{display:flex;gap:8px;flex-wrap:wrap}
.sp-pick__in{flex:1 1 auto;min-width:0;padding:11px 12px;border-radius:8px;border:1px solid #26302d;background:#0f1413;
  color:#e8f1ee;font-size:14px;font-family:inherit}
.sp-pick__in:focus{outline:0;border-color:#4ed8af}
.sp-pick__btn{padding:11px 16px;border-radius:8px;border:1px solid #26302d;background:#161d1b;color:#c3cbc7;
  font-size:14px;font-family:inherit;cursor:pointer;white-space:nowrap}
.sp-pick__btn:hover{border-color:#3b4a45}
.sp-pick__go{padding:14px;border-radius:10px;border:1px solid #4ed8af;background:#4ed8af;color:#08110e;
  font-size:16px;font-weight:700;font-family:inherit;cursor:pointer;letter-spacing:.08em}
.sp-pick__go:disabled{opacity:.5;cursor:default}
.sp-pick__opt{display:flex;align-items:center;gap:8px;font-size:13px;color:#98a5a1}
.sp-pick__hint{font-size:12px;color:#697571;line-height:1.6;min-height:1.2em}
.sp-pick__menu{display:flex;flex-direction:column;gap:12px}
.sp-pick__mode{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:22px 20px;border:1px solid #26302d;
  border-radius:12px;background:#121715;color:#e8f1ee;font-family:inherit;cursor:pointer;text-align:left}
.sp-pick__mode:hover{border-color:#3b4a45}
.sp-pick__mode.is-primary:hover{border-color:#4ed8af;box-shadow:0 0 0 1px #4ed8af inset}
.sp-pick__mode-name{font-size:22px;font-weight:700;letter-spacing:.1em}
.sp-pick__mode-note{font-size:12px;color:#7d8a86;letter-spacing:.06em}
.sp-pick__form{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid #26302d;border-radius:10px;background:#0f1413}
.sp-pick__field{display:flex;align-items:center;gap:10px}
.sp-pick__field>label{flex:0 0 56px;font-size:12px;color:#7d8a86}
.sp-pick__formrow{display:flex;gap:8px;justify-content:flex-end}
.sp-pick__btn.is-go{border-color:#2f6f5c;color:#d8f5ec}
.sp-pick__headbtns{display:flex;gap:8px}
.sp-pick__note{font-size:11px;color:#5f6b67;line-height:1.5}
@media (max-height:520px),(max-width:560px){
  .sp-pick{padding:10px;align-items:flex-start}
  .sp-pick__box{gap:10px}
  .sp-pick__title{font-size:16px}
  .sp-pick__sub{font-size:10px;margin-top:2px}
  .sp-pick__menu{gap:8px}
  .sp-pick__mode{padding:12px 14px;border-radius:10px;gap:3px}
  .sp-pick__mode-name{font-size:16px}
  .sp-pick__mode-note{font-size:10px}
  .sp-pick__list{gap:6px}
  .sp-pick__card{min-height:42px;padding:8px 10px;gap:8px;border-radius:8px}
  .sp-pick__name{font-size:13px}
  .sp-pick__addr,.sp-pick__state,.sp-pick__opt,.sp-pick__hint,.sp-pick__note{font-size:11px}
  .sp-pick__in{padding:8px 10px;font-size:12px}
  .sp-pick__btn{padding:8px 11px;font-size:12px}
  .sp-pick__go{padding:10px;font-size:14px}
  .sp-pick__form{padding:10px;gap:6px;border-radius:8px}
  .sp-pick__field>label{flex:0 0 40px;font-size:11px}
}
`;

/** Render the picker into the page. */
function mount() {
  const style = document.createElement('style');
  style.textContent = CSS;
  const root = document.createElement('div');
  root.className = 'sp-pick';
  document.head.appendChild(style);
  document.body.appendChild(root);

  const saved = readItem(K_SERVER, 'localStorage');
  let screen = 'home';   // 'home' (mode menu) | 'multi' (server list)
  let form = null;       // null | 'add' | 'edit' (name + address) | 'direct' (address only)
  let editingKey = null; // form === 'edit': the stored server being edited (its normalised key)
  let hintText = '';
  let list = [];
  let selected = null;
  const states = new Map();
  let refreshEpoch = 0;

  /** The stored entry behind a key, when it is a user-added (editable) server. */
  const customEntryOf = (key) => customServers().find((e) => toWsUrl(e.address) === key) || null;

  /** The remembered/"go straight in" checkbox — Android has no F2, so it never gets one. */
  const autoRow = isAndroid()
    ? ''
    : '<label class="sp-pick__opt"><input type="checkbox" id="sp-auto"> 记住并直接进入（下次启动不再询问，F2 可重新选择）</label>';

  const HOME_HTML = `
    <div class="sp-pick__box">
      <div>
        <div class="sp-pick__title">选择模式</div>
        <div class="sp-pick__sub">STRONGHOLD PROTOCOL · GAME MODE</div>
      </div>
      <div class="sp-pick__menu">
        <button class="sp-pick__mode" id="sp-solo">
          <span class="sp-pick__mode-name">单人游戏</span>
          <span class="sp-pick__mode-note">离线模拟 · 开发中</span>
        </button>
        <button class="sp-pick__mode is-primary" id="sp-multi">
          <span class="sp-pick__mode-name">多人游戏</span>
          <span class="sp-pick__mode-note">连接到服务器 · 添加服务器 / 直接连接</span>
        </button>
      </div>
      <div class="sp-pick__hint" id="sp-hint"></div>
    </div>`;

  const MULTI_HTML = `
    <div class="sp-pick__box">
      <div class="sp-pick__head">
        <div>
          <div class="sp-pick__title">多人游戏</div>
          <div class="sp-pick__sub">STRONGHOLD PROTOCOL · MULTIPLAYER</div>
        </div>
        <div class="sp-pick__headbtns">
          <button class="sp-pick__btn" id="sp-selftest" title="立绘或模型加载不上时，自检是哪一层（会离开当前连接）">立绘自检</button>
          <button class="sp-pick__btn" id="sp-refresh" title="重新测试各服务器延迟">刷新</button>
          <button class="sp-pick__btn" id="sp-back">返回</button>
        </div>
      </div>
      <div class="sp-pick__list" id="sp-list"></div>
      <div id="sp-form"></div>
      <div class="sp-pick__row">
        <button class="sp-pick__btn" id="sp-add">添加服务器</button>
        <button class="sp-pick__btn" id="sp-direct">直接连接</button>
        <button class="sp-pick__btn" id="sp-edit" title="编辑选中的自建服务器">编辑</button>
      </div>
      ${autoRow}
      <button class="sp-pick__go" id="sp-go">进 入 游 戏</button>
      <div class="sp-pick__hint" id="sp-hint"></div>
    </div>`;

  function setHint(text) {
    hintText = text || '';
    const el = root.querySelector('#sp-hint');
    if (el) el.textContent = hintText;
  }

  /** Repaint the server list onto the current (multi) screen. */
  function renderList() {
    const listEl = root.querySelector('#sp-list');
    if (!listEl) return;
    const goEl = root.querySelector('#sp-go');
    const editEl = root.querySelector('#sp-edit');
    listEl.innerHTML = '';
    // The virtual-LAN card sits above the server list: it is the one row that is not a server, and for a player who
    // downloaded the exe it is the way to reach friends' rooms without typing an address. Hidden entirely when this
    // build has no shell (P1) so the browser build looks untouched.
    if (lanStatus) {
      const action = lanActionLabel(lanStatus);
      const dot = lanStatus.state === 'up' ? 'is-ok' : (lanStatus.state === 'error' ? 'is-bad' : '');
      const lanCard = document.createElement('div');
      lanCard.className = 'sp-pick__card sp-pick__card--lan';
      lanCard.innerHTML = `
        <div class="sp-pick__dot ${dot}"></div>
        <div style="min-width:0">
          <div class="sp-pick__name">联机 · 虚拟局域网</div>
          <div class="sp-pick__addr">${esc(lanSummary(lanStatus, lanEntries.length))}${lanStatus.hint ? ` · ${esc(lanStatus.hint)}` : ''}</div>
        </div>
        <div class="sp-pick__state">${esc(action)}</div>`;
      if (action) lanCard.addEventListener('click', () => { void toggleLan(); });
      listEl.appendChild(lanCard);
    }
    for (const s of list) {
      const st = states.get(s.key) || {};
      const custom = customEntryOf(s.key) != null;
      const state = st.pending ? '检测中…' : st.ok ? (Number.isFinite(st.rttMs) ? `可连接 · RTT ${st.rttMs}ms` : '协议可用 · RTT 待确认')
        : st.failed ? (st.timedOut ? '探测超时 · 可重试' : st.online ? '主机在线 · WS 未通' : '暂时无法连接') : '';
      // The reason goes on the address line, which wraps; the status column stays one short word.
      const reason = st.pending || st.ok ? '' : probeReason(st);
      const info = st.info
        ? [typeof st.info.app === 'string' && st.info.app ? `v${st.info.app.replace(/^v(?=\d)/, '')}` : '', st.info.humans != null ? `在线 ${st.info.humans}` : '', st.info.rooms != null ? `房间 ${st.info.rooms}` : '']
          .filter(Boolean).join(' · ')
        : '';
      const sub = [info || s.note, st.ok ? `协议确认 ${st.ms}ms` : '', reason].filter(Boolean).join(' · ');
      const card = document.createElement('div');
      card.className = `sp-pick__card${s.key === selected ? ' is-sel' : ''}`;
      card.innerHTML = `
        <div class="sp-pick__dot ${st.pending || !state ? '' : st.ok ? 'is-ok' : 'is-bad'}"></div>
        <div style="min-width:0">
          <div class="sp-pick__name">${esc(s.label)}${s.key === keyOf(buildDefault()) ? ' · 默认' : ''}</div>
          <div class="sp-pick__addr">${esc(s.http.replace(/^https?:\/\//, ''))}${sub ? ` · ${esc(sub)}` : ''}</div>
        </div>
        <div class="sp-pick__state">${esc(state)}</div>
        ${custom ? '<button class="sp-pick__del" title="删除">×</button>' : ''}`;
      card.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('sp-pick__del')) {
          writeItem(K_LIST, JSON.stringify(customServers().filter((e) => toWsUrl(e.address) !== s.key)), 'localStorage');
          // Remember it too: a runtime /servers.json list may offer this address again on the next launch, and a
          // deletion the player has to redo every time is not a deletion. (Static seeding keeps using K_SEED.)
          writeItem(K_DISMISSED, addDismissed(readItem(K_DISMISSED, 'localStorage'), s.key), 'localStorage');
          loadList();
          return;
        }
        selected = s.key;
        renderList();
      });
      listEl.appendChild(card);
    }
    if (goEl) goEl.disabled = !selected;
    // Only a user-added server can be edited (the built-in and the packaged default are fixed).
    if (editEl) editEl.disabled = form !== null || !customEntryOf(selected);
  }

  /** Probe at most two servers simultaneously and discard obsolete scan results. */
  function queueRefreshAll() {
    const epoch = ++refreshEpoch;
    states.clear();
    const entries = [...list];
    if (selected) entries.sort((a, b) => Number(b.key === selected) - Number(a.key === selected));
    for (const entry of entries) states.set(entry.key, { pending: true });
    renderList();
    void forEachLimited(entries, MAX_SERVER_PROBES, async (entry) => {
      if (epoch !== refreshEpoch) return;
      let result;
      try {
        result = await probe(entry.address);
      } catch {
        result = { ok: false, ms: 0, online: false, hadPath: pathOf(entry.address) !== '' };
      }
      if (epoch !== refreshEpoch) return;
      states.set(entry.key, {
        ok: result.ok, ms: result.ms, rttMs: result.rttMs, info: result.info, failed: !result.ok,
        url: result.url, online: result.online, timedOut: result.timedOut, hadPath: result.hadPath,
      });
      renderList();
      if (!result.ok && entry.key === selected) {
        setHint(`检测 ${entry.http} 未成功：${probeReason(result) || '本次连接尝试失败'}。可稍后刷新，或直接尝试进入。`);
      }
    });
  }

  /** Refresh without flooding all discovered servers with simultaneous sockets. */
  function refreshAll() {
    setHint('正在检测游戏协议与应用层 RTT（短样本；实际对局延迟仍可能波动）…');
    queueRefreshAll();
  }

  function loadList(keepKey) {
    list = serverList();
    const savedKey = keyOf(saved);
    selected = (keepKey && list.some((s) => s.key === keepKey)) ? keepKey
      : (savedKey && list.some((s) => s.key === savedKey)) ? savedKey
        : keyOf(buildDefault());
    if (!list.some((s) => s.key === selected)) selected = list[0]?.key ?? null;
    states.clear();
    renderList();
    queueRefreshAll();
    discoverServers();
    refreshLanOnce();
  }

  /** Guards against discovering more than once per launch (the list is re-rendered on every keystroke-sized change). */
  let discoveryStarted = false;

  /**
   * The virtual-LAN channel (shell/lanRooms.js). One probe per launch tells us whether this build has a shell that
   * can run the tunnel; if it does, the card at the top of the list shows its state and, once the tunnel is up, the
   * rooms the LAN directory is advertising. Deliberately silent on failure: a browser build must look exactly as it
   * did before, and a dead directory must not add a row the player cannot act on.
   */
  let lanStatus = null;

  /** One LAN probe per launch: the card must not re-fetch on every keystroke-sized re-render. */
  let lanStarted = false;

  function refreshLanOnce() {
    if (lanStarted) return;
    lanStarted = true;
    refreshLan()
      .then(() => { loadList(); queueRefreshAll(); })
      .catch(() => { /* no shell, no LAN, no noise */ });
  }

  async function refreshLan() {
    lanStatus = await fetchLanStatus();
    if (!lanStatus) { lanEntries = []; return; } // P1: no shell in this build
    const rooms = lanStatus.state === 'up' || lanStatus.state === 'degraded' ? await fetchLanRooms(undefined, lanStatus.directoryUrl) : null;
    lanEntries = rooms ? lanEntriesFrom(rooms) : [];
  }

  /** Flip the tunnel and re-read both the status and the room list. */
  async function toggleLan() {
    const up = lanStatus?.state === 'up' || lanStatus?.state === 'degraded' || lanStatus?.state === 'starting';
    await setLanUp(!up);
    await refreshLan();
    loadList();
    queueRefreshAll();
  }

  /**
   * The second server-list channel (docs/SERVER-LIST.md): ask the server we are about to use for the servers IT
   * recommends, and append anything new to the player's own list. Deliberately fire-and-forget:
   *
   *   * it never blocks entering a game — the box is already usable, this only adds rows later;
   *   * it runs at most once per launch, never polls and never retries, so a server that just died can never turn
   *     into a several-second stall on every render;
   *   * every failure (404, no CORS, timeout, bad JSON) is one outcome — silence. Almost no server on the network
   *     implements this, and saying so in the UI would be noise;
   *   * entries the player deleted are skipped (K_DISMISSED) so this cannot resurrect them.
   */
  function discoverServers() {
    if (discoveryStarted) return;
    discoveryStarted = true;
    const base = toHttpUrl(selected || buildDefault());
    const url = serversUrl(base);
    if (!url) return;
    fetchServers(url).then((data) => {
      const picked = pickServers(data, { keyOf: (a) => toWsUrl(a) });
      if (!picked || !picked.length) return;   // null = "no answer"; [] = "the server knows no others"
      const existing = customServers();
      const add = newServerEntries(picked, existing.map((e) => toWsUrl(e.address)), parseDismissed(readItem(K_DISMISSED, 'localStorage')), (a) => toWsUrl(a));
      if (!add.length) return;
      // Append, never replace: the seeding's promise (and the player's own edits) stay untouched.
      writeItem(K_LIST, JSON.stringify(existing.concat(add)), 'localStorage');
      list = serverList();
      renderList();
      for (const s of add) {
        const found = list.find((e) => e.key === keyOf(s.address));
        if (found) refresh(found);
      }
    });
  }

  /**
   * Remember the choice and (re)boot into it — the only writer of sp.shell.*.
   * The address stored is the socket URL that actually answered, not what the player typed: the game itself has no
   * candidate fallback (`net.js` takes one URL), so `https://host/play` must become `ws://host/ws` before the reload.
   */
  async function connected(entry) {
    if (!entry?.address) return;
    // Prefer the URL that actually answered the probe: a typed `host:port` may only be reachable on one scheme.
    const st = entry.key ? states.get(entry.key) : null;
    let address = (st?.ok && st.url) ? st.url : bootUrlOf(entry.address);
    if (!st?.ok) {
      // Failed rows can be transient. Reprobe on join to detect the truly
      // working WS scheme/mount instead of blindly using the guessed one.
      setHint(`正在连接 ${toHttpUrl(entry.address)} …`);
      const r = await probe(entry.address);
      if (r.ok && r.url) address = r.url;
      else setHint(`连不上 ${toHttpUrl(entry.address)}：${probeReason(r) || '本次连接尝试失败'}。仍然尝试进入，请稍候…`);
    }
    const key = keyOf(address);
    if (!key) return;
    writeItem(K_SERVER, address, 'localStorage');
    const autoEl = root.querySelector('#sp-auto');
    if (autoEl) writeItem(K_AUTOSTART, autoEl.checked ? '1' : '0', 'localStorage');
    writeItem(K_CHOSEN, '1', 'sessionStorage');
    // Already the server the game booted with (it reads the same localStorage entry): just close the overlay.
    if (key === bootTarget) {
      hidePicker();
      return;
    }
    globalThis.__SP_SERVER__ = address;
    globalThis.location.reload();
  }

  function enterGame() {
    const entry = list.find((s) => s.key === selected);
    if (entry) connected(entry);
  }

  const ADDR_HINT = 'host、host:port、http(s)://…、ws(s)://…';
  const ADDR_NOTE = '<div class="sp-pick__note">不写协议也能用：带端口的地址按 ws:// 与 wss:// 各试一次，公网域名默认 wss://。粘贴网页地址（如 https://host/play）也会顺带试它的根路径 /ws。</div>';

  /** The add / edit / direct-connect form under the list (two fields for a saved server, one for a quick connect). */
  function renderForm() {
    const host = root.querySelector('#sp-form');
    if (!host) return;
    host.innerHTML = '';
    if (!form) { renderList(); return; }
    const editing = form === 'edit' ? customEntryOf(editingKey) : null;
    const wrap = document.createElement('div');
    wrap.className = 'sp-pick__form';
    wrap.innerHTML = form === 'direct'
      ? `<div class="sp-pick__field"><label for="sp-addr">地址</label>
           <input class="sp-pick__in" id="sp-addr" placeholder="${ADDR_HINT}" spellcheck="false"></div>
         ${ADDR_NOTE}
         <div class="sp-pick__formrow">
           <button class="sp-pick__btn" id="sp-cancel">取消</button>
           <button class="sp-pick__btn is-go" id="sp-ok">连接</button></div>`
      : `<div class="sp-pick__field"><label for="sp-name">名称</label>
           <input class="sp-pick__in" id="sp-name" maxlength="${NAME_MAX}" placeholder="我的服务器" spellcheck="false"></div>
         <div class="sp-pick__field"><label for="sp-addr">地址</label>
           <input class="sp-pick__in" id="sp-addr" placeholder="${ADDR_HINT}" spellcheck="false"></div>
         ${ADDR_NOTE}
         <div class="sp-pick__formrow">
           <button class="sp-pick__btn" id="sp-cancel">取消</button>
           <button class="sp-pick__btn is-go" id="sp-ok">${form === 'edit' ? '保存' : '完成'}</button></div>`;
    host.appendChild(wrap);

    const nameEl = wrap.querySelector('#sp-name');
    const addrEl = wrap.querySelector('#sp-addr');
    if (editing) {
      if (nameEl) nameEl.value = editing.name || '';
      addrEl.value = editing.address;
    }
    const close = () => { form = null; editingKey = null; setHint(''); renderForm(); };
    wrap.querySelector('#sp-cancel').addEventListener('click', close);
    wrap.querySelector('#sp-ok').addEventListener('click', () => {
      const raw = addrEl.value.trim();
      const bad = addressError(raw);
      if (bad) { setHint(bad); return; }
      if (form === 'direct') { connected({ address: raw }); return; }
      const key = toWsUrl(raw);
      // An edit replaces the old entry: drop both the previous key and any entry the new address collides with.
      const drop = form === 'edit' ? new Set([editingKey, key]) : new Set([key]);
      const rest = customServers().filter((e) => !drop.has(toWsUrl(e.address)));
      rest.unshift({ name: cleanName(nameEl.value), address: raw });
      writeItem(K_LIST, JSON.stringify(rest), 'localStorage');
      form = null;
      editingKey = null;
      setHint('');
      renderForm();
      loadList(key);
    });
    addrEl.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') wrap.querySelector('#sp-ok').click(); });
    (nameEl || addrEl).focus();
    renderList();
  }

  /** Build the current screen's skeleton and wire it up. */
  function layout() {
    root.innerHTML = screen === 'home' ? HOME_HTML : MULTI_HTML;
    if (screen === 'home') {
      root.querySelector('#sp-solo').addEventListener('click', () => setHint('单人模式还没做：游戏的大厅 / 房间 / 模拟都在服务端，暂时不能脱离服务器运行，敬请期待。'));
      root.querySelector('#sp-multi').addEventListener('click', () => { screen = 'multi'; form = null; setHint(''); layout(); loadList(); });
    } else {
      root.querySelector('#sp-back').addEventListener('click', () => { screen = 'home'; form = null; editingKey = null; setHint(''); layout(); });
      root.querySelector('#sp-refresh').addEventListener('click', refreshAll);
      // 自检页是 payload 里的 `dev/spine-probe.html`（游戏仓），三端都发得出去；用绝对路径而不是拼 origin，
      // 因为 Capacitor 的 origin 是 `capacitor://localhost` / `https://localhost`，桌面壳是 127.0.0.1 的某个端口。
      // 这一步会离开当前连接，所以按钮标题里写明白了。
      root.querySelector('#sp-selftest')?.addEventListener('click', () => { location.href = '/dev/spine-probe.html'; });
      root.querySelector('#sp-add').addEventListener('click', () => { const on = form !== 'add'; form = on ? 'add' : null; editingKey = null; setHint(''); renderForm(); });
      root.querySelector('#sp-direct').addEventListener('click', () => { const on = form !== 'direct'; form = on ? 'direct' : null; editingKey = null; setHint(''); renderForm(); });
      root.querySelector('#sp-edit').addEventListener('click', () => {
        if (!customEntryOf(selected)) return;
        form = 'edit';
        editingKey = selected;
        setHint('');
        renderForm();
      });
      root.querySelector('#sp-go').addEventListener('click', enterGame);
      const autoEl = root.querySelector('#sp-auto');
      if (autoEl) autoEl.checked = readItem(K_AUTOSTART, 'localStorage') !== '0';
      renderForm();
    }
    const hintEl = root.querySelector('#sp-hint');
    if (hintEl) hintEl.textContent = hintText;
  }

  // Esc: close the form, then step back to the mode menu.
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (form) { form = null; editingKey = null; setHint(''); renderForm(); }
    else if (screen === 'multi') { screen = 'home'; setHint(''); layout(); }
  });

  // The game boots underneath this overlay: hide its boot screen so nothing flashes through.
  const boot = document.getElementById('boot');
  const bootVisibility = boot?.style.visibility;
  if (boot) boot.style.visibility = 'hidden';

  layout();
  return {
    root,
    destroy() {
      if (boot) boot.style.visibility = bootVisibility || '';
      root.remove();
      style.remove();
    },
  };
}

let current = null;

/** Show the picker (desktop: F2 or --choose-server). */
export function showPicker() {
  if (!current) current = mount();
}

/** Hide it again (tests, programmatic flows). */
export function hidePicker() {
  current?.destroy();
  current = null;
}

export function pickerVisible() {
  return !!current;
}

globalThis.__SP_SHELL_PICKER__ = {
  show: showPicker,
  hide: hidePicker,
  visible: pickerVisible,
  servers: serverList,
  candidates: candidateWsUrls,
  bootUrlOf,
  probe,
};

// ---- launch decision --------------------------------------------------------------------------------------------
const savedAddress = readItem(K_SERVER, 'localStorage');
// 老版本可能把带路径的地址（`https://host/play`）原样存过 —— 那是玩家看到 "Not Found" 的另一条来路，
// 所以进游戏前统一成根挂载的 socket URL。
if (savedAddress) globalThis.__SP_SERVER__ = bootUrlOf(savedAddress) || savedAddress;
/** The server the game is booting with: public/js/net.js reads __SP_SERVER__ when it opens the socket. */
const bootTarget = keyOf(globalThis.__SP_SERVER__);

const forced = new URLSearchParams(globalThis.location?.search || '').get('pick') === '1';
const chosenThisSession = readItem(K_CHOSEN, 'sessionStorage') === '1';
const autostart = autostartOn(readItem(K_AUTOSTART, 'localStorage'), isAndroid());
// Seeding runs even when the overlay stays hidden: F2 has to find the same list a first launch would have shown.
seedCommunityServers();
if (shouldShowPicker({ forced, chosenThisSession, savedAddress, autostart })) showPicker();

/**
 * F2 = "换个服务器"，F11 = 全屏，都在页面里听。Electron 壳本来就在原生层拦了这两个（`desktop/main.mjs` 的
 * `before-input-event` + `preventDefault()`），所以那边根本不会走到这一行；网页版两者都有浏览器自己的 F11；
 * 而 **Tauri 壳没有任何原生快捷键** —— 玩家按 F11 什么都不会发生。放在这里就三端同一份实现。
 * `showPicker()` 自身是幂等的（已经开着就什么都不做），所以即便哪天两个处理器同时收到也不会叠两层。
 *
 * 全屏只走壳，不走 `requestFullscreen()`：HTML5 全屏在 WebView2 里只铺满客户区，标题栏和任务栏都还在，
 * 而 Electron 那边的 `setFullScreen()` 是真全屏 —— 两边按 F11 得到不同的东西比两边都没有更糟。壳这一侧是
 * `tauri/src-tauri/src/server.rs` 的 `POST /__shell__/fullscreen`（同一个进程里的静态服务直接把动作递给窗口），
 * 所以端口挪到哪个也一样能用，而且只开放这一个动作。
 * `__SP_F11_STATE__` 是给 CI 的开动探针读的：这一串状态能分辨"根本没按键传来""页面不在壳里""命令发了但壳没答"
 * 三种不同的"按了没反应"。
 */
globalThis.__SP_F11_STATE__ = 'idle';
globalThis.addEventListener?.('keydown', (ev) => {
  if (isFullscreenHotkey(ev.key, ev.repeat, ev)) {
    const url = shellFullscreenUrl(globalThis.location?.hostname);
    if (!url) {
      globalThis.__SP_F11_STATE__ = 'no-shell';
      return;
    }
    ev.preventDefault();
    globalThis.__SP_F11_STATE__ = 'sending';
    fetch(url, { method: 'POST', cache: 'no-store' })
      .then((res) => { globalThis.__SP_F11_STATE__ = `sent:${res.status}`; })
      .catch((e) => { globalThis.__SP_F11_STATE__ = `error:${(e && (e.message || String(e))) || '未知'}`.slice(0, 160); });
    return;
  }
  if (!isPickerHotkey(ev.key, ev.repeat, ev)) return;
  ev.preventDefault();
  showPicker();
});
