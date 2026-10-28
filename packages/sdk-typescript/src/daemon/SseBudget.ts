/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent } from './types.js';
import { DaemonHttpError } from './DaemonHttpError.js';
import { parseSseStream } from './sse.js';
import { composeAbortSignals } from './abortSignals.js';

/**
 * Cap on concurrent LIVE session SSE streams per JS context (one web
 * shell webview, or one Node process).
 *
 * WebKit opens at most 6 HTTP/1.1 connections per origin and the daemon
 * only speaks HTTP/1.1, so 4-5 split-view panes each holding a
 * long-lived `GET /session/:id/events` stream saturate the browser
 * connection pool and the engine starts aborting established fetches
 * (QwenLM/qwen-code#13908: "Connection lost: Fetch is aborted").
 *
 * The cap keeps at most {@link DEFAULT_MAX_LIVE_SSE_STREAMS} live
 * streams open. A subscription that cannot take a slot does catch-up
 * cycles instead: a replay request carrying `Last-Event-ID`, consumed
 * until the daemon's `replay_complete` boundary. The daemon's ring
 * buffer plus the consumer-side per-event-id dedupe make catch-up
 * lossless and idempotent. The focused pane has priority: its
 * subscription may evict the least-recently active background holder.
 */
export const DEFAULT_MAX_LIVE_SSE_STREAMS = 4;

/** Pause between catch-up retries (and slot probes) in ms. */
export const SSE_CATCH_UP_RETRY_DELAY_MS = 2500;

/** A catch-up request may take at most this long to connect. */
const CATCH_UP_CONNECT_TIMEOUT_MS = 8000;

/**
 * A catch-up cycle stops after this much time even without a
 * `replay_complete` boundary, so one slow replay cannot starve the
 * others of their turn.
 */
const CATCH_UP_FRAME_WINDOW_MS = 5000;

/**
 * Replay cursor carried across catch-up cycles. `value` is the highest
 * event id the subscriber has seen (seeded with the caller's
 * `lastEventId`); `undefined` means "replay from the start of the
 * ring buffer".
 */
export interface SseCatchUpCursor {
  value?: number;
}

interface SseBudgetHolder {
  readonly key: string;
  readonly sessionId: string;
  /** When the holder took its slot. */
  readonly acquiredAt: number;
  /** Last activity (acquire / touch); the LRU ordering key. */
  lastActiveAt: number;
  /** Abort controller of the holder's live SSE request. */
  controller: AbortController;
}

/**
 * Per-context registry of live SSE stream slots. See
 * {@link DEFAULT_MAX_LIVE_SSE_STREAMS} for why the cap exists.
 */
export class SseBudgetRegistry {
  readonly max: number;
  /** Monotonic per-context sequence used to make holder keys unique. */
  seq = 0;
  /** Session id of the pane that currently has UI focus, or null. */
  focus: string | null = null;

  private cycling = false;
  private readonly holders = new Map<string, SseBudgetHolder>();

  constructor(max: number = DEFAULT_MAX_LIVE_SSE_STREAMS) {
    this.max = max;
  }

  setFocus(sessionId: string | null): void {
    this.focus = sessionId;
  }

