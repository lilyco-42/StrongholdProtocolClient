// The virtual-LAN channel of the server picker.
//
// The desktop shell (desktop/lan.mjs) owns an easytier-core sidecar and exposes four SAME-ORIGIN endpoints on
// the loopback server that also serves this page:
//
//   GET  /lan/status  → { state, message, hint, directoryUrl }
//   POST /lan/up      → bring the tunnel up      (Windows asks for Administrator here)
//   POST /lan/down    → tear it down
//   GET  /lan/rooms   → the LAN directory, proxied by the shell
//
// Three rules, deliberately the same ones docs/SERVER-LIST.md pins for the other discovery channel:
//
//   P1  A missing endpoint is NORMAL. The browser build, the Android WebView and iOS have no shell, so /lan/*
//       answers 404 (or nothing at all) there. That is "this build cannot do LAN play" — not an error, not a
//       retry, and the section is simply hidden.
//   P2  Addresses from the directory are re-validated here and never auto-connected. A directory that is
//       compromised, buggy or simply wrong must not be able to point a player's client at an arbitrary host.
//   P3  Purely additive: with no shell, or with the tunnel down, the picker behaves exactly as before.

export const LAN_STATUS_URL = '/lan/status';
export const LAN_ROOMS_URL = '/lan/rooms';
export const LAN_UP_URL = '/lan/up';
export const LAN_DOWN_URL = '/lan/down';

/**
 * Loopback/private IPv4 test — the same set the game's own URL helper treats as "local" (see
 * tools/ws-url.mjs isLocalAuthority, which test/ws-url.test.js pins). Kept here rather than imported because
 * that file is a build-time tool and is not part of the payload.
 */
export function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host ?? ''));
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 0 || a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Split `host:port`, tolerating a bracketed IPv6 literal. Returns null when there is no explicit port. */
export function splitAuthority(authority) {
  const s = String(authority ?? '').trim();
  const m = /^([^\s:]+):(\d{1,5})$/.exec(s);
  if (!m) return null;
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: m[1], port };
}

/**
 * Validate one directory entry into a picker entry, or null when it must be dropped.
 * @param {any} room a `rooms[]` element from the LAN directory
 */
export function lanRoomEntry(room) {
  if (!room || typeof room !== 'object') return null;
  if (room.reachable !== true) return null; // an unreachable peer is not a server you can join
  const authority = `${room.virtualIp}:${Number(room.port) || 0}`;
  const parts = splitAuthority(authority);
  if (!parts || !isPrivateIPv4(parts.host)) return null;
  const humans = Number.isFinite(Number(room.humans)) ? Number(room.humans) : null;
  const rooms = Number.isFinite(Number(room.rooms)) ? Number(room.rooms) : null;
  const version = typeof room.app === 'string' && room.app ? `v${room.app.replace(/^v(?=\d)/, '')}` : '';
  const note = [
    room.self ? '官方服' : (String(room.hostname ?? '').trim() || '局域网房间'),
    version,
    humans != null ? `在线 ${humans}` : '',
    rooms != null ? `房间 ${rooms}` : '',
  ].filter(Boolean).join(' · ');
  return {
    address: authority,
    label: room.self ? '官方服 · 局域网直连' : `${String(room.hostname ?? '').trim() || '局域网房间'}`,
    note,
    lan: true,
    self: Boolean(room.self),
  };
}

/** Turn a directory document into picker entries, dropping anything that fails validation. */
export function lanEntriesFrom(doc) {
  if (!doc || doc.ok !== true || !Array.isArray(doc.rooms)) return [];
  return doc.rooms.map(lanRoomEntry).filter(Boolean);
}

/** What the LAN card's action button says for a given status document ('' = no button). */
export function lanActionLabel(status) {
  if (!status) return '';
  if (status.state === 'up' || status.state === 'degraded' || status.state === 'starting') return '关闭联机';
  if (status.state === 'stopped' || status.state === 'error') return '开启联机';
  return ''; // disabled: this build has no sidecar, offer nothing rather than a button that cannot work
}

/** One-line summary for the LAN card. */
export function lanSummary(status, roomCount) {
  if (!status) return '';
  const tail = status.state === 'up' && roomCount > 0 ? ` · 发现 ${roomCount} 个房间` : '';
  return `${status.message || ''}${tail}`;
}

async function requestJson(url, { method = 'GET', fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const res = await fetchImpl(url, { method, signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Read the sidecar status. null = "no LAN support in this build" (P1) — never throws.
 */
export async function fetchLanStatus(fetchImpl = globalThis.fetch) {
  try {
    const doc = await requestJson(LAN_STATUS_URL, { fetchImpl });
    return doc && doc.ok === true ? doc : null;
  } catch {
    return null;
  }
}

/**
 * The room list, by whichever route this shell offers.
 *
 * Preferred: the shell's own `/lan/rooms` proxy — same origin, so no CORS rule is involved and the shell can
 * add its own caching. Some shells (notably the Tauri one, which is deliberately dependency-free and would need
 * a TLS stack to make the request itself) do not implement the proxy; there we fetch `directoryUrl` straight
 * from `/lan/status`, which works because the directory answers `access-control-allow-origin: *`.
 *
 * Returns the directory document, or null when neither route answers (P1: silence, never an error).
 */
export async function fetchLanRooms(fetchImpl = globalThis.fetch, directoryUrl = '') {
  try {
    const viaShell = await requestJson(LAN_ROOMS_URL, { fetchImpl });
    if (viaShell && viaShell.ok === true) return viaShell;
  } catch {
    /* fall through to the direct route */
  }
  const direct = String(directoryUrl ?? '').trim();
  if (!direct) return null;
  try {
    const doc = await requestJson(direct, { fetchImpl, timeoutMs: 6000 });
    return doc && doc.ok === true ? doc : null;
  } catch {
    return null;
  }
}

export async function setLanUp(up, fetchImpl = globalThis.fetch) {
  try {
    return await requestJson(up ? LAN_UP_URL : LAN_DOWN_URL, { method: 'POST', fetchImpl, timeoutMs: 20000 });
  } catch {
    return null;
  }
}
