/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * `/cdp` endpoint glue for the Plan C "CDP tunnel" (issue #5626).
 *
 * Per puppeteer connection (chrome-devtools-mcp) this wires:
 *
 *   puppeteer  --raw CDP-->  CdpBrowserEmulator  --forwardToTab-->  CdpReverseLink
 *                                                                        |
 *                                            extension `/acp` socket  <--+
 *
 * The emulator answers browser-level CDP locally and forwards page-domain
 * commands to the real tab over the reverse link; tab events flow back. One
 * `/cdp` connection binds to the (single) active extension bridge in the
 * {@link CdpTunnelRegistry}; if no extension is connected the socket is closed
 * immediately with a clear reason.
 *
 * See `packages/chrome-extension/docs/06-plan-c-cdp-tunnel.md`.
 */

import type { WebSocket } from 'ws';
import { CdpBrowserEmulator, type CdpFrame } from './cdp-browser-emulator.js';
import { CdpReverseLink } from './cdp-reverse-link.js';
import type { CdpTunnelRegistry } from './cdp-tunnel-registry.js';

/** WS close code for "no extension connected" (policy violation). */
const CLOSE_NO_BRIDGE = 1011;
/** WS close code for a normal teardown. */
const CLOSE_NORMAL = 1000;

/**
 * Attach a single puppeteer `/cdp` WebSocket to the active extension bridge.
 * Closes the socket immediately if no extension is connected.
 *
 * @param ws the upgraded puppeteer WebSocket
 * @param registry the process-scoped tunnel registry
 * @param log structured stderr logger (e.g. `writeStderrLine`)
 */
export function attachCdpClient(
  ws: WebSocket,
  registry: CdpTunnelRegistry,
  log: (line: string) => void,
): void {
  const bridge = registry.getActive();
  if (!bridge) {
    log('qwen serve: /cdp rejected — no extension bridge connected');
    try {
      ws.close(
        CLOSE_NO_BRIDGE,
        'No browser extension connected to the CDP tunnel',
      );
    } catch {
      // socket already gone
    }
    return;
  }

  // Single puppeteer client by design (one daemon = one browser). A second
  // overlapping `/cdp` connection would clobber the first's inbound routing,
  // silently corrupting both — reject it instead so the first keeps working.
  if (bridge.cdpBound) {
    log('qwen serve: /cdp rejected — a puppeteer client is already bound');
    try {
      ws.close(CLOSE_NO_BRIDGE, 'A CDP client is already connected');
    } catch {
      // socket already gone
    }
    return;
  }
  bridge.cdpBound = true;

  // Reverse link forwards page-domain commands to the extension's tab.
  const link = new CdpReverseLink((frame) => bridge.send(frame));

  // Emulator answers browser-level CDP locally; page-domain → reverse link.
  const emulator = new CdpBrowserEmulator({
    reply: (frame: CdpFrame) => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        log(
          `qwen serve: /cdp reply send failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    forwardToTab: link.forwardToTab,
  });
  link.bindEmulator(emulator);

  // Inbound extension `cdp_*` frames (cdp_result / cdp_event / cdp_detach)
  // route through THIS link while the puppeteer client is bound.
  bridge.routeInbound = (frame: Record<string, unknown>) =>
    link.handleInbound(frame);

  // If the extension reports detach, close the puppeteer socket so puppeteer
  // observes the disconnect (ExtensionTransport has no onDetach of its own).
  link.onDetach = (reason: string) => {
    log(`qwen serve: /cdp tab detached (${reason}); closing puppeteer socket`);
    try {
      ws.close(CLOSE_NORMAL, `tab detached: ${reason}`);
    } catch {
      // already closing
    }
  };

  let disposed = false;
  const dispose = (reason: string): void => {
    if (disposed) return;
    disposed = true;
    link.dispose(reason);
    // Detach this link from the bridge so a later `/cdp` client rebinds cleanly
    // and stray extension frames don't route into a dead link.
    if (registry.getActive() === bridge) {
      bridge.routeInbound = () => false;
      bridge.cdpBound = false;
      bridge.onExtensionGone = undefined;
    }
  };

  // Extension `/acp` socket dropped (bridge unregistered): the extension can no
  // longer answer page-domain commands, so close the puppeteer socket. Without
  // this, puppeteer hangs until the ~170s CDP command timeout.
  bridge.onExtensionGone = () => {
    log('qwen serve: extension /acp dropped; closing puppeteer /cdp socket');
    dispose('extension /acp disconnected');
    try {
      ws.close(CLOSE_NORMAL, 'extension disconnected');
    } catch {
      // already closing
    }
  };

  ws.on('message', (data: Buffer | string) => {
    let frame: CdpFrame;
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      frame = JSON.parse(text) as CdpFrame;
    } catch {
      // Puppeteer always sends well-formed JSON; ignore garbage frames.
      return;
    }
    void emulator.handleFromClient(frame).catch((err) => {
      log(
        `qwen serve: /cdp emulator error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  });

  ws.on('close', () => dispose('puppeteer /cdp socket closed'));
  ws.on('error', (err) => {
    log(
      `qwen serve: /cdp WS error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    dispose('puppeteer /cdp socket error');
  });

  // Kick the extension to attach its active tab. Best-effort: the emulator
  // serves browser-level topology regardless; page-domain forwards will fail
  // cleanly if the attach never lands. Refresh tab metadata when it resolves.
  void link
    .attach()
    .then((info) => emulator.setTabInfo(info))
    .catch((err) => {
      log(
        `qwen serve: /cdp attach failed: ${
          err && typeof err === 'object' && 'message' in err
            ? String((err as { message?: unknown }).message)
            : String(err)
        }`,
      );
    });

  log('qwen serve: /cdp puppeteer client bound to extension bridge');
}
