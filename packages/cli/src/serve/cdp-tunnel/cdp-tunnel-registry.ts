/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Process-scoped registry that pairs the (single) extension `/acp` reverse
 * connection with the `/cdp` endpoint for the Plan C "CDP tunnel" (issue
 * #5626).
 *
 * The `/acp` WS layer registers an outbound `cdp_*` frame sink here when an
 * extension connection becomes the active CDP bridge; the `/cdp` endpoint looks
 * up that sink to build a {@link CdpReverseLink}. Single daemon = single
 * extension = single browser, so the registry holds at most one active bridge
 * (last-writer-wins; a fresh extension reconnect supersedes a stale one).
 *
 * Mirrors the shape of `ClientMcpSenderRegistry` (the reverse-MCP analogue) so
 * the two reverse channels are wired the same way through `server.ts`.
 */

import type { CdpOutboundFrame } from './cdp-reverse-link.js';

/** An active extension bridge: a sink for outbound `cdp_*` frames + its inbound router. */
export interface CdpBridgeEndpoint {
  /** Stable id of the owning `/acp` connection (for logging / dedupe). */
  connectionId: string;
  /** Push one outbound `cdp_*` frame down the extension `/acp` socket. */
  send(frame: CdpOutboundFrame): void;
  /**
   * Route one inbound frame from the extension to whatever reverse link is
   * currently bound. Returns true if consumed. Set by the `/cdp` endpoint when
   * a puppeteer client binds; reset to a no-op when it disconnects.
   */
  routeInbound(frame: Record<string, unknown>): boolean;
}

/**
 * Holds the active extension CDP bridge for one daemon process. Inert until an
 * extension `/acp` connection registers and a `/cdp` client binds.
 */
export class CdpTunnelRegistry {
  private active: CdpBridgeEndpoint | undefined;

  /**
   * Register (or replace) the active extension bridge. Returns an unregister
   * callback the `/acp` WS layer calls on socket close. Last-writer-wins: a new
   * extension connection supersedes the previous bridge.
   */
  register(endpoint: CdpBridgeEndpoint): () => void {
    this.active = endpoint;
    return () => {
      if (this.active === endpoint) this.active = undefined;
    };
  }

  /** The active extension bridge, if any. */
  getActive(): CdpBridgeEndpoint | undefined {
    return this.active;
  }

  /** Whether an extension bridge is currently registered. */
  hasActive(): boolean {
    return this.active !== undefined;
  }

  /**
   * Route an inbound `cdp_*` frame (from the extension `/acp` socket) to the
   * active bridge's bound reverse link. Returns true if consumed.
   */
  routeInbound(frame: Record<string, unknown>): boolean {
    return this.active ? this.active.routeInbound(frame) : false;
  }
}
