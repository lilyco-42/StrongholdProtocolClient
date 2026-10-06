// Decentralized lobby — the transport half. Everything the browser needs to meet another player without a server:
// peer discovery and the advert broadcast ride on public relays, the game data never touches them.
//
// Inert by construction. Importing this file connects nothing; the 75 kB Trystero bundle is behind a dynamic
// `import()` that only fires when `openLobby()` is called. That keeps the default launch (no P2P) at exactly the cost
// it has today, which matters because the picker runs before the game boots.
//
// What "no server" means here (measured 2026-10-06, see agents/p2p-match/agent.md §2): WebRTC needs *a* signalling
// channel, so this borrows public Nostr relays. 25 of Trystero's 29 defaults answered from this machine. The relays
// only exchange connection offers — once two peers are connected, nothing else passes through them. When NAT
// traversal fails (symmetric NAT / carrier CGNAT, ~15–25% of pairs, RFC 4787) the pair needs a TURN relay, which is
// why `turnConfig` is threaded through instead of hard-coded: the free options are the caller's choice to make.

import { makeAdvert, mergeAdverts } from './rooms.js';

/** Every packaged client lands in the same lobby, so the room name must not depend on the chosen server. */
export const LOBBY_APP_ID = 'stronghold-protocol-p2p-v1';
export const LOBBY_ROOM = 'lobby';

/** Re-publish well inside rooms.js's ADVERT_TTL_MS, so one lost frame does not make a live peer disappear. */
const REPUBLISH_MS = 30_000;
/** How often expired adverts are dropped from the list even when no message arrives to trigger a refresh. */
const SWEEP_MS = 10_000;

let trysteroPromise = null;

/** Load the vendored bundle once, on first use. */
function loadTrystero() {
  trysteroPromise ??= import('./vendor/trystero.js');
  return trysteroPromise;
}

/**
 * Open the lobby and start advertising.
 *
 * @param {object} [options]
 * @param {string} [options.appId] Trystero app id — all peers must agree, so change it and nobody finds anybody.
 * @param {string} [options.roomId]
 * @param {Array<object>|null} [options.turnConfig] RFC 8656 TURN servers, used only for the pairs that cannot
 *   connect directly. Omit for the zero-cost path (public relays + direct connections only).
 * @param {number} [options.republishMs]
 * @returns {Promise<object>} a handle — see the returned object below.
 */
export async function openLobby({ appId = LOBBY_APP_ID, roomId = LOBBY_ROOM, turnConfig = null, republishMs = REPUBLISH_MS } = {}) {
  const { joinRoom, selfId } = await loadTrystero();

  const config = { appId };
  if (Array.isArray(turnConfig) && turnConfig.length) config.turnConfig = turnConfig;

  const room = joinRoom(config, roomId);
  const advert = room.makeAction('advert');

  /** peerId → the advert that peer last published. Keyed by peer so a departure can retract its entries at once. */
  const heard = new Map();
  let self = null;
  let lastError = null;
  let closed = false;
  let notify = null;

  /** Peer ids currently connected (a peer can be connected without having published an address yet). */
  const peerIds = () => Object.keys(room.getPeers());

  const state = () => ({
    selfId,
    roomId,
    peerIds: peerIds(),
    rooms: mergeAdverts([self, ...heard.values()].filter(Boolean)),
    lastError,
    closed,
  });

  const refresh = () => {
    if (!closed) notify?.(state());
  };

  advert.onMessage = (data, { peerId }) => {
    const parsed = makeAdvert(data);
    if (!parsed) return;
    heard.set(peerId, parsed);
    refresh();
  };

  room.onPeerJoin = (peerId) => {
    // Push immediately instead of waiting for the next tick: the joiner needs the list now, not in 30 s.
    if (self) advert.send(self, peerId);
    refresh();
  };
  room.onPeerLeave = (peerId) => {
    heard.delete(peerId);
    refresh();
  };
  // SDP was exchanged but WebRTC still could not connect — the pair needs TURN (Trystero's own wording).
  room.onJoinError = (error) => {
    lastError = error;
    refresh();
  };

  const publishTimer = setInterval(() => {
    if (self) advert.send(self);
  }, republishMs);
  const sweepTimer = setInterval(refresh, SWEEP_MS);

  return {
    selfId,
    /**
     * Advertise where this player can be reached. Call again whenever it changes (the picker calls it after the
     * player adds or removes a server); an empty address publishes presence without an offer.
     */
    publish({ name = '', address = '' } = {}) {
      self = makeAdvert({ name, address, at: Date.now() });
      advert.send(self);
      refresh();
    },
    /** Current merged view. Safe to call at any time, including after close(). */
    state,
    /** Subscribe to changes. One subscriber — the picker owns this handle. */
    subscribe(fn) {
      notify = fn;
      return () => {
        if (notify === fn) notify = null;
      };
    },
    /** Round-trip time to one peer in ms, or null when it could not answer. */
    async ping(peerId) {
      try {
        return await room.ping(peerId);
      } catch {
        return null;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(publishTimer);
      clearInterval(sweepTimer);
      heard.clear();
      notify = null;
      try {
        await room.leave();
      } catch {
        // Leaving is best-effort: the relays drop a silent peer on their own, and a failed goodbye is not an error
        // the player can act on.
      }
    },
  };
}
