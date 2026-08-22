/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Process-scoped registry pairing the (single) extension `/acp` reverse
 * connection with the `/cdp` endpoint for the Plan C "CDP tunnel" (issue #5626).
 *
 * The `/acp` WS layer registers an outbound `cdp_*` sink here when an extension
 * becomes the active CDP bridge; `/cdp` clients look it up to build
 * {@link CdpReverseLink}s. Single daemon = single extension = single browser, so
 * at most one bridge is held (last-writer-wins; a reconnect supersedes a stale
 * one). Mirrors `ClientMcpSenderRegistry` so both reverse channels wire the same
 * way through `server.ts`.
 *
 * Multi-client (issue #8737): a bridge whose extension negotiated
 * `clientInfo.cdpMultiClient` hosts N concurrent `/cdp` puppeteer links, each
 * identified by a minted `linkId` carried on `cdp_*` frames. Tagged
 * `cdp_result`/`cdp_attached`/`cdp_detach` frames route to the owning link;
 * `cdp_event` broadcasts to every link (one shared tab). A legacy bridge (no
 * flag) keeps exact single-client semantics: the second link is refused, and
 * untagged frames route to the sole link.
 */

import { writeStderrLineSafe } from '../../utils/stdioHelpers.js';
import {
  CDP_FRAME_TYPES,
  isValidLinkId,
  isCdpInboundFrameType,
  type CdpOutboundFrame,
} from './cdp-reverse-link.js';

/** An active extension bridge: a sink for outbound `cdp_*` frames. */
export interface CdpBridgeEndpoint {
  /** Stable id of the owning `/acp` connection (for logging / dedupe). */
  connectionId: string;
  /** Push one outbound `cdp_*` frame down the extension `/acp` socket. */
  send(frame: CdpOutboundFrame): void;
  /**
   * Negotiated at registration from the extension's ACP `initialize`
   * (`clientInfo.cdpMultiClient`). When false the registry enforces the
   * original single-`/cdp`-client design for this bridge.
   */
  multiClient: boolean;
}

/** One bound `/cdp` puppeteer link on the active bridge. */
export interface CdpLinkBinding {
  /** Routing key minted by the registry. */
  linkId: string;
  /**
   * Feed one inbound extension frame to this link's reverse link. Returns true
   * if consumed. Set by the `/cdp` glue after the reverse link is built.
   */
  routeInbound(frame: Record<string, unknown>): boolean;
  /**
   * Invoked when the extension `/acp` connection drops (or is superseded) so
   * the link's puppeteer socket can fail fast instead of hanging until the
   * ~170s CDP command timeout. Set by the `/cdp` glue.
   */
  onExtensionGone?: () => void;
}

/**
 * Holds the active extension CDP bridge for one daemon process. Inert until an
 * extension `/acp` connection registers and at least one `/cdp` client binds.
 */
const MAX_MULTI_CLIENT_LINKS = 16;

export class CdpTunnelRegistry {
  private active: CdpBridgeEndpoint | undefined;
  /** Links bound to the active bridge, keyed by minted `linkId`. */
  private readonly links = new Map<string, CdpLinkBinding>();
  /** Monotonic `linkId` mint counter (not reset across bridges). */
  private nextLinkSeq = 1;

  /**
   * Register (or replace) the active extension bridge. Returns an unregister
   * callback the `/acp` WS layer calls on socket close. Last-writer-wins: a new
   * extension connection supersedes the previous bridge.
   */
  register(endpoint: CdpBridgeEndpoint): () => void {
    // Superseding an existing bridge: tell every bound `/cdp` link it's gone
    // so the puppeteer sockets close, instead of running on against a dead
    // extension. Without this, old links would coexist with the new bridge's
    // links — violating the single-extension design.
    const previous = this.active;
    if (previous && previous !== endpoint) {
      writeStderrLineSafe(
        `qwen serve: /cdp tunnel — extension bridge '${endpoint.connectionId}' ` +
          `superseded the stale '${previous.connectionId}'`,
      );
      this.dropAllLinks('extension bridge superseded');
    }
    this.active = endpoint;
    let unregistered = false;
    return () => {
      if (unregistered) return;
      unregistered = true;
      if (this.active === endpoint) {
        this.active = undefined;
        // The extension `/acp` socket dropped: fail every bound `/cdp` link
        // fast instead of hanging on the CDP command timeout.
        this.dropAllLinks('extension /acp disconnected');
      }
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

  /** Number of `/cdp` links currently bound (for status / tests). */
  linkCount(): number {
    return this.links.size;
  }

  /**
   * Bind one `/cdp` puppeteer link to the active bridge and mint its `linkId`.
   * Returns the stored binding (assigned `linkId` included), or `undefined`
   * when no bridge is connected, or when the bridge is legacy (single-client)
   * and a link is already bound — the refusal keeps the pre-multi-client
   * "reject the second client" behavior for old extensions. The returned
   * object is held by reference: the `/cdp` glue assigns its `routeInbound`
   * and `onExtensionGone` after building the reverse link.
   */
  acquireLink(
    binding: Omit<CdpLinkBinding, 'linkId'>,
  ): CdpLinkBinding | undefined {
    const bridge = this.active;
    if (!bridge) return undefined;
    if (!bridge.multiClient && this.links.size >= 1) return undefined;
    // Cap multi-client links too: each bound link carries daemon-side
    // timers/state plus an extension-side attachment ref, and a
    // reconnect-looping client must not grow either without bound.
    if (bridge.multiClient && this.links.size >= MAX_MULTI_CLIENT_LINKS) {
      return undefined;
    }
    const stored: CdpLinkBinding = Object.assign(binding, {
      linkId: `cdp-link-${this.nextLinkSeq++}`,
    });
    this.links.set(stored.linkId, stored);
    return stored;
  }

  /** Unbind one link (idempotent on unknown ids). */
  releaseLink(linkId: string): void {
    this.links.delete(linkId);
  }

  /**
   * Route one inbound `cdp_*` frame (from the extension `/acp` socket).
   * Returns true if consumed. Routing:
   *   - tagged `linkId` → the owning link (unknown ids are dropped, logged);
   *   - untagged `cdp_event`/`cdp_detach` → broadcast to every link;
   *   - other untagged frames → the sole link (legacy bridge; with several
   *     links they are uncorrelatable and dropped).
   */
  routeInbound(frame: Record<string, unknown>): boolean {
    if (!this.active) return false;
    const frameType = frame['type'];
    if (!isCdpInboundFrameType(frameType)) return false;
    const rawLinkId = frame['linkId'];
    if (rawLinkId !== undefined) {
      if (!isValidLinkId(rawLinkId)) {
        writeStderrLineSafe(
          `qwen serve: /cdp dropped ${String(frameType)} frame with malformed linkId`,
        );
        return true;
      }
      const link = this.links.get(rawLinkId);
      if (!link) {
        writeStderrLineSafe(
          `qwen serve: /cdp dropped ${String(frameType)} frame for unknown linkId '${rawLinkId}'`,
        );
        return true;
      }
      return link.routeInbound(frame);
    }
    if (
      frameType === CDP_FRAME_TYPES.event ||
      frameType === CDP_FRAME_TYPES.detach
    ) {
      // One shared tab: every link's emulator re-emits the event on its own
      // puppeteer client's sessions, mirroring several clients on one browser.
      let consumed = false;
      for (const link of [...this.links.values()]) {
        if (link.routeInbound(frame)) consumed = true;
      }
      return consumed;
    }
    if (this.links.size === 1) {
      const [sole] = this.links.values();
      return sole.routeInbound(frame);
    }
    if (this.links.size > 1) {
      writeStderrLineSafe(
        `qwen serve: /cdp dropped untagged ${String(frameType)} frame with ${this.links.size} links bound`,
      );
      return true;
    }
    return false;
  }

  routeInboundFrom(
    endpoint: CdpBridgeEndpoint,
    frame: Record<string, unknown>,
  ): boolean {
    return this.active === endpoint && this.routeInbound(frame);
  }

  /** Notify and unbind every link (bridge gone / superseded). */
  private dropAllLinks(reason: string): void {
    const bindings = [...this.links.values()];
    this.links.clear();
    for (const binding of bindings) {
      try {
        binding.onExtensionGone?.();
      } catch {
        // a link's teardown already ran; dropping is best-effort
      }
    }
    if (bindings.length > 0) {
      writeStderrLineSafe(
        `qwen serve: /cdp tunnel dropped ${bindings.length} link(s) (${reason})`,
      );
    }
  }
}
