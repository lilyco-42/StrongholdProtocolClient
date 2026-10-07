// Pure rules for the second server-list channel: asking a server for the servers IT recommends (GET /servers.json).
// No DOM, no storage, no imports — so test/server-list.test.js can pin the behaviour under plain Node.
// The assembler copies this next to the picker as /js/shell/serverList.js.
//
// Contract: docs/SERVER-LIST.md. The rules that shape this file:
//
//   P1 — the endpoint not existing is NORMAL. Every server on the network except our own answers 404 (or has no CORS
//        header at all, which fails the same way); that is not an error and must not surface anywhere.
//   P2 — the body is third-party data. Every entry is re-validated here with the picker's own rules; a bad entry
//        drops that entry, never the list. Nothing here is ever connected to automatically.
//   P3 — purely additive: with no server implementing it, the picker behaves exactly as it does today.
//
// This is a SECOND channel next to the compiled-in COMMUNITY_SERVERS seeding (picker.js seedCommunityServers), and the
// two are deliberately independent: the seeding's "delete it and it stays deleted" promise is carried by K_SEED, which
// only ever advances once per batch. A runtime list cannot use that marker — it may legitimately bring back an entry
// the player deleted yesterday from a batch they never saw — so deletion is recorded per address instead, in
// `dismissed`. Static seeding does NOT consult `dismissed` (its semantics stay byte-identical), and neither channel
// can resurrect an entry the other one's player removed for good.

/** The format version this client understands (docs/SERVER-LIST.md §2, §10). */
export const SERVERS_FORMAT_VERSION = 1;
/** localStorage key: the normalised address keys the player deleted, so a runtime list cannot bring them back. */
export const K_DISMISSED = 'sp.shell.dismissed';
/** How long to wait for the list before giving up. A dead server must not stall the picker. */
export const FETCH_TIMEOUT_MS = 3000;
/** Entries kept from one response. A server must not be able to push a thousand rows into the picker. */
export const MAX_ENTRIES = 50;

const NAME_MAX = 32;
const NOTE_MAX = 40;

/**
 * Is this address something the picker would accept from a human? Mirrors what picker-core's own validation allows,
 * without importing it (this module stays dependency-free so it can be tested under plain Node).
 * @param {unknown} v
 */
function usableAddress(v) {
  if (typeof v !== 'string') return false;
  const a = v.trim();
  // The picker accepts a bare `host`, `host:port`, or any ws/wss/http/https URL — the same shapes a player types.
  return a.length > 0 && a.length <= 2048 && !/\s/.test(a);
}

/**
 * Is one capability string something we know? Unknown ones are ignored, not an error (§4.1, §4.2): the table grows
 * over time and an old client must keep working against a new server.
 * @param {unknown} c
 */
function knownCap(c) {
  return typeof c === 'string' && c.length > 0 && c.length <= 32;
}

/**
 * Pick the usable entries out of a `/servers.json` response body.
 *
 * Returns `null` — meaning "treat exactly like no answer at all" — when the payload is not a list this client can
 * read: not an object, an unknown `v`, or no `servers` array. That is deliberate (§10): guessing at a shape we do not
 * know is how an old and a new client start reading each other's data wrong.
 *
 * Every unusable ENTRY is dropped without affecting the others (§2.1): the server is a third party, and one typo in
 * one row must not cost the player every other row.
 *
 * @param {unknown} data the parsed JSON body
 * @param {{ keyOf?: (address: string) => string | null }} [o] `keyOf` normalises an address for de-duplication —
 *   picker.js passes the same `toWsUrl`-based key it uses everywhere else, so an address the player already typed by
 *   hand never gets a second copy.
 * @returns {Array<{ name: string, address: string, note?: string, caps?: string[] }> | null}
 */
export function pickServers(data, o = {}) {
  const keyOf = o.keyOf || ((a) => a);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.v !== SERVERS_FORMAT_VERSION) return null;
  if (!Array.isArray(data.servers)) return null;

  const seen = new Set();
  const out = [];
  for (const raw of data.servers) {
    if (out.length >= MAX_ENTRIES) break;
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || !usableAddress(raw.address)) continue;
    const address = raw.address.trim();
    let key;
    try { key = keyOf(address); } catch { key = null; }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    /** @type {{ name: string, address: string, note?: string, caps?: string[] }} */
    const entry = { name: name.slice(0, NAME_MAX), address };
    if (typeof raw.note === 'string' && raw.note.trim()) entry.note = raw.note.trim().slice(0, NOTE_MAX);
    if (Array.isArray(raw.caps)) {
      const caps = [...new Set(raw.caps.filter(knownCap))];
      if (caps.length) entry.caps = caps;
    }
    out.push(entry);
  }
  return out;
}

