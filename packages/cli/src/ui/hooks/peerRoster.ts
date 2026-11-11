/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Throttled peer listing for the `@` completion.
 *
 * Deliberately *not* shared with the submit path. A stale suggestion is one the
 * user can ignore; a stale submit-time resolution is a label the model is told
 * to send to, and resolving against a peer that exited seconds ago is how a
 * message gets addressed into a hole. So the completion caches and the
 * attachment generator enumerates fresh.
 *
 * See docs/designs/2026-08-17-at-mention-peer-sessions.md §6.5.
 */

import {
  addressLabel,
  isCrossSessionMessagingEnabled,
  listAllPeers,
  runLogger,
  type PeerEntry,
} from '@qwen-code/core';

/** Trailing window inside which repeated refreshes collapse into one listing. */
export const PEER_ROSTER_THROTTLE_MS = 5_000;

type Listener = () => void;

let roster: readonly PeerEntry[] = [];
let lastLoadedAt = 0;
let inFlight: Promise<void> | undefined;
let contentKey = '';
const listeners = new Set<Listener>();

/**
 * What counts as a changed roster.
 *
 * Identity and label only. `listAllPeers()` builds a fresh array of fresh
 * objects every call, so any `===` or shallow comparison reports a change every
 * time — and since the completion's own render is what starts a refresh, that
 * would be a dispatch loop damped only by the throttle.
 *
 * `status` and age are excluded on purpose: age is derived from `Date.now()` at
 * render, so including it would notify on every single refresh. The cost is
 * only that a peer going busy → idle does not *re-render* an already-open
 * completion list — the value itself is current, because the roster adopts the
 * fresh objects either way. Do not "fix" this by adding those fields.
 */
function keyOf(peers: readonly PeerEntry[]): string {
  return peers
    .map(
      (peer) =>
        `${peer.session.messagingSocketPath}\0${addressLabel(peers, peer)}`,
    )
    .sort()
    .join('\n');
}

/** The last loaded listing. Empty until the first refresh resolves. */
export function cachedPeerRoster(): readonly PeerEntry[] {
  return roster;
}

/**
 * Subscribes to roster *content* changes.
 *
 * Fires at most once per resolved refresh whose content differs from the
 * previous one — never once per {@link refreshPeerRoster} call, so a throttled
 * or deduplicated call notifies nobody.
 */
export function subscribeToPeerRoster(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reloads the listing, at most once per throttle window.
 *
 * Fire-and-forget by design: the caller renders from {@link cachedPeerRoster}
 * immediately and hears about a change through the subscription, so a cold
 * roster never delays the rows already in hand. Never rejects — a failed
 * refresh leaves the previous listing in place rather than clearing rows.
 */
export function refreshPeerRoster(): Promise<void> {
  if (!isCrossSessionMessagingEnabled()) return Promise.resolve();
  if (inFlight) return inFlight;
  if (lastLoadedAt !== 0 && Date.now() - lastLoadedAt < PEER_ROSTER_THROTTLE_MS) {
    return Promise.resolve();
  }

  inFlight = (async () => {
    try {
      const peers = await listAllPeers();
      lastLoadedAt = Date.now();
      const key = keyOf(peers);

      // Always adopt the fresh objects, even when the key is unchanged. The key
      // deliberately ignores `status`, so returning before this assignment
      // would pin every row to the *first* enumeration's session record and a
      // peer going busy → idle would never update for as long as the process
      // ran. What the key gates is the notification, not the data.
      roster = peers;
      if (key === contentKey) return;
      contentKey = key;
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          runLogger.warn(
            `[peerRoster] listener threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      // Keep the previous listing: a failed enumeration is not evidence that
      // the peers are gone.
      lastLoadedAt = Date.now();
      runLogger.debug(
        `[peerRoster] refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      inFlight = undefined;
    }
  })();

  return inFlight;
}

/** Test seam: drops the cache, the throttle and every listener. */
export function resetPeerRosterForTesting(): void {
  roster = [];
  lastLoadedAt = 0;
  inFlight = undefined;
  contentKey = '';
  listeners.clear();
}
