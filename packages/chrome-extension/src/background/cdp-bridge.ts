/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * CDP bridge — the extension side of the Plan C "CDP tunnel" (issue #5626).
 *
 * The daemon's `/cdp` endpoint forwards page-domain CDP commands to this module
 * over the reverse `/acp` WebSocket as `cdp_*` frames; here we drive the active
 * tab with `chrome.debugger`:
 *
 *   - `cdp_attach`  → attach the active tab; ack `cdp_attached`
 *   - `cdp_command` → `chrome.debugger.sendCommand`; reply `cdp_result`
 *   - debugger events  → `cdp_event`
 *   - debugger detach  → `cdp_detach`
 *
 * Single tab, single debugger.
 *
 * See `packages/chrome-extension/docs/06-plan-c-cdp-tunnel.md`.
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

/**
 * Inbound `cdp_release` frame (daemon → extension): the `/cdp` puppeteer client
 * disconnected, so detach the debugger and stop forwarding even though the
 * `/acp` socket is still up.
 */
interface CdpReleaseFrame {
  type: 'cdp_release';
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
/** True while a `handleAttach` is mid-flight (guards against overlapping attaches). */
let attaching = false;
/**
 * Set when a `cdp_release` (or socket close) arrives while `handleAttach` is
 * mid-flight. A teardown that fires before the attach lands can't detach a tab
 * the debugger isn't on yet, so it records the request here; `handleAttach`
 * honors it the moment it finishes wiring up. Without this, the late attach
 * would leave a debugger attachment with no live `/cdp` client behind it.
 */
let releaseRequestedDuringAttach = false;

/**
 * Keep the MV3 worker alive while the debugger is attached: it idles out after
 * ~30s, and if it sleeps mid-attachment `chrome.debugger` detaches and the next
 * command hangs. A sub-30s extension-API call resets the idle timer.
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
  return (
    type === 'cdp_command' || type === 'cdp_attach' || type === 'cdp_release'
  );
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
  // Reentrancy guard: handleAttach awaits twice (attach + tabs.get) and is
  // dispatched fire-and-forget. A second cdp_attach mid-flight would interleave
  // teardownAttachment() with the first attach and corrupt attachedTabId. Only
  // one puppeteer client binds today, but the guard keeps the next caller safe.
  if (attaching) {
    send({
      type: 'cdp_attached',
      id: frame.id,
      error: { message: 'attach already in progress' },
    });
    return;
  }
  attaching = true;
  try {
    const tabId = await getActiveTabId();

    // Switching to a different tab: detach the previous one first so it doesn't
    // keep Chrome's debugging banner + keepalive after we move on.
    if (attachedTabId !== null && attachedTabId !== tabId) {
      const prev = attachedTabId;
      await new Promise<void>((resolve) => {
        chrome.debugger.detach({ tabId: prev }, () => {
          void chrome.runtime.lastError; // best-effort; tab may already be gone
          resolve();
        });
      });
      teardownAttachment();
    }

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION, () => {
        const err = chrome.runtime.lastError;
        // "Already attached" is only benign when WE already own this exact tab.
        // Chrome reports the same error when DevTools / another debugger owns
        // it — acking success there would let us claim a tab we can't drive.
        const ownAlreadyAttached =
          /already attached/i.test(err?.message ?? '') &&
          attachedTabId === tabId;
        if (err && !ownAlreadyAttached) {
          reject(new Error(err.message ?? 'debugger attach failed'));
          return;
        }
        resolve();
      });
    });

    // Idempotent re-attach: a prior attachment may still hold live listeners +
    // keepalive. Drop them before re-registering so a second `cdp_attach` can't
    // double-register onDebuggerEvent/onDebuggerDetach — otherwise every CDP
    // event would fire twice and corrupt the puppeteer stream. teardown is a
    // no-op on a fresh attach (attachedTabId is null) and clears attachedTabId,
    // so it must run before we record the new tab below.
    teardownAttachment();

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

    // A cdp_release (or socket close) that arrived while we were awaiting above
    // couldn't tear down an attachment that hadn't landed yet. Now that it has,
    // honor that release immediately so we never leak a debugger attachment with
    // no live `/cdp` client. Clear `attaching` first so shutdownCdpBridge runs a
    // real teardown instead of re-arming the flag we're acting on.
    if (releaseRequestedDuringAttach) {
      attaching = false;
      releaseRequestedDuringAttach = false;
      console.log(LOG_PREFIX, 'release arrived during attach; tearing down');
      // Ack the attach (as an error) before tearing down: the daemon's reverse
      // link is awaiting a `cdp_attached` for this id, so without it the
      // puppeteer client hangs until the ~170s CDP command timeout.
      send({
        type: 'cdp_attached',
        id: frame.id,
        error: { message: 'released during attach' },
      });
      shutdownCdpBridge();
      return;
    }

    console.log(LOG_PREFIX, 'attached tab', tabId);
    send({ type: 'cdp_attached', id: frame.id, url, title });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(LOG_PREFIX, 'attach failed:', message);
    send({ type: 'cdp_attached', id: frame.id, error: { message } });
  } finally {
    attaching = false;
    releaseRequestedDuringAttach = false;
  }
}

/**
 * Handle a `cdp_command` frame: run it on the attached tab and reply.
 *
 * TRUST MODEL — deliberately NO method allowlist: chrome-devtools-mcp drives the
 * tab over the full CDP surface, so any allowlist would break its tools.
 * Arbitrary-CDP exposure (incl. `Runtime.evaluate`) is bounded by the CHANNEL,
 * not the payload: the daemon `/cdp` endpoint is loopback-only, the daemon binds
 * the reverse link only to the `qwen-cdp-bridge` connection, and Chrome shows
 * its "started debugging this browser" banner. Keep this a transparent forwarder.
 */
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
 * Handle a `cdp_release` frame: the daemon's `/cdp` puppeteer client
 * disconnected, so tear the bridge down (detach the debugger + stop forwarding)
 * even though the `/acp` socket is still up.
 */
function handleRelease(_frame: CdpReleaseFrame): void {
  console.log(LOG_PREFIX, 'cdp_release received; detaching debugger');
  shutdownCdpBridge();
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
  } else if (frame.type === 'cdp_release') {
    handleRelease(frame as CdpReleaseFrame);
  }
}

/**
 * Tear down the bridge: detach the debugger and stop forwarding. Called when
 * the daemon socket closes so a stale attachment doesn't linger. Idempotent.
 */
export function shutdownCdpBridge(): void {
  // A release that races an in-flight handleAttach can't detach a tab the
  // debugger hasn't attached to yet (attachedTabId is still null, listeners
  // aren't registered). Record it so handleAttach tears down the moment it
  // finishes wiring up, instead of leaving a debugger attachment behind.
  if (attaching) {
    releaseRequestedDuringAttach = true;
  }
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
