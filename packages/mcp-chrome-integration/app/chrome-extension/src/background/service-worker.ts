/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Daemon CDP client — the entire extension service worker (Plan C, issue #5626).
 *
 * The extension is a dumb CDP-tunnel pipe: it connects to a local `qwen serve`
 * daemon's `/acp` WebSocket and bridges `cdp_*` frames into `chrome.debugger`
 * via {@link handleCdpFrame}. There is no chat UI and no reverse tool channel —
 * chat lives in the daemon web UI and browser tooling runs as chrome-devtools-mcp
 * over this same CDP tunnel.
 *
 * Handshake note: the daemon's `/acp` transport closes the socket on a 30s
 * "initialize timeout" unless it receives an ACP `initialize` first, and the
 * daemon eagerly registers this connection as the CDP bridge at that moment. So
 * we send the ACP initialize on open and then route `cdp_*` frames; we do NOT
 * advertise any reverse MCP tool server (chrome-tools is gone).
 */

import {
  isCdpBridgeFrame,
  handleCdpFrame,
  shutdownCdpBridge,
} from './cdp-bridge';
import { getDaemonConfig } from '../daemon/config.js';
import { checkDaemonHealth } from '../daemon/discovery.js';

/* global WebSocket, console, setTimeout, chrome */

const LOG_PREFIX = '[ServiceWorker]';

/**
 * Correlation id for the ACP `initialize` sent right after the socket opens.
 * The daemon closes the connection on a 30s "initialize timeout" unless it sees
 * an ACP initialize before anything else, and it registers this connection as
 * the CDP bridge at that point.
 */
const ACP_INIT_ID = 'browser-tools-acp-init';

/** Reconnect backoff bounds (ms). */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let socket: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;

/** Translate the daemon's HTTP base URL into the `/acp` WebSocket URL. */
function toWebSocketUrl(baseUrl: string, token?: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const wsBase = trimmed.replace(/^http/i, 'ws');
  const url = `${wsBase}/acp`;
  // Loopback daemons are auth-free; for token-gated daemons pass it as a query
  // param since the WebSocket handshake can't carry an Authorization header.
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}

/** Send any JSON message if the socket is open; swallow failures (close handles it). */
function sendRaw(message: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
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

  // ACP `initialize` ack. We don't register anything afterwards (chrome-tools is
  // gone); the daemon has already bound this connection as the CDP bridge.
  if (msg['id'] === ACP_INIT_ID && ('result' in msg || 'error' in msg)) {
    if (msg['error']) {
      console.warn(LOG_PREFIX, 'ACP initialize failed:', msg['error']);
    } else {
      console.log(LOG_PREFIX, 'ACP initialized; CDP tunnel ready');
    }
    return;
  }

  // CDP-tunnel frames: the daemon's `/cdp` endpoint forwards page-domain CDP
  // commands here as `cdp_command` / `cdp_attach`. Route them to the bridge,
  // which drives the tab via chrome.debugger and pushes `cdp_result` /
  // `cdp_event` / `cdp_attached` / `cdp_detach` back over this same socket.
  if (isCdpBridgeFrame(msg['type'])) {
    handleCdpFrame(msg as { type?: unknown }, (frame) => sendRaw(frame));
    return;
  }
  // Other frame types (chat/session traffic on the shared /acp socket) are not
  // ours; ignore them.
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
  if (socket && socket.readyState === WebSocket.OPEN) return;

  let url: string;
  try {
    const config = await getDaemonConfig();
    url = toWebSocketUrl(config.baseUrl, config.token);
  } catch (error) {
    console.warn(LOG_PREFIX, 'Failed to read daemon config:', error);
    scheduleReconnect();
    return;
  }

  console.log(LOG_PREFIX, 'Connecting to', url);
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (error) {
    console.warn(LOG_PREFIX, 'WebSocket construction failed:', error);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    console.log(LOG_PREFIX, 'Connected; sending ACP initialize');
    // The daemon's /acp transport requires an ACP `initialize` first and closes
    // the socket on a 30s timeout otherwise; it registers this connection as the
    // CDP bridge at that point.
    sendRaw({
      jsonrpc: '2.0',
      id: ACP_INIT_ID,
      method: 'initialize',
      params: {},
    });
  };

  ws.onmessage = (event: MessageEvent) => onWsMessage(event.data);

  ws.onerror = (event: Event) => {
    console.warn(LOG_PREFIX, 'WebSocket error', event);
  };

  ws.onclose = () => {
    console.log(LOG_PREFIX, 'Disconnected');
    if (socket === ws) socket = null;
    // Drop any CDP-tunnel debugger attachment so a closed daemon socket doesn't
    // leave the debugger banner stuck on the user's tab.
    shutdownCdpBridge();
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
 * MV3 keepalive. The service worker idles out after ~30s; without this the CDP
 * tunnel silently drops whenever no puppeteer client is driving it, and the
 * user has to keep the "Service Worker" DevTools window open to hold the worker
 * awake. `chrome.alarms` is one of the few things that wakes a terminated
 * worker — and each wake re-runs this file's top level, so `start()` re-opens
 * the tunnel. The recurring `onAlarm` dispatch also keeps the idle timer from
 * firing while the worker is alive.
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

void start();
