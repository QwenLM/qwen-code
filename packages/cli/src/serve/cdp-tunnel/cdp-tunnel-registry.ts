/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Process-scoped registry pairing the (single) extension `/acp` reverse
 * connection with the `/cdp` endpoint for the Plan C "CDP tunnel" (issue #5626).
 *
 * The `/acp` WS layer registers an outbound `cdp_*` sink here when an extension
 * becomes the active CDP bridge; the `/cdp` endpoint looks it up to build a
 * {@link CdpReverseLink}. Single daemon = single extension = single browser, so
 * at most one bridge is held (last-writer-wins; a reconnect supersedes a stale
 * one). Mirrors `ClientMcpSenderRegistry` so both reverse channels wire the same
 * way through `server.ts`.
 */

import { writeStderrLine } from '../../utils/stdioHelpers.js';
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
  /**
   * True while a `/cdp` puppeteer client is bound to this bridge. Set by the
   * `/cdp` glue on bind, cleared on its disconnect. Lets the glue reject a
   * second concurrent `/cdp` client instead of silently clobbering the first.
   */
  cdpBound?: boolean;
  /**
   * Set by the `/cdp` glue when a puppeteer client binds: invoked once the
   * extension `/acp` connection drops so the bound puppeteer socket can fail
   * fast instead of hanging until the ~170s CDP command timeout.
   */
  onExtensionGone?: () => void;
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
    // Superseding an existing bridge: tell the old one's bound `/cdp` puppeteer
    // client it's gone so it closes, instead of running on against a dead
    // extension. Without this, the old and new puppeteer clients coexist —
    // violating the single-puppeteer design. `onExtensionGone` is idempotent
    // (its `dispose()` guards re-entry), and we skip a no-op re-register.
    const previous = this.active;
    if (previous && previous !== endpoint) {
      writeStderrLine(
        `qwen serve: /cdp tunnel — extension bridge '${endpoint.connectionId}' ` +
          `superseded the stale '${previous.connectionId}'`,
      );
      previous.onExtensionGone?.();
    }
    this.active = endpoint;
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      if (this.active === endpoint) this.active = undefined;
      // The extension `/acp` socket dropped: tell the bound `/cdp` puppeteer
      // socket so it fails fast instead of hanging on the CDP command timeout.
      endpoint.onExtensionGone?.();
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
