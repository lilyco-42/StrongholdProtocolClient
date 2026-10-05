// Pure rules behind the shell server picker (shell/picker.js): when to show it, which addresses to accept, what a
// stored preference means. No DOM, no storage, no imports — so test/picker.test.js can pin the behaviour under
// plain Node. The assembler copies this next to the picker as /js/shell/picker-core.js.

/** localStorage keys (the picker is the only writer). */
export const K_SERVER = 'sp.shell.server';       // last chosen address
export const K_AUTOSTART = 'sp.shell.autostart'; // '1' = skip the picker next launch, '0' = always show
export const K_LIST = 'sp.shell.list';           // user-added servers: JSON [{ name, address }]
export const K_CHOSEN = 'sp.shell.chosen';       // sessionStorage: already entered once in this session
export const K_SEED = 'sp.shell.seed';           // which COMMUNITY_SERVERS batch this install already received

/** Longest stored server name (the picker's "add server" field is capped to this). */
export const NAME_MAX = 32;

/**
 * The built-in entry: a server the player runs themselves (`npm start` in the game repo). The official remote
 * server is gone; the address the payload was built for (runtime-config.js) is added by the picker itself.
 */
export const BUILTIN_SERVERS = Object.freeze([
  { address: 'localhost:3000', label: '本机 / 局域网', note: '自己开的服务器' },
]);

/** Bump when COMMUNITY_SERVERS gains an entry existing installs should also get (a deleted one stays deleted). */
export const SEED_VERSION = 1;

/**
 * Servers run by other people, measured with the shipped picker code on 2026-10-05 (all five opened a `/ws`
 * handshake; `ark-proto.stardust.matce.cn` answers HTTP but has no game service on `/ws`, and
 * `xymx1234.github.io/stronghold-standalone/` is a static page, not a server — neither is listed here).
 *
 * They are *seeded into the editable list* (`K_LIST`), not added to `BUILTIN_SERVERS`: a server that goes dark must
 * be something the player can delete for good, and a built-in row cannot be deleted or edited. Addresses below are
 * pasted as-is by design — the picker tries the typed path *and* the root mount, and three of these five only answer
 * on the root one.
 */
export const COMMUNITY_SERVERS = Object.freeze([
  { name: '网友服 · misyra', address: 'https://game.misyra.com/play' },
  { name: '网友服 · rainya', address: 'https://game.rainya.me/play' },
  { name: '网友服 · rainya:10166', address: 'https://sp.rainya.me:10166/play' },
  { name: '网友服 · linxia', address: 'https://wei.linxia.dev/' },
  { name: '网友服 · xiaolubao', address: 'https://game.xiaolubao.com/' },
]);

/**
 * The community entries this list does not have yet. `keyOfAddress` decides what counts as the same server —
 * picker.js passes `js/net.js`'s `toWsUrl`, so an address the player already typed by hand (`host`, `https://host/…`)
 * never gets a second copy of, while the picker's own `serverList()` additionally de-duplicates on the normalised
 * socket URL when it renders.
 * @param {{ address: string }[]} existing
 * @param {{ name: string, address: string }[]} seed
 * @param {(address: string) => string} [keyOfAddress]
 * @returns {{ name: string, address: string }[]}
 */
export function missingSeeds(existing, seed, keyOfAddress) {
  const key = keyOfAddress ?? ((a) => String(a ?? '').trim().toLowerCase());
  const have = new Set((existing ?? []).map((e) => key(String(e?.address ?? ''))).filter(Boolean));
  return (seed ?? []).filter((e) => {
    const address = String(e?.address ?? '').trim();
    return address && !have.has(key(address));
  });
}

/** Android WebView (Capacitor) — no F2 there, so the picker is the only way to switch servers. */
export function isAndroidUA(ua) {
  return /Android/i.test(String(ua ?? ''));
}

/**
 * Is the "remember and go straight in" preference on? Unstored defaults to on for desktop shells (they can reopen
 * the picker with F2 / --choose-server) and off on Android.
 * @param {string|null|undefined} setting stored value ('1' | '0' | null when never set)
 * @param {boolean} android
 */
export function autostartOn(setting, android) {
  return setting === null || setting === undefined ? !android : setting !== '0';
}

/**
 * Should the picker cover the boot screen this launch?
 * `chosenThisSession` also covers the reload that follows a choice (which keeps ?pick=1), so --choose-server shows
 * the picker once per launch instead of once per reload.
 * @param {{ forced: boolean, chosenThisSession: boolean, savedAddress: string|null, autostart: boolean }} state
 */
export function shouldShowPicker(state) {
  const { forced, chosenThisSession, savedAddress, autostart } = state || {};
  if (chosenThisSession) return false;
  return !!forced || !savedAddress || !autostart;
}

/**
 * Parse the stored custom-server list (JSON) into `{ name, address }` entries. Accepts the legacy shape too (an
 * array of bare address strings, from before the picker knew about names), so an existing install keeps its list.
 * @param {string|null|undefined} json
 * @returns {{ name: string, address: string }[]}
 */
