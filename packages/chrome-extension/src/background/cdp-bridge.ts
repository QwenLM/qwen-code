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
 * The raw tunnel exposes one tab; direct WebBridge calls can keep multiple tabs
 * attached so network capture continues while the agent switches tabs.
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
type CdpEventListener = (
  method: string,
  params: Record<string, unknown>,
  tabId: number,
) => void;
type CdpDetachListener = (tabId: number) => void;
export type CdpCommand = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/** Tabs this extension currently owns through chrome.debugger. */
const attachedTabIds = new Set<number>();
const directTabIds = new Set<number>();
/** The tab currently exposed to the legacy raw `/cdp` tunnel. */
let rawTabId: number | null = null;
/** The active outbound sink while a `/cdp` puppeteer client is connected. */
let activeSend: CdpSend | null = null;
/** While set, keeps the MV3 worker awake during an attachment (see startAttachKeepalive). */
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
/** True while a `handleAttach` is mid-flight (guards against overlapping attaches). */
let attaching = false;
let attachingTabId: number | null = null;
/**
 * Set when a `cdp_release` (or socket close) arrives while `handleAttach` is
 * mid-flight. A teardown that fires before the attach lands can't detach a tab
 * the debugger isn't on yet, so it records the request here; `handleAttach`
 * honors it the moment it finishes wiring up. Without this, the late attach
 * would leave a debugger attachment with no live `/cdp` client behind it.
 */
let releaseRequestedDuringAttach = false;
let attachGeneration = 0;
const directEventListeners = new Set<CdpEventListener>();
const directDetachListeners = new Set<CdpDetachListener>();
const detachingTabIds = new Set<number>();
const pendingDirectCommands = new Set<{
  expire(): void;
  cancel(error: Error): void;
}>();
let directOperationActive = false;
/**
 * Tabs the in-flight direct operation has touched (via `withCdpTab`). A
 * per-operation timeout detaches exactly these tabs instead of the whole
 * bridge, so a hung action in one session can't destroy other sessions'
 * attachments and network captures.
 */
let activeDirectOperationTabIds: Set<number> | null = null;
let detachInProgress: Promise<void> | undefined;
const DIRECT_OPERATION_TIMEOUT_MS = 55_000;

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
 * Fan a CDP event out from the real tab. Every attached tab delivers to the
 * direct subscribers (`subscribeCdpEvents`) — with no raw `/cdp` client
 * connected (the dominant WebBridge mode) this is the only delivery path for
 * network-capture and navigate-lifecycle events. Only the raw client's own
 * attached tab is additionally forwarded to the daemon socket.
 */
function onDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params?: object,
): void {
  if (source.tabId === undefined || !attachedTabIds.has(source.tabId)) return;
  const eventParams = (params ?? {}) as Record<string, unknown>;
  for (const listener of directEventListeners) {
    listener(method, eventParams, source.tabId);
  }
  if (!activeSend || source.tabId !== rawTabId) return;
  activeSend({
    type: 'cdp_event',
    method,
    params: eventParams,
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
  if (source.tabId === undefined || !attachedTabIds.has(source.tabId)) return;
  if (attaching && source.tabId === attachingTabId) {
    releaseRequestedDuringAttach = true;
  }
  console.log(LOG_PREFIX, 'debugger detached:', reason);
  attachedTabIds.delete(source.tabId);
  directTabIds.delete(source.tabId);
  for (const listener of directDetachListeners) listener(source.tabId);
  if (activeSend && source.tabId === rawTabId) {
    activeSend({ type: 'cdp_detach', reason: reason || 'target_closed' });
    activeSend = null;
    rawTabId = null;
  }
  if (attachedTabIds.size === 0) teardownAttachments();
}

/** Remove debugger listeners and forget all attached tabs. */
function teardownAttachments(): void {
  stopAttachKeepalive();
  try {
    chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    chrome.debugger.onDetach.removeListener(onDebuggerDetach);
  } catch {
    /* listeners already gone */
  }
  attachedTabIds.clear();
  directTabIds.clear();
  rawTabId = null;
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
  direct = false,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let expired = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (direct) pendingDirectCommands.delete(pending);
      complete();
    };
    const pending = {
      expire: () => {
        expired = true;
      },
      cancel: (error: Error) => finish(() => reject(error)),
    };
    if (direct) pendingDirectCommands.add(pending);
    try {
      chrome.debugger.sendCommand(
        { tabId },
        method,
        params ?? {},
        (result?: object) => {
          if (expired) return;
          const err = chrome.runtime.lastError;
          finish(() =>
            err
              ? reject(new Error(err.message ?? 'CDP command failed'))
              : resolve(result ?? {}),
          );
        },
      );
    } catch (error) {
      finish(() =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    }
  });
}