/**
 * The entries to actually show: what the server sent, minus what the player deleted, minus what is already listed.
 *
 * `dismissed` is the set of normalised keys the player removed. It is what makes a runtime list follow the same rule
 * the compiled-in seeding follows by other means — "a server that goes dark must be something the player can delete
 * for good". Without it, an entry deleted today returns on the next launch, which is exactly the bug this guard
 * exists to prevent.
 *
 * @param {Array<{ name: string, address: string, note?: string, caps?: string[] }>} picked from pickServers
 * @param {string[]} existing normalised keys already in the player's list
 * @param {string[]} dismissed normalised keys the player deleted
 * @param {(address: string) => string | null} keyOf
 */
export function newServerEntries(picked, existing, dismissed, keyOf) {
  const have = new Set(existing || []);
  const gone = new Set(dismissed || []);
  /** @type {Array<{ name: string, address: string, note?: string, caps?: string[] }>} */
  const out = [];
  for (const e of picked || []) {
    let key = null;
    try { key = keyOf(e.address); } catch { key = null; }
    if (!key || have.has(key) || gone.has(key)) continue;
    have.add(key);   // also de-duplicates within the response itself
    out.push(e);
  }
  return out;
}

/**
 * Read `dismissed` out of storage text. Tolerant: anything unreadable is treated as "nothing dismissed" rather than
 * throwing (a picker that will not open is far worse than one stale entry).
 * @param {string | null} text
 */
export function parseDismissed(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v)) return [];
    return v.filter((s) => typeof s === 'string' && s.length > 0 && s.length <= 2048).slice(0, 200);
  } catch { return []; }
}

/**
 * Add one normalised key to the dismissed set text, keeping it bounded and most-recent-last.
 * @param {string | null} text
 * @param {string | null} key
 */
export function addDismissed(text, key) {
  if (!key) return JSON.stringify(parseDismissed(text));
  const list = parseDismissed(text).filter((k) => k !== key);
  list.push(key);
  // Keep the newest 200: the point is to remember what the player just deleted, not to grow forever.
  return JSON.stringify(list.slice(-200));
}

/**
 * The URL to ask for the list, given an address the player typed. Derived from the same http base the picker uses for
 * `/healthz` probes, so `https://host/play`, `host:3000` and `wss://host/ws` all resolve the same way.
 *
 * Returns null when the address yields no usable http origin. Callers treat null exactly like a failed fetch (P1).
 * @param {string} httpBase an http(s) origin, no trailing slash
 */
export function serversUrl(httpBase) {
  if (typeof httpBase !== 'string') return null;
  const base = httpBase.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base}/servers.json`;
}

/**
 * Fetch the list. NEVER throws and never rejects: a missing endpoint, no CORS header, a dead host, a slow host, bad
 * JSON — every one of those is the same outcome, `null` (P1). A caller that can distinguish them would be tempted to
 * report them, and reporting a 404 as an error would put a scary message in front of players on every server that
 * simply has not implemented this.
 *
 * @param {string} url
 * @param {{ fetchFn?: Function, timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function, AbortController?: Function }} [o]
 * @returns {Promise<unknown | null>} the parsed body, or null when there is none to be had
 */
export async function fetchServers(url, o = {}) {
  if (!url) return null;
  const fetchFn = o.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : FETCH_TIMEOUT_MS;
  const setT = o.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = o.clearTimeout || ((h) => globalThis.clearTimeout(h));
  const Abort = o.AbortController || globalThis.AbortController;
  const ctrl = typeof Abort === 'function' ? new Abort() : null;
  let timer = null;
  /** @type {Promise<never>} */
  const tooSlow = new Promise((_, reject) => {
    timer = setT(() => { try { ctrl?.abort(); } catch { /* ignore */ } reject(new Error('timeout')); }, timeoutMs);
  });
  try {
    const res = await Promise.race([fetchFn(url, ctrl ? { signal: ctrl.signal } : undefined), tooSlow]);
    if (!res || !res.ok) return null;   // 404 included, deliberately: "no list" and "no such route" are the same thing
    return await Promise.race([res.json(), tooSlow]);
  } catch {
    return null;   // network, CORS, abort, bad JSON — all one outcome
  } finally {
    if (timer != null) clearT(timer);
  }
}