export function customFrom(json) {
  try {
    const v = JSON.parse(json || '[]');
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const e of v) {
      if (typeof e === 'string' && e.trim()) out.push({ name: '', address: e.trim() });
      else if (e && typeof e === 'object' && typeof e.address === 'string' && e.address.trim()) {
        out.push({ name: typeof e.name === 'string' ? e.name.trim() : '', address: e.address.trim() });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** What to show for a saved server: the typed name, falling back to its address when the name was left blank. */
export function serverName(entry) {
  const name = String(entry?.name ?? '').trim();
  return name || String(entry?.address ?? '').trim();
}

/** Normalise a typed server name for storage (trimmed, capped to NAME_MAX). */
export function cleanName(raw) {
  return String(raw ?? '').trim().slice(0, NAME_MAX);
}

/**
 * Is the ws/wss guess for this typed address genuinely ambiguous? A scheme-less address with an explicit port is
 * the case the player cannot be expected to get right (a self-hosted server on a public IP wants plain `ws://`,
 * a TLS reverse proxy on an odd port wants `wss://`), so the picker probes both. Addresses that already carry a
 * scheme, and bare host names with no port, are decided by the normalisation alone.
 * @param {string} raw
 */
export function ambiguousScheme(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /^(wss?|https?):\/\//i.test(s)) return false;
  return /^(?:\[[^\]]*\]|[^/?#:]+):\d+(?:[/?#]|$)/.test(s);
}

/**
 * Light validation of a typed address: optional scheme + host[:port] + optional path, nothing else. Normalisation
 * (ws/wss, default path) is public/js/net.js's toWsUrl; this only rejects things that are obviously not an address.
 * @returns {string|null} an error message, or null when the address looks usable
 */
export function addressError(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '请输入服务器地址。';
  if (/\s/.test(s)) return '地址里不能有空格。';
  const rest = s.replace(/^(wss?|https?):\/\//i, '');
  if (!/^[A-Za-z0-9.\-\[\]:]+(\/[A-Za-z0-9._\-/]*)?$/.test(rest)) return '地址无法识别，试试 host:port 的形式（如 192.168.1.9:3000）。';
  if (/^[.:]/.test(rest) || rest.includes('..')) return '地址无法识别，检查一下主机名。';
  return null;
}

/**
 * The path part of a typed address, without a trailing slash ('' when it is just host[:port]).
 * Players paste the URL of the *page* they were given (`https://host/play`), but a game server mounted under a
 * subpath serves its socket there too (`/play/ws`), so the picker must try both. Measured 2026-10-05 against real
 * third-party servers: some are mounted at the root, and the ones that are not fail with a bare 404 on `/ws`.
 * @param {string} raw
 * @returns {string} '' or '/play' style prefix
 */
export function pathOf(raw) {
  const rest = String(raw ?? '').trim().replace(/^(wss?|https?):\/\//i, '');
  const slash = rest.indexOf('/');
  if (slash < 0) return '';
  const p = rest.slice(slash).replace(/[?#].*$/, '').replace(/\/+$/, '');
  return p === '/' ? '' : p;
}

/** The same socket URL on the other scheme; anything that is not ws/wss comes back unchanged. */
export function otherScheme(wsUrl) {
  const s = String(wsUrl ?? '');
  if (s.startsWith('ws://')) return `wss://${s.slice('ws://'.length)}`;
  if (s.startsWith('wss://')) return `ws://${s.slice('wss://'.length)}`;
  return s;
}

/**
 * The same server mounted at the root: `wss://h:10166/play/ws` → `wss://h:10166/ws`, unchanged when it already is
 * the root one. `toWsUrl` keeps a pasted path, so without this a root-mounted server stays unreachable.
 */
export function rootWsUrl(wsUrl) {
  const s = String(wsUrl ?? '').trim();
  const m = /^(wss?:\/\/[^/]+)\/.+\/ws$/i.exec(s);
  return m ? `${m[1]}/ws` : s;
}

/**
 * Every socket URL worth trying for one address, best guess first: the typed form, its root-mounted twin, then the
 * same two on the other scheme (only when the player left the scheme out, see ambiguousScheme). At most four, and
 * `probe` fires them concurrently, so a hopeless address still answers in about one timeout.
 * @param {string} first the normalised socket URL of the typed address
 * @param {boolean} ambiguous whether both schemes should be tried
 * @returns {string[]}
 */
export function orderCandidates(first, ambiguous) {
  const out = [];
  const push = (url) => { if (url && !out.includes(url)) out.push(url); };
  push(first);
  push(rootWsUrl(first));
  if (ambiguous) for (const url of [...out]) push(otherScheme(url));
  return out;
}

/**
 * Why did /ws fail? A browser never exposes the WebSocket handshake status, so 404 vs 503 vs 403 cannot be shown —
 * but a `no-cors` fetch of /healthz resolves for *any* HTTP answer, which proves the host is alive. A rejection
 * proves nothing (an Android shell blocks plain `http://` as mixed content), so `online` is only ever set from a
 * resolve and the plain "无法连接" stays the fallback.
 * @param {{ ok?: boolean, online?: boolean, hadPath?: boolean }} r a probe result
 * @returns {string} '' when it worked or nothing was learned, otherwise one clause for the card
 */
export function probeReason({ ok, online, hadPath }) {
  if (ok || !online) return '';
  return hadPath ? '对方在线，但 /ws 与该路径下的 /ws 都没通' : '对方在线，但 /ws 没通（多半没转发到游戏服务）';
}
