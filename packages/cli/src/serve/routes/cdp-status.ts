/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import type { CdpTunnelRegistry } from '../cdp-tunnel/cdp-tunnel-registry.js';

/** Shape of `GET /cdp/status` (issue #8737 shared Chrome bridge probe). */
export interface CdpStatusResponse {
  /** The `/cdp` tunnel endpoint is enabled on this daemon. */
  enabled: boolean;
  /** A Chrome extension bridge is currently connected over `/acp`. */
  bridgeConnected: boolean;
  /** The connected bridge negotiated multi-client routing. */
  multiClient: boolean;
  /** `/cdp` puppeteer links currently bound. */
  linkCount: number;
  /**
   * A CDP client without auth capability (plain puppeteer /
   * chrome-devtools-mcp `--wsEndpoint`) can connect and share the bridge.
   * False when no bridge is connected, the bridge is legacy single-client,
   * or the daemon is bearer-token-gated (the `/cdp` upgrade then requires
   * auth such clients cannot present).
   */
  usable: boolean;
}

interface RegisterCdpStatusRouteDeps {
  /** Undefined when the tunnel endpoint is disabled. */
  registry: CdpTunnelRegistry | undefined;
  /** The daemon's bearer token gates the `/cdp` WS upgrade. */
  token: string | undefined;
}

/**
 * Lightweight liveness probe so non-daemon Qwen Code processes can discover a
 * shared Chrome bridge (extension connected + multi-client) before rerouting
 * their `chrome-devtools` MCP from `--autoConnect` to `--wsEndpoint`. Returns
 * only booleans/counters — no workspace or session data.
 *
 * Mounted behind the daemon's bearer auth when a token is configured: an
 * unauthenticated probe then receives `401` (not the `usable: false` body),
 * which the reroute treats as "no bridge" and safely keeps `--autoConnect`.
 * The `usable` field still tells token-bearing clients why their
 * auth-incapable CDP tools cannot share the bridge.
 */
export function registerCdpStatusRoute(
  app: Application,
  deps: RegisterCdpStatusRouteDeps,
): void {
  app.get('/cdp/status', (_req, res) => {
    const bridge = deps.registry?.getActive();
    const bridgeConnected = bridge !== undefined;
    const multiClient = bridge?.multiClient === true;
    const usable =
      bridgeConnected &&
      multiClient &&
      !(typeof deps.token === 'string' && deps.token.length > 0);
    const body: CdpStatusResponse = {
      enabled: deps.registry !== undefined,
      bridgeConnected,
      multiClient,
      linkCount: deps.registry?.linkCount() ?? 0,
      usable,
    };
    res.status(200).json(body);
  });
}