  /**
   * Try to take a live-stream slot for `sessionId` under `key`.
   *
   *   - The same key is always allowed (the slot is touched, not
   *     re-taken).
   *   - A slot is granted while fewer than `max` are held.
   *   - A focused session may evict the least-recently active
   *     NON-focused holder (its live request is aborted with an
   *     `AbortError` named "preempted"); with no evictable holder it
   *     waits like everyone else.
   *   - Anything else is denied: the caller does a catch-up cycle and
   *     retries.
   */
  acquire(
    key: string,
    sessionId: string,
    focused: boolean,
    controller: AbortController,
  ): boolean {
    const existing = this.holders.get(key);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return true;
    }
    if (this.holders.size < this.max) {
      this.holders.set(key, {
        key,
        sessionId,
        acquiredAt: Date.now(),
        lastActiveAt: Date.now(),
        controller,
      });
      return true;
    }
    if (focused) {
      let lru: SseBudgetHolder | undefined;
      for (const holder of this.holders.values()) {
        if (this.focus === null || holder.sessionId === this.focus) continue;
        if (lru === undefined || holder.lastActiveAt < lru.lastActiveAt) {
          lru = holder;
        }
      }
      if (lru) {
        try {
          lru.controller.abort(new DOMException('preempted', 'AbortError'));
        } catch {
          /* holder already gone */
        }
        this.holders.delete(lru.key);
      } else {
        return false;
      }
    } else {
      return false;
    }
    this.holders.set(key, {
      key,
      sessionId,
      acquiredAt: Date.now(),
      lastActiveAt: Date.now(),
      controller,
    });
    return true;
  }

  /** Mark `key` as recently active (called on every live frame). */
  touch(key: string): void {
    const holder = this.holders.get(key);
    if (holder) {
      holder.lastActiveAt = Date.now();
    }
  }

  /** Give the slot back (subscription teardown). */
  release(key: string): void {
    this.holders.delete(key);
  }

  /**
   * Serializes catch-up cycles context-wide: at most one catch-up
   * request runs at a time so background panes take turns. Returns
   * `false` when another cycle is already in flight.
   */
  startCycle(): boolean {
    if (this.cycling) {
      return false;
    }
    this.cycling = true;
    return true;
  }

  endCycle(): void {
    this.cycling = false;
  }

  /** Wait up to `ms`, resolving early when `signal` aborts. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
    });
  }

  /**
   * One catch-up cycle: fetch the same SSE endpoint with the replay
   * cursor and consume the replay until the daemon's
   * `replay_complete` boundary (or the frame window expires).
   *
   * Mirrors the live path's request handling — same URL and query,
   * same headers plus `Last-Event-ID`, the same error and
   * content-type validation — so a background pane sees exactly what a
   * live pane would, minus the tail that arrives as live events
   * afterwards.
   */
  async *catchUp(
    fetchFn: typeof globalThis.fetch,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    cursor: SseCatchUpCursor,
  ): AsyncGenerator<DaemonEvent> {
    const catchUpHeaders: Record<string, string> = { ...headers };
    if (cursor.value !== undefined) {
      catchUpHeaders['Last-Event-ID'] = String(cursor.value);
    }

    const timeoutCtrl = new AbortController();
    const connectTimer = setTimeout(
      () =>
        timeoutCtrl.abort(new DOMException('catch-up timeout', 'TimeoutError')),
      CATCH_UP_CONNECT_TIMEOUT_MS,
    );
    const catchUpSignal = composeAbortSignals([signal, timeoutCtrl.signal]);

    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: catchUpHeaders,
        signal: catchUpSignal,
      });
    } finally {
      clearTimeout(connectTimer);
    }

    if (!res.ok) {
      let body: unknown;
      try {
        const text = await res.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      } catch {
        /* body unreadable */
      }
      const detail =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new DaemonHttpError(
        res.status,
        body,
        `GET /session/:id/events: ${detail}`,
      );
    }

    // Content-type validation — a misconfigured proxy that swallows
    // the SSE response would otherwise silently produce zero frames.
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream') || !res.body) {
      try {
        await res.body?.cancel();
      } catch {
        /* body already consumed or no body */
      }
      throw new DaemonHttpError(
        res.status,
        contentType,
        `GET /session/:id/events: expected content-type text/event-stream, got "${contentType}"`,
      );
    }

    const startedAt = Date.now();
    for await (const event of parseSseStream(res.body, signal)) {
      if (event && typeof event.id === 'number') {
        cursor.value = event.id;
      }
      yield event;
      if (event && event.type === 'replay_complete') break;
      if (Date.now() - startedAt > CATCH_UP_FRAME_WINDOW_MS) break;
    }
    try {
      await res.body.cancel();
    } catch {
      /* body already consumed or cancelled */
    }
  }
}

/**
 * The budget lives in module state — one per JS context — rather than
 * per transport instance: the web shell creates one `DaemonClient`
 * (and therefore one `RestSseTransport`) per split-view pane, and the
 * cap must hold across all of them. v1 does not expose the registry as
 * a constructor option; the context-wide singleton IS the per-webview
 * registry (each webview / Node process has its own module state).
 */
let sseBudgetRegistry: SseBudgetRegistry | undefined;

export function getSseBudgetRegistry(): SseBudgetRegistry {
  if (!sseBudgetRegistry) {
    sseBudgetRegistry = new SseBudgetRegistry();
  }
  return sseBudgetRegistry;
}

/**
 * Tell the budget which pane has UI focus (split-view focus hook).
 * The focused pane's subscription may evict a background holder;
 * passing `null` clears the priority (no pane may evict).
 */
export function setSseBudgetFocus(sessionId: string | null): void {
  getSseBudgetRegistry().setFocus(sessionId);
}

/** Test hook: drop the per-context registry so tests start clean. */
export function resetSseBudgetRegistry(): void {
  sseBudgetRegistry = undefined;
}