async function attachTab(tabId: number): Promise<void> {
  if (attachedTabIds.has(tabId)) return;
  const generation = attachGeneration;

  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION, () => {
      const error = chrome.runtime.lastError;
      const ownAlreadyAttached =
        /already attached/i.test(error?.message ?? '') &&
        attachedTabIds.has(tabId);
      if (error && !ownAlreadyAttached) {
        reject(new Error(error.message ?? 'debugger attach failed'));
        return;
      }
      resolve();
    });
  });

  if (generation !== attachGeneration) {
    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => resolve());
    });
    throw new Error('released during attach');
  }

  if (attachedTabIds.size === 0) {
    chrome.debugger.onEvent.addListener(onDebuggerEvent);
    chrome.debugger.onDetach.addListener(onDebuggerDetach);
  }
  attachedTabIds.add(tabId);
  startAttachKeepalive();
}

async function runDirectBrowserOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (directOperationActive) {
    throw new Error('WebBridge action is already in progress');
  }
  if (detachingTabIds.size > 0) {
    throw new Error('CDP tunnel is releasing the browser');
  }
  if (activeSend || attaching) {
    throw new Error('CDP tunnel is currently controlling the browser');
  }
  directOperationActive = true;
  activeDirectOperationTabIds = new Set<number>();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      const error = new Error('WebBridge action timed out after 55s');
      error.name = 'WebBridgeTimeoutError';
      timeout = setTimeout(() => {
        void detachDirectOperationTabs(error);
        reject(error);
      }, DIRECT_OPERATION_TIMEOUT_MS);
    });
    const operationPromise = operation();
    // The timeout teardown cancels pending CDP commands, which rejects the
    // operation promise AFTER the race has settled on the timeout error;
    // without a handler that late rejection becomes unhandled. The guard
    // catch only marks it handled — the race still observes a rejection
    // that lands before the timeout.
    operationPromise.catch(() => {});
    return await Promise.race([operationPromise, timedOut]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    directOperationActive = false;
    activeDirectOperationTabIds = null;
  }
}

export function withDirectBrowserAction<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return runDirectBrowserOperation(operation);
}

export function withCdpTab<T>(
  tabId: number,
  operation: (send: CdpCommand) => Promise<T>,
): Promise<T> {
  const run = async () => {
    activeDirectOperationTabIds?.add(tabId);
    await attachTab(tabId);
    directTabIds.add(tabId);
    return operation((method, params) =>
      sendDebuggerCommand(tabId, method, params, true),
    );
  };
  // Whole WebBridge actions already hold this reservation.
  return directOperationActive ? run() : runDirectBrowserOperation(run);
}

export function subscribeCdpEvents(listener: CdpEventListener): () => void {
  directEventListeners.add(listener);
  return () => directEventListeners.delete(listener);
}

export function subscribeCdpDetaches(listener: CdpDetachListener): () => void {
  directDetachListeners.add(listener);
  return () => directDetachListeners.delete(listener);
}

export async function releaseCdpTab(tabId: number): Promise<void> {
  directTabIds.delete(tabId);
  if (rawTabId === tabId || !attachedTabIds.has(tabId)) return;
  detachingTabIds.add(tabId);
  try {
    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    attachedTabIds.delete(tabId);
    if (attachedTabIds.size === 0) teardownAttachments();
  } finally {
    detachingTabIds.delete(tabId);
  }
}

/** Handle a `cdp_attach` frame: attach the active tab and ack. */
async function handleAttach(
  frame: CdpAttachFrame,
  send: CdpSend,
): Promise<void> {
  if (detachingTabIds.size > 0) {
    send({
      type: 'cdp_attached',
      id: frame.id,
      error: { message: 'CDP tunnel is releasing the browser' },
    });
    return;
  }
  if (directOperationActive || directTabIds.size > 0) {
    send({
      type: 'cdp_attached',
      id: frame.id,
      error: { message: 'WebBridge is currently controlling the browser' },
    });
    return;
  }
  // Reentrancy guard: handleAttach awaits twice (attach + tabs.get) and is
  // dispatched fire-and-forget. Only one puppeteer client binds today, but the
  // guard keeps the next caller safe.
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
    attachingTabId = tabId;

    if (rawTabId !== null && rawTabId !== tabId) {
      const previousTabId = rawTabId;
      rawTabId = null;
      activeSend = null;
      if (!directTabIds.has(previousTabId)) {
        await releaseCdpTab(previousTabId);
      }
    }

    await attachTab(tabId);

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

    activeSend = send;
    rawTabId = tabId;
    console.log(LOG_PREFIX, 'attached tab', tabId);
    send({ type: 'cdp_attached', id: frame.id, url, title });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(LOG_PREFIX, 'attach failed:', message);
    send({ type: 'cdp_attached', id: frame.id, error: { message } });
  } finally {
    attaching = false;
    attachingTabId = null;
    releaseRequestedDuringAttach = false;
  }
}

