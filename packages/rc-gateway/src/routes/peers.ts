/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonRecord } from '../mdns/advert.js';

/**
 * Browse the LAN for sibling `_qwen-rc._tcp` daemons. Resolves the discovered
 * records (possibly empty), or `null` when mDNS discovery is unavailable
 * (the optional `bonjour-service` dependency is not installed).
 */
export type BrowsePeers = (timeoutMs: number) => Promise<DaemonRecord[] | null>;

/**
 * The gateway's default mDNS browse window. Matches the default the
 * `qwen-rc daemons discover` CLI uses (`parseDiscoverArgs` → `timeoutMs = 5000`).
 * The endpoint blocks for roughly this long — inherent to mDNS.
 */
const PEERS_BROWSE_TIMEOUT_MS = 5000;

/**
 * `GET /rc/peers` — owner-only (enforced at the mount), read-only LAN daemon
 * discovery. Returns `200 { peers }` (the browse result verbatim; empty LAN →
 * `[]`), `503 mdns_unavailable` when discovery is unavailable, `500
 * peers_unavailable` on an unexpected browse failure. No daemon call, no
 * mutation.
 */
export function createPeersRoute(browsePeers: BrowsePeers): RequestHandler {
  return async (_req, res) => {
    try {
      const peers = await browsePeers(PEERS_BROWSE_TIMEOUT_MS);
      if (peers === null) {
        res.status(503).json({
          error:
            'mDNS discovery unavailable (optional bonjour-service dependency not installed)',
          code: 'mdns_unavailable',
        });
        return;
      }
      res.status(200).json({ peers });
    } catch {
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: 'Peer discovery failed', code: 'peers_unavailable' });
      }
    }
  };
}
