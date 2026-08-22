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
 * Single tab, single debugger — but since issue #8737 several `/cdp` clients
 * (links, tagged by `linkId`) share that one debugger attachment: every link
 * that attaches refcounts the attachment, results/acks echo the requesting
 * link, and `cdp_release` detaches only when the last link lets go. Events are
 * broadcast because every client sees the same page; detach notices go only
 * to links that held the detached tab. Frames without a `linkId` (old daemon)
 * map to the default link and keep the legacy single-client behavior.
 *
 * See `packages/chrome-extension/docs/06-plan-c-cdp-tunnel.md`.
 */

/* global chrome, console, setInterval, clearInterval */

const LOG_PREFIX = '[CdpBridge]';

/** CDP attach protocol version (matches the network tools). */
const CDP_PROTOCOL_VERSION = '1.3';

/**
 * Link id for frames from a daemon that predates multi-client routing
 * (no `linkId` on frames). Behaves exactly like the legacy single client.
 */
const DEFAULT_LINK_ID = '';

/** Inbound `cdp_command` frame (daemon → extension). */
interface CdpCommandFrame {
  type: 'cdp_command';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  /** Owning `/cdp` link; echoed back on the `cdp_result`. */
  linkId?: string;
}

/** Inbound `cdp_attach` frame (daemon → extension). */
interface CdpAttachFrame {
  type: 'cdp_attach';
  id: number;
  /** Owning `/cdp` link; absent on legacy daemons (→ DEFAULT_LINK_ID). */
  linkId?: string;
}

/**
 * Inbound `cdp_release` frame (daemon → extension): one `/cdp` puppeteer
 * client disconnected, so drop its attachment ref; detach the debugger when
 * the last link releases (or immediately for a legacy untagged release).
 */
interface CdpReleaseFrame {
  type: 'cdp_release';
  linkId?: string;
}

/** Any outbound `cdp_*` frame (extension → daemon). */
type CdpOutbound =
  | {
      type: 'cdp_result';
      id: number;
      result?: unknown;
      error?: { code?: number; message?: string };
      linkId?: string;
    }
  | { type: 'cdp_event'; method: string; params?: Record<string, unknown> }
  | {
      type: 'cdp_attached';
      id: number;
      url?: string;
      title?: string;
      error?: { message: string };
      linkId?: string;
    }
  | { type: 'cdp_detach'; reason: string; linkId?: string };

/** Sink that pushes one outbound frame down the daemon `/acp` socket. */
type CdpSend = (frame: CdpOutbound) => void;

/** The tab id this bridge currently has the debugger attached to (or null). */
let attachedTabId: number | null = null;
/** The active outbound sink while a `/cdp` puppeteer client is connected. */
let activeSend: CdpSend | null = null;
/** While set, keeps the MV3 worker awake during an attachment (see startAttachKeepalive). */
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Links (`/cdp` puppeteer clients, by `linkId`) currently holding a ref on the
 * debugger attachment. Empty when nothing is attached.
 */
let attachedLinks = new Set<string>();
/**
 * Shared in-flight attach: concurrent `cdp_attach` frames join the same
 * chrome.debugger.attach instead of interleaving attach/teardown (the old
 * reentrancy hazard) and refcount the single resulting attachment.
 */
let attachInFlight: Promise<{ url?: string; title?: string }> | null = null;
let attachOwnerLinkId: string | null = null;
/**
 * Links whose `cdp_attach` is part of the in-flight flow (owner + joiners),
 * registered synchronously at frame arrival. `handleRelease` records deferred
 * releases only for these: a previously-landed link evicted by a tab-switch
 * set replacement has its handleAttach long completed and must not plant a
 * stale `releasedDuringAttach` entry.
 */
let inFlightParticipants = new Set<string>();
/**
 * Links whose `cdp_release` (or socket close) arrived while their attach was
 * mid-flight. A teardown that fires before the attach lands can't detach a
 * tab the debugger isn't on yet, so it records the link here; the attach
 * honors it the moment it finishes wiring up. Without this, the late attach
 * would leave a debugger attachment with no live `/cdp` client behind it.
 */
let releasedDuringAttach = new Set<string>();
/**
 * A full bridge teardown (`shutdownCdpBridge`) raced an in-flight attach.
 * Every link joining that attach honors it the same way as a per-link
 * release; cleared when the next fresh attach starts.
 */
let bridgeGeneration = 0;

function linkIdOf(frame: { linkId?: unknown }): string {
  return typeof frame.linkId === 'string' ? frame.linkId : DEFAULT_LINK_ID;
}

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

function ensureAttachObservers(): void {
  chrome.debugger.onEvent.removeListener(onDebuggerEvent);
  chrome.debugger.onDetach.removeListener(onDebuggerDetach);
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.debugger.onDetach.addListener(onDebuggerDetach);
  startAttachKeepalive();
}

