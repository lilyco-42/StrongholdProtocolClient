// A copy of the address normalisation that `patches/game-client.patch` adds to the game's `js/net.js`.
//
// Why a copy: the picker stores what the player typed (`https://host/play`, `1.2.3.4:3000`, `host`) and the only
// thing two entries of the same server share is the *socket URL* they normalise to. The picker gets that function
// from `js/net.js` inside the payload, so a tool in this repo cannot import it without a game checkout — same
// reason `tools/game-contract.mjs` carries its own copies.
//
// The three functions below are copied VERBATIM from the patch's added lines; the only edit is putting `export ` in
// front of the two helpers the game keeps module-private. `test/ws-url.test.js` re-extracts those lines from
// `patches/game-client.patch`, compares each function as text, and runs both implementations over the same corpus.
// That gate exists because a paraphrase of this file did drift: IPv6 `[::1]` with no port normalised to `wss://`
// here while the shipped code produces `ws://` — and this function is the de-duplication key for the picker's
// seeded servers, so the two sides disagreeing would hand every install a duplicate or a dead entry.

/** Loopback / private addresses (a bare host name without a port for these is plain ws://, not wss://). */
export function isLocalAuthority(authority) {
  const host = authority.startsWith('[')
    ? (authority.slice(1, authority.indexOf(']')) || authority)
    : authority.split(':')[0];
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** The explicit `:port` of an authority (`''` when it has none); IPv6 authorities keep their brackets. */
export function authorityPort(authority) {
  const a = String(authority);
  const end = a.startsWith('[') ? a.indexOf(']') : -1;
  const host = end === -1 ? a.split(':')[0] : a.slice(0, end + 1);
  const m = /^:(\d+)$/.exec(a.slice(host.length));
  return m ? m[1] : '';
}

/**
 * Normalise any server address to a socket URL ending in `/ws`:
 * `game.starst.site` → `wss://game.starst.site/ws`; `192.168.1.9:3000` → `ws://192.168.1.9:3000/ws`;
 * `https://x.io` → `wss://x.io/ws`; `ws://x.io:3000/game/ws` keeps its path.
 *
 * With no scheme the guess is: an explicit port means a server the player runs themselves (plain `ws://`, except
 * `:443`), while no port means a hosted site (TLS `wss://`, unless the host is loopback / LAN). The packaged
 * shell's picker probes the other scheme as well, so a typed `host:port` never needs a hand-written `http://`.
 * @param {string} raw
 * @returns {string}
 */
export function toWsUrl(raw) {
  const s = String(raw).trim().replace(/\/+$/, '');
  const m = /^(wss?|https?):\/\/(.*)$/i.exec(s);
  const scheme = m ? m[1].toLowerCase() : '';
  const rest = m ? m[2] : s;
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash).replace(/\/+$/, '');
  const port = authorityPort(authority);
  const secure = scheme
    ? scheme === 'wss' || scheme === 'https'
    : port
      ? port === '443'
      : !isLocalAuthority(authority);
  const pathPart = path && path !== '/' ? path : '';
  return `${secure ? 'wss' : 'ws'}://${authority}${/\/ws$/.test(pathPart) ? pathPart : `${pathPart}/ws`}`;
}
