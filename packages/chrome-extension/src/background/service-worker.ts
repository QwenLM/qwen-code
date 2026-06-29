/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Daemon CDP client — the entire extension service worker (Plan C, issue #5626).
 *
 * A dumb CDP-tunnel pipe: connects to the local `qwen serve` daemon's `/acp`
 * WebSocket and bridges `cdp_*` frames into `chrome.debugger` via
 * {@link handleCdpFrame}. No chat UI — chat lives in the daemon web UI.
 *
 * On open we send an ACP `initialize`: the daemon closes the socket on a 30s
 * timeout otherwise, and registers this connection as the CDP bridge at that
 * moment.
 */

import {
  isCdpBridgeFrame,
  handleCdpFrame,
  shutdownCdpBridge,
} from './cdp-bridge';
import { getDaemonConfig } from '../daemon/config.js';
import { checkDaemonHealth } from '../daemon/discovery.js';

/* global WebSocket, console, setTimeout, chrome, TextEncoder, btoa */

const LOG_PREFIX = '[ServiceWorker]';

// Bearer-over-WS subprotocol. A token-gated daemon reads the bearer from the
// `Sec-WebSocket-Protocol` subprotocol (the WS handshake can't carry an
// Authorization header). Kept in sync with WS_BEARER_SUBPROTOCOL_PREFIX in
// `packages/cli/src/serve/acp-http/index.ts` and the web-shell encoder; the
// daemon completes the handshake by selecting the non-secret `qwen-ws` marker
// and never echoes the token.
const WS_BEARER_SUBPROTOCOL_PREFIX = 'qwen-bearer.';
const WS_AUTH_SUBPROTOCOL = 'qwen-ws';

/** Encode a bearer token as a `qwen-bearer.<base64url(token)>` WS subprotocol. */
function bearerSubprotocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${WS_BEARER_SUBPROTOCOL_PREFIX}${b64}`;
}

/** Correlation id for the ACP `initialize` sent right after the socket opens. */
const ACP_INIT_ID = 'browser-tools-acp-init';

/**
 * `clientInfo.name` this extension sends so the daemon routes the reverse CDP
 * bridge to it. Must equal `CDP_BRIDGE_CLIENT_NAME` in
 * `packages/cli/src/serve/acp-http/index.ts` (separate packages, no shared
 * module).
 */
const CDP_BRIDGE_CLIENT_NAME = 'qwen-cdp-bridge';

/** Reconnect backoff bounds (ms). */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let socket: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;

/** Translate the daemon's HTTP base URL into the `/acp` WebSocket URL. */
function toWebSocketUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const wsBase = trimmed.replace(/^http/i, 'ws');
  return `${wsBase}/acp`;
}

/** Send any JSON message if the socket is open; swallow failures (close handles it). */
function sendRaw(message: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn(LOG_PREFIX, 'sendRaw: socket not OPEN, dropping frame');
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to send:', error);
  }
}

/** Parse and route an inbound WS frame. */
function onWsMessage(data: unknown): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(String(data)) as Record<string, unknown>;
  } catch {
    return; // ignore non-JSON / unrelated frames
  }
  if (!msg || typeof msg !== 'object') return;

  // ACP `initialize` ack. Nothing to register afterwards; the daemon already
  // bound this connection as the CDP bridge.
  if (msg['id'] === ACP_INIT_ID && ('result' in msg || 'error' in msg)) {
    if (msg['error']) {
      // The daemon may have already registered this connection as the CDP
      // bridge (by clientInfo.name), so a failed init leaves it holding a bridge
      // the extension considers dead. Close the socket; onclose tears the bridge
      // down and reconnects rather than stranding it open.
      console.warn(
        LOG_PREFIX,
        'ACP initialize failed; closing socket:',
        msg['error'],
      );
      socket?.close();
    } else {
      console.log(LOG_PREFIX, 'ACP initialized; CDP tunnel ready');
    }
    return;
  }

  // CDP-tunnel frames: route to the bridge, which drives the tab via
  // chrome.debugger and pushes results/events back over this socket.
  if (isCdpBridgeFrame(msg['type'])) {
    handleCdpFrame(msg as { type?: unknown }, (frame) => sendRaw(frame));
    return;
  }
  // Other frame types (chat/session traffic) aren't ours; ignore.
}

/** Schedule a reconnect with capped exponential backoff. */
function scheduleReconnect(): void {
  if (!started || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  console.log(LOG_PREFIX, `Reconnecting in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

/** Open the WebSocket and wire up handlers. */
async function connect(): Promise<void> {
  if (!started) return;
  // Skip when a socket is already OPEN *or* still CONNECTING — a rapid
  // reconnect (e.g. config change) must not orphan an in-flight handshake.
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  let url: string;
  let token: string | undefined;
  try {
    const config = await getDaemonConfig();
    url = toWebSocketUrl(config.baseUrl);
    token = config.token;
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to read daemon config:', error);
    scheduleReconnect();
    return;
  }

  // The token rides in the WS subprotocol, never the URL, so the URL is safe to
  // log as-is.
  console.log(LOG_PREFIX, 'Connecting to', url);
  let ws: WebSocket;
  try {
    // A token-gated daemon authenticates the handshake via the `qwen-bearer.*`
    // subprotocol (loopback daemons are auth-free → no subprotocol).
    ws = token
      ? new WebSocket(url, [WS_AUTH_SUBPROTOCOL, bearerSubprotocol(token)])
      : new WebSocket(url);
  } catch (error) {
    console.warn(LOG_PREFIX, 'WebSocket construction failed:', error);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    console.log(LOG_PREFIX, 'Connected; sending ACP initialize');
    sendRaw({
      jsonrpc: '2.0',
      id: ACP_INIT_ID,
      method: 'initialize',
      // `clientInfo.name` gates which /acp connection becomes the CDP bridge
      // (vs web UI / Zed clients sharing /acp); must match the daemon's gate.
      params: {
        clientInfo: { name: CDP_BRIDGE_CLIENT_NAME, version: '1.0.0' },
      },
    });
  };

  ws.onmessage = (event: MessageEvent) => onWsMessage(event.data);

  ws.onerror = (event: Event) => {
    console.warn(LOG_PREFIX, 'WebSocket error', event);
  };

  ws.onclose = (event: CloseEvent) => {
    // Surface the daemon's close code/reason (e.g. 1011 "No browser extension
    // connected to the CDP tunnel") so failure modes aren't indistinguishable.
    console.log(
      LOG_PREFIX,
      `Disconnected (code=${event.code}${
        event.reason ? `, reason="${event.reason}"` : ''
      })`,
    );
    // Only the *active* socket's close tears down the bridge. If the daemon
    // force-closed a stale socket after the extension already opened a new one,
    // that stale close must NOT detach the new connection's debugger — doing so
    // would yank the debugger banner and break the live `/cdp` client.
    if (socket === ws) {
      socket = null;
      shutdownCdpBridge();
    }
    scheduleReconnect();
  };
}

/**
 * Start the daemon CDP client: probe `/health` to avoid spamming reconnects
 * when no daemon is up, then open the `/acp` WebSocket (which owns its own
 * reconnect loop once started). Idempotent.
 */
async function start(): Promise<void> {
  if (started) return;
  try {
    const config = await getDaemonConfig();
    const health = await checkDaemonHealth(config);
    if (!health.reachable) {
      console.log(
        LOG_PREFIX,
        'Daemon not reachable; CDP client idle:',
        health.error,
      );
      return;
    }
    console.log(LOG_PREFIX, 'Daemon reachable; starting CDP client');
  } catch (error) {
    console.warn(LOG_PREFIX, 'Daemon health probe failed:', error);
    return;
  }
  started = true;
  reconnectDelay = RECONNECT_MIN_MS;
  void connect();
}

/**
 * MV3 keepalive. The service worker idles out after ~30s, silently dropping the
 * CDP tunnel; `chrome.alarms` is one of the few things that wakes a terminated
 * worker, and each wake re-runs this file's top level so `start()` re-opens the
 * tunnel.
 */
const KEEPALIVE_ALARM = 'cdp-tunnel-keepalive';
// ponytail: 0.5min is the release-build floor; on a cold idle the reconnect can
// lag up to one tick (~30s). Tighten only if that gap proves visible in use.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (socket && socket.readyState === WebSocket.OPEN) return;
  // Reconnect: a fresh worker has started===false (top-level start() also runs);
  // a still-alive worker whose socket dropped has started===true.
  if (started) void connect();
  else void start();
});

// No UI of its own: clicking the toolbar icon opens the side panel, which hosts
// the daemon web UI in an iframe (see sidepanel.html).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) =>
    console.warn(LOG_PREFIX, 'Failed to set side panel behavior:', error),
  );

void start();