/**
 * Handle a `cdp_command` frame: run it on the attached tab and reply.
 *
 * TRUST MODEL — deliberately NO method allowlist: an external CDP MCP adapter
 * drives the tab over the full CDP surface, so any allowlist would break tools.
 * Arbitrary-CDP exposure (incl. `Runtime.evaluate`) is bounded by the CHANNEL,
 * not the payload: the daemon `/cdp` endpoint is loopback-only, the daemon binds
 * the reverse link only to the `qwen-cdp-bridge` connection, and Chrome shows
 * its "started debugging this browser" banner. Keep this a transparent forwarder.
 */
async function handleCommand(
  frame: CdpCommandFrame,
  send: CdpSend,
): Promise<void> {
  if (rawTabId === null) {
    send({
      type: 'cdp_result',
      id: frame.id,
      error: { code: -32000, message: 'CDP tunnel not attached to a tab' },
    });
    return;
  }
  try {
    const result = await sendDebuggerCommand(
      rawTabId,
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
 * disconnected, so release its debugger ownership and stop forwarding while
 * preserving tabs still used by direct WebBridge actions.
 */
function handleRelease(_frame: CdpReleaseFrame): void {
  console.log(LOG_PREFIX, 'cdp_release received; releasing raw tunnel');
  if (attaching) releaseRequestedDuringAttach = true;
  const tabId = rawTabId;
  rawTabId = null;
  activeSend = null;
  if (tabId !== null && !directTabIds.has(tabId)) void releaseCdpTab(tabId);
}

/**
 * Route one inbound `cdp_*` frame from the daemon. The caller filters with
 * {@link isCdpBridgeFrame} first. `send` pushes outbound frames down the same
 * socket; it is recorded as the active sink so events/detach reach the daemon.
 */
export function handleCdpFrame(frame: { type?: unknown }, send: CdpSend): void {
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
async function detachDirectOperationTabs(error: Error): Promise<void> {
  const tabIds = [...(activeDirectOperationTabIds ?? [])].filter((tabId) =>
    attachedTabIds.has(tabId),
  );
  for (const pending of pendingDirectCommands) pending.expire();
  if (tabIds.length === 0) {
    // Nothing left to detach (the tab may already be gone), but pending
    // commands must still be cancelled so their promises settle instead
    // of hanging forever.
    for (const pending of [...pendingDirectCommands]) pending.cancel(error);
    return;
  }
  for (const tabId of tabIds) {
    for (const listener of directDetachListeners) listener(tabId);
  }
  const pendingDetaches: Array<Promise<void>> = [];
  for (const tabId of tabIds) {
    attachedTabIds.delete(tabId);
    directTabIds.delete(tabId);
    if (detachingTabIds.has(tabId)) continue;
    detachingTabIds.add(tabId);
    pendingDetaches.push(
      new Promise<void>((resolve) => {
        const done = () => {
          void chrome.runtime.lastError;
          detachingTabIds.delete(tabId);
          resolve();
        };
        try {
          chrome.debugger.detach({ tabId }, done);
        } catch {
          done();
        }
      }),
    );
  }
  await Promise.all(pendingDetaches);
  if (attachedTabIds.size === 0) teardownAttachments();
  for (const pending of [...pendingDirectCommands]) pending.cancel(error);
}

function detachCdpBridge(error: Error): Promise<void> {
  for (const pending of pendingDirectCommands) pending.expire();
  detachInProgress ??= performCdpDetach(error).finally(() => {
    detachInProgress = undefined;
  });
  return detachInProgress;
}

async function performCdpDetach(error: Error): Promise<void> {
  attachGeneration++;
  // A release that races an in-flight handleAttach can't detach a tab the
  // debugger hasn't attached to yet. Record it so handleAttach tears down the
  // moment it finishes wiring up instead of leaving an attachment behind.
  if (attaching) {
    releaseRequestedDuringAttach = true;
  }
  const tabIds = [...attachedTabIds];
  for (const tabId of tabIds) {
    for (const listener of directDetachListeners) listener(tabId);
  }
  teardownAttachments();
  activeSend = null;
  const pendingDetaches: Array<Promise<void>> = [];
  for (const tabId of tabIds) {
    if (detachingTabIds.has(tabId)) continue;
    detachingTabIds.add(tabId);
    pendingDetaches.push(
      new Promise<void>((resolve) => {
        const done = () => {
          void chrome.runtime.lastError;
          detachingTabIds.delete(tabId);
          resolve();
        };
        try {
          chrome.debugger.detach({ tabId }, done);
        } catch {
          done();
        }
      }),
    );
  }
  await Promise.all(pendingDetaches);
  for (const pending of [...pendingDirectCommands]) pending.cancel(error);
}

export function shutdownCdpBridge(): void {
  void detachCdpBridge(new Error('CDP bridge shut down'));
}