/** Whether a frame `type` is one this bridge owns (daemon → extension). */
export function isCdpBridgeFrame(type: unknown): boolean {
  return (
    type === 'cdp_command' || type === 'cdp_attach' || type === 'cdp_release'
  );
}

/**
 * Forward a CDP event from the real tab to the daemon. Only events for the
 * currently-attached tab are forwarded. The daemon broadcasts the event to
 * every bound `/cdp` link (one shared tab → every client sees the same page).
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
 * page crashed, or we detached). Notify the links that held this attachment,
 * then drop it.
 */
function onDebuggerDetach(
  source: chrome.debugger.Debuggee,
  reason: string,
): void {
  if (attachedTabId === null || source.tabId !== attachedTabId) return;
  console.log(LOG_PREFIX, 'debugger detached:', reason);
  notifyAttachedLinksOfDetach(reason || 'target_closed');
  teardownAttachment();
}

function notifyAttachedLinksOfDetach(reason: string): void {
  notifyLinksOfDetach(attachedLinks, reason);
}

function notifyLinksOfDetach(links: Set<string>, reason: string): void {
  if (!activeSend) return;
  for (const linkId of links) {
    activeSend({
      type: 'cdp_detach',
      reason,
      ...(linkId !== DEFAULT_LINK_ID ? { linkId } : {}),
    });
  }
}

/** Remove our debugger listeners and forget the attached tab and all links. */
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
  attachedLinks = new Set();
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

/** Best-effort tab metadata for the daemon's synthetic targetInfo. */
async function tabInfoOf(
  tabId: number,
): Promise<{ url?: string; title?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url, title: tab.title };
  } catch {
    return {};
  }
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

/**
 * Attach `chrome.debugger` to a tab, or join the attachment already owned by
 * other links. Returns tab metadata for the daemon's synthetic targetInfo.
 *
 * The in-flight flow is registered SYNCHRONOUSLY at entry (before any await),
 * so back-to-back `cdp_attach` frames always join one shared flow instead of
 * each starting their own chrome.debugger.attach.
 */
function ensureAttachment(
  linkId: string,
): Promise<{ url?: string; title?: string }> {
  const inFlight = attachInFlight;
  if (inFlight) {
    inFlightParticipants.add(linkId);
    // Join the attachment another link is establishing; add our ref once it
    // lands (a rejection propagates to our caller's error ack as well). A
    // detach can land between the flow resolving and this microtask; never
    // ref a dead attachment.
    return inFlight.then((info) => {
      if (attachedTabId === null) {
        throw new Error('debugger detached during attach');
      }
      attachedLinks.add(linkId);
      return info;
    });
  }
  attachOwnerLinkId = linkId;
  inFlightParticipants = new Set([linkId]);
  const flow = runAttachFlow(linkId);
  attachInFlight = flow;
  return flow;
}

