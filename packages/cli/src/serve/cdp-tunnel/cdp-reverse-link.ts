/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reverse link for the Plan C "CDP tunnel" (issue #5626).
 *
 * Bridges a {@link CdpBrowserEmulator} (browser-level CDP to a puppeteer client
 * over `/cdp`) to the Chrome extension's reverse `/acp` WebSocket. Page-domain
 * commands the emulator can't answer are forwarded to the real tab as
 * `cdp_command` frames; the extension runs them and replies with `cdp_result`,
 * and tab `cdp_event`s are re-tagged onto the page session by the emulator.
 *
 * One link is bound to ONE extension `/acp` connection (single daemon = single
 * extension = single browser). The `/acp` WS layer owns the socket and feeds
 * inbound `cdp_*` frames back into the link.
 *
 * See `packages/chrome-extension/docs/06-plan-c-cdp-tunnel.md`.
 */

import type { CdpBrowserEmulator } from './cdp-browser-emulator.js';

/** Outbound `cdp_*` frame types (daemon -> extension). */
export const CDP_FRAME_TYPES = {
  /** Ask the extension to `chrome.debugger.attach` the active tab. */
  attach: 'cdp_attach',
  /** Ack from the extension that the tab is attached. */
  attached: 'cdp_attached',
  /** A page-domain CDP command to run on the real tab. */
  command: 'cdp_command',
  /** The result (or error) of a `cdp_command`, correlated by `id`. */
  result: 'cdp_result',
  /** A CDP event emitted by the real tab. */
  event: 'cdp_event',
  /** The tab/debugger detached (user opened DevTools, page crashed, …). */
  detach: 'cdp_detach',
  /**
   * Tell the extension to release its `chrome.debugger` attachment because the
   * `/cdp` puppeteer client went away (the extension is still connected).
   */
  release: 'cdp_release',
} as const;

/** A `cdp_command` frame the daemon sends to the extension. */
export interface CdpCommandFrame {
  type: 'cdp_command';
  /** Correlation id for the matching `cdp_result`. */
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** A `cdp_attach` frame the daemon sends to the extension. */
export interface CdpAttachFrame {
  type: 'cdp_attach';
  /** Correlation id for the matching `cdp_attached` ack. */
  id: number;
}

/**
 * A `cdp_release` frame the daemon sends when the bound `/cdp` puppeteer client
 * disconnects while the extension is still connected. The extension responds by
 * detaching `chrome.debugger` so the tab doesn't keep Chrome's debugging banner.
 */
export interface CdpReleaseFrame {
  type: 'cdp_release';
}

/** Any outbound frame this link pushes to the extension socket. */
export type CdpOutboundFrame =
  | CdpCommandFrame
  | CdpAttachFrame
  | CdpReleaseFrame;

/** A `cdp_result` frame the extension sends back for a `cdp_command`. */
export interface CdpResultFrame {
  type: 'cdp_result';
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** A `cdp_event` frame the extension forwards from the real tab. */
export interface CdpEventFrame {
  type: 'cdp_event';
  method: string;
  params?: Record<string, unknown>;
}

/** A `cdp_attached` ack frame from the extension. */
export interface CdpAttachedFrame {
  type: 'cdp_attached';
  id: number;
  /** Best-effort tab metadata for the emulator's synthetic targetInfo. */
  url?: string;
  title?: string;
  error?: { message?: string };
}

/** A `cdp_detach` frame the extension sends when the debugger goes away. */
export interface CdpDetachFrame {
  type: 'cdp_detach';
  reason?: string;
}

type CdpInboundFrame =
  | CdpResultFrame
  | CdpEventFrame
  | CdpAttachedFrame
  | CdpDetachFrame;
type CdpInboundCandidate = { type?: unknown };

/** Sink for pushing one outbound frame down the extension `/acp` socket. */
export type CdpSendToExtension = (frame: CdpOutboundFrame) => void;

/** Default per-command timeout (ms). Puppeteer's protocolTimeout is 180s. */
const DEFAULT_COMMAND_TIMEOUT_MS = 170_000;
const COMMAND_PROGRESS_LOG_MS = 30_000;

/** Whether a frame's `type` is one the reverse link consumes (extension -> daemon). */
export function isCdpInboundFrameType(type: unknown): boolean {
  return (
    type === CDP_FRAME_TYPES.result ||
    type === CDP_FRAME_TYPES.event ||
    type === CDP_FRAME_TYPES.attached ||
    type === CDP_FRAME_TYPES.detach
  );
}

function isCdpInboundFrame(
  frame: CdpInboundCandidate,
): frame is CdpInboundFrame {
  return isCdpInboundFrameType(frame.type);
}

interface PendingCommand {
  resolve(result: unknown): void;
  reject(err: { code?: number; message?: string; data?: unknown }): void;
  timer: ReturnType<typeof setTimeout>;
  progressTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Bridges a single emulator to a single extension `/acp` connection. Created by
 * the `/cdp` endpoint glue, fed inbound frames by the `/acp` WS layer.
 */
export class CdpReverseLink {
  private emulator: CdpBrowserEmulator | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private disposed = false;
  /** Resolver for the in-flight `cdp_attach` (if any). */
  private pendingAttach: { id: number; pending: PendingCommand } | undefined;
  /**
   * Opens once the initial `cdp_attach` settles (success OR failure).
   * `forwardToTab` awaits this so page-domain commands never race the
   * extension's async `chrome.debugger.attach`. Undefined until {@link attach}.
   */
  private attachGate: Promise<void> | undefined;
  /** Called when the extension reports the tab detached. */
  onDetach: ((reason: string) => void) | undefined;

  constructor(
    private readonly sendToExtension: CdpSendToExtension,
    private readonly commandTimeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
    /** Optional diagnostic sink for dropped/unexpected inbound frames. */
    private readonly log?: (line: string) => void,
  ) {}

  /** Wire the emulator whose `forwardToTab` this link backs. */
  bindEmulator(emulator: CdpBrowserEmulator): void {
    this.emulator = emulator;
  }

  /**
   * The {@link CdpEmulatorCallbacks.forwardToTab} implementation: send a
   * `cdp_command` to the extension and await the correlated `cdp_result`.
   */
  readonly forwardToTab = async (
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> => {
    if (this.disposed) {
      throw { code: -32000, message: 'CDP tunnel closed' };
    }
    // Ordering gate: wait for the initial attach to settle before forwarding
    // page-domain commands, so a fast `Network.enable` doesn't reach the
    // extension before `chrome.debugger.attach` finishes and fail "not attached".
    if (this.attachGate) {
      await this.attachGate;
    }
    return new Promise<unknown>((resolve, reject) => {
      if (this.disposed) {
        reject({ code: -32000, message: 'CDP tunnel closed' });
        return;
      }
      const id = this.nextId++;
      const timer = this.armTimeout(
        id,
        `CDP command id=${id} method=${method} timed out after ${this.commandTimeoutMs}ms`,
      );
      const progressTimer = this.armProgressLog(id, method);
      this.pending.set(id, { resolve, reject, timer, progressTimer });
      try {
        this.log?.(
          `qwen serve: /cdp forwarded command id=${id} method=${method} to extension`,
        );
        this.sendToExtension({
          type: CDP_FRAME_TYPES.command,
          id,
          method,
          params,
        });
      } catch (err) {
        this.settleReject(id, {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };

  /**
   * Ask the extension to attach `chrome.debugger` to the active tab. Resolves
   * once the extension acks `cdp_attached` (or rejects on error/timeout).
   */
  attach(): Promise<{ url?: string; title?: string }> {
    const result = new Promise<{ url?: string; title?: string }>(
      (resolve, reject) => {
        if (this.disposed) {
          reject({ code: -32000, message: 'CDP tunnel closed' });
          return;
        }
        const id = this.nextId++;
        const timer = this.armTimeout(id, 'cdp_attach timed out');
        // Reuse the PendingCommand shape; result carries the tab metadata.
        this.pendingAttach = {
          id,
          pending: {
            resolve: (result) =>
              resolve((result ?? {}) as { url?: string; title?: string }),
            reject,
            timer,
          },
        };
        try {
          this.sendToExtension({ type: CDP_FRAME_TYPES.attach, id });
        } catch (err) {
          clearTimeout(timer);
          this.pendingAttach = undefined;
          reject({
            code: -32000,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    // Open the gate once the attach settles (success or failure).
    this.attachGate = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Feed one inbound frame from the extension `/acp` socket. Returns true if
   * the frame was consumed by this link (so the WS layer can skip it).
   */
  handleInbound(frame: Record<string, unknown>): boolean {
    if (!isCdpInboundFrame(frame)) return false;
    switch (frame.type) {
      case CDP_FRAME_TYPES.result:
        this.handleResult(frame);
        return true;
      case CDP_FRAME_TYPES.event:
        this.handleEvent(frame);
        return true;
      case CDP_FRAME_TYPES.attached:
        this.handleAttached(frame);
        return true;
      case CDP_FRAME_TYPES.detach:
        this.handleDetach(frame);
        return true;
      default:
        return false;
    }
  }

  private handleResult(frame: CdpResultFrame): void {
    const id = typeof frame.id === 'number' ? frame.id : undefined;
    if (id === undefined) {
      this.log?.('qwen serve: /cdp dropped cdp_result with non-numeric id');
      return;
    }
    if (frame.error) {
      this.settleReject(id, frame.error);
    } else {
      this.settleResolve(id, frame.result);
    }
  }

  private handleEvent(frame: CdpEventFrame): void {
    // No emulator = the link is being torn down; that's a benign race, not a
    // malformed frame, so don't log it.
    if (!this.emulator) return;
    if (typeof frame.method !== 'string') {
      this.log?.('qwen serve: /cdp dropped cdp_event with non-string method');
      return;
    }
    this.emulator.emitTabEvent(frame.method, frame.params);
  }

  private handleAttached(frame: CdpAttachedFrame): void {
    const attach = this.pendingAttach;
    if (!attach || attach.id !== frame.id) {
      this.log?.(
        `qwen serve: /cdp dropped unexpected cdp_attached (id=${String(frame.id)})`,
      );
      return;
    }
    this.pendingAttach = undefined;
    clearTimeout(attach.pending.timer);
    if (frame.error) {
      attach.pending.reject({
        code: -32000,
        message: frame.error.message ?? 'cdp_attach failed',
      });
      return;
    }
    attach.pending.resolve({ url: frame.url, title: frame.title });
  }

  private handleDetach(frame: CdpDetachFrame): void {
    const reason =
      typeof frame.reason === 'string' ? frame.reason : 'tab detached';
    this.onDetach?.(reason);
  }

  private armTimeout(
    id: number,
    message: string,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.settleReject(id, { code: -32000, message });
      if (this.pendingAttach?.id === id) {
        this.pendingAttach.pending.reject({ code: -32000, message });
        this.pendingAttach = undefined;
      }
    }, this.commandTimeoutMs);
    timer.unref?.();
    return timer;
  }

  private armProgressLog(
    id: number,
    method: string,
  ): ReturnType<typeof setTimeout> | undefined {
    if (!this.log) return undefined;
    const delay = Math.min(COMMAND_PROGRESS_LOG_MS, this.commandTimeoutMs);
    if (delay >= this.commandTimeoutMs) return undefined;
    const timer = setTimeout(() => {
      this.log?.(
        `qwen serve: /cdp still waiting for command id=${id} method=${method} after ${delay}ms`,
      );
    }, delay);
    timer.unref?.();
    return timer;
  }

  private settleResolve(id: number, result: unknown): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    if (p.progressTimer) clearTimeout(p.progressTimer);
    this.pending.delete(id);
    p.resolve(result);
  }

  private settleReject(
    id: number,
    err: { code?: number; message?: string; data?: unknown },
  ): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    if (p.progressTimer) clearTimeout(p.progressTimer);
    this.pending.delete(id);
    p.reject(err);
  }

  /** In-flight forwarded-command count (for tests / accounting). */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Reject all pending commands and stop accepting new ones. Idempotent. */
  dispose(reason = 'CDP reverse link closed'): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.progressTimer) clearTimeout(p.progressTimer);
      p.reject({ code: -32000, message: reason });
    }
    this.pending.clear();
    if (this.pendingAttach) {
      clearTimeout(this.pendingAttach.pending.timer);
      this.pendingAttach.pending.reject({ code: -32000, message: reason });
      this.pendingAttach = undefined;
    }
    this.emulator = undefined;
  }
}
