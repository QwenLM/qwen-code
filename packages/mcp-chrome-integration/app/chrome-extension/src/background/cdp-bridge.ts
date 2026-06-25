/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * CDP bridge — the extension side of the Plan C "CDP tunnel" (issue #5626).
 *
 * The daemon's `/cdp` endpoint speaks browser-level CDP to an external
 * puppeteer client (chrome-devtools-mcp) and forwards page-domain commands to
 * THIS module over the reverse `/acp` WebSocket as `cdp_*` frames. Here we drive
 * the active tab with the existing `chrome.debugger` API:
 *
 *   - `cdp_attach`  → `chrome.debugger.attach` the active tab; ack `cdp_attached`
 *   - `cdp_command` → `chrome.debugger.sendCommand({tabId}, method, params)`
 *                     → reply `cdp_result` (result or error), correlated by id
 *   - `chrome.debugger.onEvent`  → forward as `cdp_event`
 *   - `chrome.debugger.onDetach` → forward as `cdp_detach` (ExtensionTransport
 *                                  has no onDetach of its own; the daemon
 *                                  synthesizes `Target.detachedFromTarget`)
 *
 * Single tab, single debugger.
 *
 * See `packages/mcp-chrome-integration/docs/06-plan-c-cdp-tunnel.md`.
 */

/* global chrome, console, setInterval, clearInterval */

const LOG_PREFIX = '[CdpBridge]';

/** CDP attach protocol version (matches the network tools). */
const CDP_PROTOCOL_VERSION = '1.3';

/** Inbound `cdp_command` frame (daemon → extension). */
interface CdpCommandFrame {
  type: 'cdp_command';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Inbound `cdp_attach` frame (daemon → extension). */
interface CdpAttachFrame {
  type: 'cdp_attach';
  id: number;
}

/** Any outbound `cdp_*` frame (extension → daemon). */
type CdpOutbound =
  | {
      type: 'cdp_result';
      id: number;
      result?: unknown;
      error?: { code?: number; message?: string };
    }
  | { type: 'cdp_event'; method: string; params?: Record<string, unknown> }
  | {
      type: 'cdp_attached';
      id: number;
      url?: string;
      title?: string;
      error?: { message: string };
    }
  | { type: 'cdp_detach'; reason: string };

/** Sink that pushes one outbound frame down the daemon `/acp` socket. */
type CdpSend = (frame: CdpOutbound) => void;

/** The tab id this bridge currently has the debugger attached to (or null). */
let attachedTabId: number | null = null;
/** The active outbound sink while a `/cdp` puppeteer client is connected. */
let activeSend: CdpSend | null = null;
/** While set, keeps the MV3 worker awake during an attachment (see startAttachKeepalive). */
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Keep the MV3 service worker alive while the debugger is attached. The worker
 * idles out after ~30s with no activity; between CDP commands the agent can
 * pause to think for tens of seconds, and if the worker sleeps `chrome.debugger`
 * detaches — the next command then hangs and the tunnel appears frozen. A
 * sub-30s extension-API call resets the idle timer; the 30s `chrome.alarms`
 * backstop in the service worker only covers idle reconnects, not an in-flight
 * attachment.
 */
// ponytail: 20s poll while attached. Coarser than ideal but well under the 30s
// idle floor; drop it if Chrome ever exposes an explicit "stay awake" for an
// active debuggee.
function startAttachKeepalive(): void {
  if (keepaliveTimer !== null) return;
  keepaliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {
      void chrome.runtime.lastError; // ignore; the call itself is the keepalive
    });
  }, 20_000);
}

function stopAttachKeepalive(): void {
  if (keepaliveTimer !== null) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/** Whether a frame `type` is one this bridge owns (daemon → extension). */
export function isCdpBridgeFrame(type: unknown): boolean {
  return type === 'cdp_command' || type === 'cdp_attach';
}

/**
 * Forward a CDP event from the real tab to the daemon. Only events for the
 * currently-attached tab are forwarded.
 */
function onDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): void {
  if (attachedTabId === null || source.tabId !== attachedTabId) return;
  if (!activeSend) return;
  activeSend({
    type: 'cdp_event',
    method,
    params: (params ?? {}) as Record<string, unknown>,
  });
}