async function runAttachFlow(
  linkId: string,
): Promise<{ url?: string; title?: string }> {
  try {
    const tabId = await getActiveTabId();

    // Already attached to exactly this tab: just refcount, no debugger churn.
    if (attachedTabId === tabId) {
      attachedLinks.add(linkId);
      ensureAttachObservers();
      const info = await tabInfoOf(tabId);
      // A debugger detach (banner Cancel / DevTools / tab close) or a full
      // teardown can land during the metadata fetch; acking success there
      // would leave every link on a dead attachment.
      if (attachedTabId !== tabId) {
        throw new Error('debugger detached during attach');
      }
      return info;
    }

    const prevTabId = attachedTabId;
    const prevLinks = attachedLinks;

    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION, () => {
        const err = chrome.runtime.lastError;
        // "Already attached" is only benign when WE already own this exact
        // tab. Chrome reports the same error when DevTools / another debugger
        // owns it — acking success there would let us claim a tab we can't
        // drive.
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

    attachedTabId = tabId;
    attachedLinks = new Set([linkId]);
    if (prevTabId !== null && prevTabId !== tabId) {
      notifyLinksOfDetach(prevLinks, 'target_switched');
      await new Promise<void>((resolve) => {
        chrome.debugger.detach({ tabId: prevTabId }, () => {
          void chrome.runtime.lastError; // best-effort; tab may already be gone
          resolve();
        });
      });
    }
    if (attachedTabId !== tabId) {
      throw new Error('debugger detached during attach');
    }
    ensureAttachObservers();

    const info = await tabInfoOf(tabId);
    if (attachedTabId !== tabId) {
      throw new Error('debugger detached during attach');
    }
    return info;
  } finally {
    attachOwnerLinkId = null;
    attachInFlight = null;
    inFlightParticipants = new Set();
  }
}

/** Handle a `cdp_attach` frame: attach (or join) the active tab and ack. */
async function handleAttach(
  frame: CdpAttachFrame,
  send: CdpSend,
): Promise<void> {
  const linkId = linkIdOf(frame);
  const generation = bridgeGeneration;
  try {
    const { url, title } = await ensureAttachment(linkId);

    // A cdp_release (or full teardown) that arrived while this link's attach
    // was awaiting couldn't tear down an attachment that hadn't landed yet.
    // Now that it has, honor that release immediately so we never leak a
    // debugger attachment with no live `/cdp` client.
    if (
      generation !== bridgeGeneration ||
      releasedDuringAttach.delete(linkId)
    ) {
      console.log(
        LOG_PREFIX,
        'release arrived during attach; dropping link',
        linkId || '(default)',
      );
      attachedLinks.delete(linkId);
      // Ack the attach (as an error) before tearing down: the daemon's reverse
      // link is awaiting a `cdp_attached` for this id, so without it the
      // puppeteer client hangs until the ~170s CDP command timeout.
      send({
        type: 'cdp_attached',
        id: frame.id,
        error: { message: 'released during attach' },
        ...(frame.linkId !== undefined ? { linkId: frame.linkId } : {}),
      });
      if (attachedLinks.size === 0) {
        queueMicrotask(() => {
          if (attachedLinks.size === 0) shutdownCdpBridge();
        });
      }
      return;
    }

    console.log(
      LOG_PREFIX,
      'link',
      linkId || '(default)',
      'attached; links =',
      attachedLinks.size,
    );
    send({
      type: 'cdp_attached',
      id: frame.id,
      url,
      title,
      ...(frame.linkId !== undefined ? { linkId: frame.linkId } : {}),
    });
  } catch (e) {
    releasedDuringAttach.delete(linkId);
    if (attachedLinks.size === 0 && attachedTabId !== null) {
      shutdownCdpBridge();
    }
    const message = e instanceof Error ? e.message : String(e);
    console.warn(LOG_PREFIX, 'attach failed:', message);
    send({
      type: 'cdp_attached',
      id: frame.id,
      error: { message },
      ...(frame.linkId !== undefined ? { linkId: frame.linkId } : {}),
    });
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
  const linkTag = frame.linkId !== undefined ? { linkId: frame.linkId } : {};
  if (attachedTabId === null) {
    send({
      type: 'cdp_result',
      id: frame.id,
      error: { code: -32000, message: 'CDP tunnel not attached to a tab' },
      ...linkTag,
    });
    return;
  }
  try {
    const result = await sendDebuggerCommand(
      attachedTabId,
      frame.method,
      frame.params,
    );
    send({ type: 'cdp_result', id: frame.id, result, ...linkTag });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    send({
      type: 'cdp_result',
      id: frame.id,
      error: { code: -32000, message },
      ...linkTag,
    });
  }
}

/**
 * Handle a `cdp_release` frame: one `/cdp` puppeteer client disconnected.
 * Drop the link's ref on the shared debugger attachment; detach only when the
 * last link releases (a legacy untagged release tears down immediately).
 */
function handleRelease(frame: CdpReleaseFrame): void {
  const linkId = linkIdOf(frame);
  if (attachInFlight) {
    if (attachedLinks.has(linkId)) {
      // Already landed: drop the ref now. Only the current attach owner still
      // needs a deferred release; recording any other landed link would leave
      // a stale entry because its handleAttach has already completed.
      attachedLinks.delete(linkId);
      if (attachOwnerLinkId === linkId) {
        releasedDuringAttach.add(linkId);
      }
      console.log(
        LOG_PREFIX,
        'cdp_release for landed link during attach',
        linkId || '(default)',
        '; remaining links =',
        attachedLinks.size,
      );
      return;
    }
    // Not landed yet — but only links participating in the in-flight flow
    // (owner or joiner) have a pending handleAttach. A previously-landed
    // link evicted by a tab-switch set replacement completed long ago;
    // recording it would plant a stale ledger entry that spuriously rejects
    // the link's next attach.
    if (inFlightParticipants.has(linkId)) {
      releasedDuringAttach.add(linkId);
    }
    return;
  }
  attachedLinks.delete(linkId);
  console.log(
    LOG_PREFIX,
    'cdp_release for link',
    linkId || '(default)',
    '; remaining links =',
    attachedLinks.size,
  );
  if (attachedLinks.size === 0) {
    shutdownCdpBridge();
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
  } else if (frame.type === 'cdp_release') {
    handleRelease(frame as CdpReleaseFrame);
  }
}

/**
 * Tear down the bridge: detach the debugger and stop forwarding. Called when
 * the daemon socket closes (or the last link releases) so a stale attachment
 * doesn't linger. Idempotent.
 */
export function shutdownCdpBridge(): void {
  // A teardown that races an in-flight attach can't detach a tab the debugger
  // hasn't attached to yet (attachedTabId is still null, listeners aren't
  // registered). Flag it so every link joining that attach drops itself the
  // moment wiring finishes — and the last one detaches — instead of leaving a
  // debugger attachment with no live `/cdp` client behind it.
  if (attachInFlight) {
    bridgeGeneration++;
  }
  stopAttachKeepalive();
  releasedDuringAttach = new Set();
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
