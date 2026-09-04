/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * CDP browser-level emulation layer for the Plan C "CDP tunnel" (issue #5626).
 *
 * A CDP client connects to the daemon's `/cdp`
 * WebSocket expecting a browser-level CDP endpoint, but behind the tunnel is a
 * single real tab driven via `chrome.debugger` (page-level only). This class
 * synthesizes the missing browser-level topology so puppeteer connects and gets
 * one page:
 *
 *   - a two-level `tab` -> `page` target tree, and
 *   - the recursive `Target.setAutoAttach` handshake puppeteer's
 *     `ExtensionTransport` relies on.
 *
 * Browser-domain commands are answered locally; page-domain commands (tagged
 * with the page session id) are forwarded to the real tab via
 * {@link CdpEmulatorCallbacks.forwardToTab}, and tab events are re-tagged with
 * the page session id on the way back via {@link CdpBrowserEmulator.emitTabEvent}.
 *
 * See `packages/chrome-extension/docs/06-plan-c-cdp-tunnel.md`.
 */

/** A CDP JSON-RPC frame on the wire (either direction). */
export interface CdpFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Hooks the tunnel wires into the emulator. */
export interface CdpEmulatorCallbacks {
  /** Send a CDP reply or event back to the puppeteer client. */
  reply(frame: CdpFrame): void;
  /** Optional diagnostic sink (e.g. unhandled browser-level CDP commands). */
  log?(line: string): void;
  /**
   * Run a page-domain command on the real tab (reverse WS -> extension
   * `chrome.debugger.sendCommand`). Resolves with the CDP `result`, or rejects
   * with a `{ code, message }`-shaped error.
   */
  forwardToTab(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown>;
}

/** Stable synthetic ids for the single tab/page this tunnel exposes. */
const TAB_TARGET_ID = 'qwen-cdp-tab';
const PAGE_TARGET_ID = 'qwen-cdp-page';
const TAB_SESSION_ID = 'qwen-cdp-tab-session';
const PAGE_SESSION_ID = 'qwen-cdp-page-session';
// Must match CDP_PROTOCOL_VERSION in packages/chrome-extension/src/background/cdp-bridge.ts.
const CDP_PROTOCOL_VERSION = '1.3';

/** CDP error code for "command failed" (matches Chrome's generic server error). */
const SERVER_ERROR = -32000;

export interface CdpTabInfo {
  /** Current URL of the real tab (best-effort; refined once the page loads). */
  url?: string;
  /** Current title of the real tab. */
  title?: string;
}

export class CdpBrowserEmulator {
  private readonly attachedPageSessions = new Set<string>();
  private nextPageSessionId = 1;
  private autoAttachActive = false;
  private pageSessionDetached = false;
  private droppedTabEvents = 0;

  constructor(
    private readonly cb: CdpEmulatorCallbacks,
    private tab: CdpTabInfo = {},
  ) {}

  /**
   * Refresh the synthetic tab/page targetInfo (url/title) once the extension
   * acks `cdp_attach`, so puppeteer's `page.url()`/`page.title()` reflect the
   * real page rather than the `about:blank` placeholder used before attach.
   */
  setTabInfo(info: CdpTabInfo): void {
    this.tab = { ...this.tab, ...info };
  }

  private tabTargetInfo() {
    return {
      targetId: TAB_TARGET_ID,
      type: 'tab',
      title: this.tab.title ?? 'tab',
      url: this.tab.url ?? 'about:blank',
      attached: false,
      canAccessOpener: false,
    };
  }

  private pageTargetInfo() {
    return {
      targetId: PAGE_TARGET_ID,
      type: 'page',
      title: this.tab.title ?? 'page',
      url: this.tab.url ?? 'about:blank',
      attached: false,
      canAccessOpener: false,
    };
  }

  /**
   * Handle one frame from the puppeteer client. Browser/tab-domain frames are
   * answered locally; page-session frames are forwarded to the real tab.
   */
  async handleFromClient(frame: CdpFrame): Promise<void> {
    const { id, method, params, sessionId } = frame;

    // ── browser-level (no sessionId): synthesize the browser topology ──
    if (!sessionId) {
      switch (method) {
        case 'Browser.getVersion':
          return this.cb.reply({
            id,
            result: {
              protocolVersion: CDP_PROTOCOL_VERSION,
              product: 'QwenCDPTunnel/1.0',
              revision: '@qwen',
              userAgent: 'QwenCDPTunnel',
              jsVersion: 'unknown',
            },
          });
        case 'Target.getBrowserContexts':
          return this.cb.reply({ id, result: { browserContextIds: [] } });
        case 'Target.setDiscoverTargets':
          this.cb.reply({
            method: 'Target.targetCreated',
            params: { targetInfo: this.tabTargetInfo() },
          });
          this.cb.reply({
            method: 'Target.targetCreated',
            params: { targetInfo: this.pageTargetInfo() },
          });
          return this.cb.reply({ id, result: {} });
        case 'Target.setAutoAttach':
          // browser level attaches the tab session (the page session is
          // attached on the recursive setAutoAttach against the tab session).
          this.cb.reply({
            method: 'Target.attachedToTarget',
            params: {
              targetInfo: this.tabTargetInfo(),
              sessionId: TAB_SESSION_ID,
              waitingForDebugger: false,
            },
          });
          return this.cb.reply({ id, result: {} });
        case 'Target.getTargets':
          return this.cb.reply({
            id,
            result: {
              targetInfos: [this.tabTargetInfo(), this.pageTargetInfo()],
            },
          });
        case 'Target.getTargetInfo':
          return this.cb.reply({
            id,
            result: { targetInfo: this.pageTargetInfo() },
          });
        case 'Target.getDevToolsTarget':
          // Known and deliberately unsupported: the tunnel exposes a single real
          // tab, not a DevTools frontend target, so there is nothing to return.
          // Handled explicitly (not via `default:`) so the empty ack is not
          // logged as an unsupported-method coverage gap.
          return this.cb.reply({ id, result: {} });
        case 'Target.attachToTarget': {
          const targetId = params?.['targetId'];
          if (targetId !== PAGE_TARGET_ID) {
            return this.cb.reply({
              id,
              error: {
                code: SERVER_ERROR,
                message: `Cannot attach to target: ${String(targetId)}`,
              },
            });
          }
          const attachedSessionId = `qwen-cdp-page-session-${this.nextPageSessionId++}`;
          this.attachedPageSessions.add(attachedSessionId);
          this.cb.reply({
            method: 'Target.attachedToTarget',
            params: {
              targetInfo: this.pageTargetInfo(),
              sessionId: attachedSessionId,
              waitingForDebugger: false,
            },
          });
          return this.cb.reply({
            id,
            result: { sessionId: attachedSessionId },
          });
        }
        case 'Target.detachFromTarget': {
          const attachedSessionId = params?.['sessionId'];
          if (attachedSessionId === PAGE_SESSION_ID) {
            // The auto-attach session is only live after the tab-session
            // handshake; detaching it stops event delivery and reports the
            // teardown, so a client that switches to explicit-attach-only mode
            // does not keep receiving events on a session it believes is gone.
            if (this.autoAttachActive) {
              this.autoAttachActive = false;
              this.pageSessionDetached = true;
              this.cb.reply({
                method: 'Target.detachedFromTarget',
                params: {
                  sessionId: PAGE_SESSION_ID,
                  targetId: PAGE_TARGET_ID,
                },
              });
            }
            // Without a prior handshake the session was never announced, so
            // there is no detachedFromTarget to emit, and PAGE_SESSION_ID
            // stays a valid lazy-attach command route (cdp-reverse-link.ts).
            // Deliberately asymmetric with the auto-attach path, where detach
            // ends both events and commands: see the setAutoAttach note.
          } else if (
            typeof attachedSessionId === 'string' &&
            this.attachedPageSessions.delete(attachedSessionId)
          ) {
            this.cb.reply({
              method: 'Target.detachedFromTarget',
              params: {
                sessionId: attachedSessionId,
                targetId: PAGE_TARGET_ID,
              },
            });
          } else {
            return this.cb.reply({
              id,
              error: {
                code: SERVER_ERROR,
                message: `Unknown CDP session: ${String(attachedSessionId)}`,
              },
            });
          }
          return this.cb.reply({ id, result: {} });
        }
        default:
          // TODO(#5626): return SERVER_ERROR once the emulator covers every
          // browser-level command a CDP client sends. Until then the
          // empty-result ack keeps puppeteer from hanging on optional commands;
          // surface the unknown ones so the coverage gap stays visible.
          this.cb.log?.(
            `qwen serve: /cdp unsupported browser-level CDP method: ${method ?? '(none)'}`,
          );
          return this.cb.reply({ id, result: {} });
      }
    }

    // ── tab session: recursive auto-attach mints the page session ──
    if (sessionId === TAB_SESSION_ID) {
      if (method === 'Target.setAutoAttach') {
        this.autoAttachActive = params?.['autoAttach'] !== false;
        // autoAttach:false pauses event delivery on PAGE_SESSION_ID but keeps
        // its command forwarding alive (lazy-attach compat); only
        // detachFromTarget ends both.
        if (this.autoAttachActive) {
          this.pageSessionDetached = false;
          this.cb.reply({
            method: 'Target.attachedToTarget',
            sessionId: TAB_SESSION_ID,
            params: {
              targetInfo: this.pageTargetInfo(),
              sessionId: PAGE_SESSION_ID,
              waitingForDebugger: false,
            },
          });
        }
        return this.cb.reply({ id, sessionId, result: {} });
      }
      // ack other tab-session commands (e.g. Runtime.runIfWaitingForDebugger).
      return this.cb.reply({ id, sessionId, result: {} });
    }

    // ── page session: forward to the real tab via the extension ──
    // PAGE_SESSION_ID forwarding works without a prior setAutoAttach handshake
    // because the lazy-attach path (cdp-reverse-link.ts) sends page commands
    // directly. After an explicit detachFromTarget the session is rejected,
    // matching Chrome's "Unknown session" behavior.
    if (sessionId === PAGE_SESSION_ID && this.pageSessionDetached) {
      return this.cb.reply({
        id,
        sessionId,
        error: {
          code: SERVER_ERROR,
          message: `Unknown CDP session: ${sessionId}`,
        },
      });
    }
    if (
      sessionId === PAGE_SESSION_ID ||
      this.attachedPageSessions.has(sessionId)
    ) {
      try {
        const result = await this.cb.forwardToTab(method ?? '', params);
        return this.cb.reply({ id, sessionId, result });
      } catch (err) {
        const e = err as { code?: number; message?: string; data?: unknown };
        return this.cb.reply({
          id,
          sessionId,
          error: {
            code: e.code ?? SERVER_ERROR,
            message: e.message ?? 'CDP forward failed',
            data: e.data,
          },
        });
      }
    }

    // unknown session — return a CDP error rather than a fake-success `{}`, so a
    // command to a stale/unrecognized session surfaces instead of silently
    // no-op'ing (which puppeteer would read as success with no effect).
    return this.cb.reply({
      id,
      sessionId,
      error: {
        code: SERVER_ERROR,
        message: `Unknown CDP session: ${sessionId ?? '(none)'}`,
      },
    });
  }

  /**
   * Re-emit a CDP event that arrived from the real tab (via the extension) on
   * every page session this tunnel has minted: the auto-attach `PAGE_SESSION_ID`
   * plus each session created by an explicit `Target.attachToTarget`.
   *
   * This mirrors Chrome's per-session delivery — each attachment is an
   * independent subscription that gets its own copy of the page's events. The
   * auto-attach session only receives events after the `Target.setAutoAttach`
   * handshake on the tab session, so a client that uses only explicit
   * `Target.attachToTarget` does not pay for a duplicate stream it never
   * listens to. A client that deliberately attached twice would see an event
   * twice, exactly as it would against a real browser.
   */
  emitTabEvent(
    method: string,
    params: Record<string, unknown> | undefined,
  ): void {
    if (this.autoAttachActive) {
      this.cb.reply({ method, params, sessionId: PAGE_SESSION_ID });
    }
    for (const sessionId of this.attachedPageSessions) {
      this.cb.reply({ method, params, sessionId });
    }
    if (!this.autoAttachActive && this.attachedPageSessions.size === 0) {
      this.droppedTabEvents += 1;
      // A one-shot warning hides mid-session regressions; re-log periodically
      // with a running total so the drop stream stays diagnosable.
      if (this.droppedTabEvents === 1 || this.droppedTabEvents % 100 === 0) {
        this.cb.log?.(
          `qwen serve: /cdp tab event "${method}" dropped (${this.droppedTabEvents} total) — no active page session (lazy-attach clients are command-only until Target.setAutoAttach)`,
        );
      }
    }
  }
}