/**
 * The debugger detached (user opened DevTools, clicked the banner Cancel, the
 * page crashed, or we detached). Notify the daemon so puppeteer observes the
 * disconnect, then drop our attachment.
 */
function onDebuggerDetach(
  source: chrome.debugger.Debuggee,
  reason: string,
): void {
  if (attachedTabId === null || source.tabId !== attachedTabId) return;
  console.log(LOG_PREFIX, 'debugger detached:', reason);
  if (activeSend) {
    activeSend({ type: 'cdp_detach', reason: reason || 'target_closed' });
  }
  teardownAttachment();
}

/** Remove our debugger listeners and forget the attached tab. */
function teardownAttachment(): void {
  if (attachedTabId === null) return;
  stopAttachKeepalive();
  try {
    chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    chrome.debugger.onDetach.removeListener(onDebuggerDetach);
  } catch {
    /* listeners already gone */
  }
  attachedTabId = null;
}

/** Resolve the active tab's id (rejects if none / no id). */
async function getActiveTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || tab.id === undefined) {
    throw new Error('No active tab to attach the CDP tunnel to');
  }
  return tab.id;
}

/** Promisified `chrome.debugger.sendCommand` (callback API → Promise). */
function sendDebuggerCommand(
  tabId: number,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(
      { tabId },
      method,
      params ?? {},
      (result?: object) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message ?? 'CDP command failed'));
          return;
        }
        resolve(result ?? {});
      },
    );
  });
}

/** Handle a `cdp_attach` frame: attach the active tab and ack. */
async function handleAttach(
  frame: CdpAttachFrame,
  send: CdpSend,
): Promise<void> {
  try {
    const tabId = await getActiveTabId();
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION, () => {
        const err = chrome.runtime.lastError;
        // "Already attached" is benign — reuse the existing session.
        if (err && !/already attached/i.test(err.message ?? '')) {
          reject(new Error(err.message ?? 'debugger attach failed'));
          return;
        }
        resolve();
      });
    });

    attachedTabId = tabId;
    chrome.debugger.onEvent.addListener(onDebuggerEvent);
    chrome.debugger.onDetach.addListener(onDebuggerDetach);
    startAttachKeepalive();

    // Best-effort tab metadata for the daemon's synthetic targetInfo.
    let url: string | undefined;
    let title: string | undefined;
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab.url;
      title = tab.title;
    } catch {
      /* metadata is optional */
    }

    console.log(LOG_PREFIX, 'attached tab', tabId);
    send({ type: 'cdp_attached', id: frame.id, url, title });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(LOG_PREFIX, 'attach failed:', message);
    send({ type: 'cdp_attached', id: frame.id, error: { message } });
  }
}

/** Handle a `cdp_command` frame: run it on the attached tab and reply. */
async function handleCommand(
  frame: CdpCommandFrame,
  send: CdpSend,
): Promise<void> {
  if (attachedTabId === null) {
    send({
      type: 'cdp_result',
      id: frame.id,
      error: { code: -32000, message: 'CDP tunnel not attached to a tab' },
    });
    return;
  }
  try {
    const result = await sendDebuggerCommand(
      attachedTabId,
      frame.method,
      frame.params,
    );
    send({ type: 'cdp_result', id: frame.id, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    send({
      type: 'cdp_result',
      id: frame.id,
      error: { code: -32000, message },
    });
  }
}

/**
 * Route one inbound `cdp_*` frame from the daemon. The caller filters with
 * {@link isCdpBridgeFrame} first. `send` pushes outbound frames down the same
 * socket; it is recorded as the active sink so events/detach reach the daemon.
 */
export function handleCdpFrame(frame: { type?: unknown }, send: CdpSend): void {
  activeSend = send;
  if (frame.type === 'cdp_attach') {
    void handleAttach(frame as CdpAttachFrame, send);
  } else if (frame.type === 'cdp_command') {
    void handleCommand(frame as CdpCommandFrame, send);
  }
}

/**
 * Tear down the bridge: detach the debugger and stop forwarding. Called when
 * the daemon socket closes so a stale attachment doesn't linger. Idempotent.
 */
export function shutdownCdpBridge(): void {
  const tabId = attachedTabId;
  teardownAttachment();
  activeSend = null;
  if (tabId !== null) {
    try {
      chrome.debugger.detach({ tabId });
    } catch {
      /* might already be detached */
    }
  }
}
