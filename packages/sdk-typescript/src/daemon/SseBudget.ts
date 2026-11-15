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
 *
 * The cap is opt-in: the module singleton stays dormant until the
 * first {@link setSseBudgetFocus} call (the web shell's split-view
 * focus hook). A non-browser host process (serve-bridge, adaptors)
 * never sets a focus and must not be throttled — the connection-pool
 * limit the cap protects does not exist outside a browser.
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
 * After a same-session takeover demotes a holder, that subscription
 * may not take the session's slot back for this long. Without the
 * cooldown the two views of one session (main view + split pane)
 * would trade the slot on every 2.5 s catch-up probe.
 */
const SAME_SESSION_DEDUPE_COOLDOWN_MS = 30_000;

/**
 * Replay cursor carried across catch-up cycles. `value` is the highest
 * event id the subscriber has seen (seeded with the caller's
 * `lastEventId`); `undefined` means "replay from the start of the
 * ring buffer" (the request sends `Last-Event-ID: 0`, which the
 * daemon reads as "replay the whole ring" — a MISSING header means
 * live-only, which would leave a permanent hole in a pane that was
 * denied a slot before its first live event).
 */
export interface SseCatchUpCursor {
  value?: number;
}

interface SseBudgetHolder {
  readonly key: string;
  readonly sessionId: string;
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

  /**
   * Whether the cap is enforced. Directly constructed registries (tests)
   * are active; the module singleton is created dormant and activates
   * on the first `setFocus` call (see the module doc).
   */
  active: boolean;

  private cycling = false;
  private readonly holders = new Map<string, SseBudgetHolder>();
  /**
   * Key → timestamp until which a subscription demoted by a
   * same-session takeover may not take that session's slot back
   * (see `acquire`).
   */
  private readonly sameSessionCooldownUntil = new Map<string, number>();

  constructor(max: number = DEFAULT_MAX_LIVE_SSE_STREAMS, active = true) {
    this.max = max;
    this.active = active;
  }

  setFocus(sessionId: string | null): void {
    // The first focus hook call activates the (dormant) module
    // singleton: from then on the split-view panes share the cap.
    this.active = true;
    this.focus = sessionId;
  }

  /** Number of held live slots (the eviction bookkeeping's size). */
  get holderCount(): number {
    return this.holders.size;
  }

  /**
   * Try to take a live-stream slot for `sessionId` under `key`.
   *
   *   - A dormant registry (no focus has ever been set in this
   *     context) grants everything without tracking: the pool limit
   *     the cap protects does not exist outside a browser.
   *   - The same key is always allowed (the slot is touched, not
   *     re-taken).
   *   - At most one live holder per session: a session rendered in
   *     two mounted views at once (main view + split pane) keeps a
   *     single live stream. A new subscription for an already-held
   *     session takes the slot over — the previous holder is demoted
   *     to catch-up — unless it is still inside the same-session
   *     cooldown from its own recent demotion.
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
    if (!this.active) {
      return true;
    }
    const existing = this.holders.get(key);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return true;
    }
    // Same-session dedupe: the other view of this session already
    // holds the live stream. Take it over unless this subscription was
    // just demoted for it (the cooldown stops the two views trading
    // the slot on every catch-up probe).
    const now = Date.now();
    const sameSession = [...this.holders.values()].find(
      (holder) => holder.sessionId === sessionId,
    );
    if (sameSession) {
      const cooldownUntil = this.sameSessionCooldownUntil.get(key) ?? 0;
      if (now < cooldownUntil) {
        return false;
      }
      try {
        sameSession.controller.abort(
          new DOMException('demoted: session duplicated', 'AbortError'),
        );
      } catch {
        /* holder already gone */
      }
      this.holders.delete(sameSession.key);
      this.sameSessionCooldownUntil.set(
        sameSession.key,
        now + SAME_SESSION_DEDUPE_COOLDOWN_MS,
      );
    }
    if (this.holders.size < this.max) {
      this.holders.set(key, {
        key,
        sessionId,
        lastActiveAt: now,
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
    this.sameSessionCooldownUntil.delete(key);
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

  /**
   * Wait up to `ms`, resolving early when `signal` aborts. A signal
   * that is ALREADY aborted resolves immediately — the DOM abort event
   * is not replayed for a listener attached after the fact. The abort
   * listener is removed on every exit path, so repeated waits on one
   * subscription-lifetime signal do not accumulate listeners.
   */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      };
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref: () => void }).unref();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
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
   *
   * The whole cycle is wall-clock bounded by one per-cycle controller:
   * it fires the connect timeout before headers and the frame window
   * after them (aborted in the `finally`, which also detaches the
   * composed signal's fallback listeners from the caller's signal). A
   * body that goes silent after its headers therefore parks in no
   * read — `parseSseStream` sees the abort and ends cleanly.
   *
   * `onEpoch` receives the response's `x-qwen-event-epoch` header so
   * a demoted pane keeps its resume cursor paired with the daemon's
   * current bus epoch (a restart that resets the ids without resetting
   * the epoch must trigger a resync, like on the live path).
   */
  async *catchUp(
    fetchFn: typeof globalThis.fetch,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    cursor: SseCatchUpCursor,
    onEpoch?: (epoch: string) => void,
  ): AsyncGenerator<DaemonEvent> {
    const catchUpHeaders: Record<string, string> = { ...headers };
    // A cursorless catch-up replays from the start of the ring: the
    // daemon reads a MISSING Last-Event-ID as live-only, which would
    // replay nothing and leave a permanent hole.
    catchUpHeaders['Last-Event-ID'] = String(cursor.value ?? 0);

    const cycleCtrl = new AbortController();
    const connectTimer = setTimeout(
      () => cycleCtrl.abort(new DOMException('catch-up timeout', 'AbortError')),
      CATCH_UP_CONNECT_TIMEOUT_MS,
    );
    let windowTimer: ReturnType<typeof setTimeout> | undefined;
    const catchUpSignal = composeAbortSignals([signal, cycleCtrl.signal]);

    let res: Response | undefined;
    try {
      try {
        res = await fetchFn(url, {
          headers: catchUpHeaders,
          signal: catchUpSignal,
        });
      } finally {
        clearTimeout(connectTimer);
      }

      if (!res.ok) {
        // Bounded: a proxy that accepts the request and then stalls
        // the error body would otherwise hang the cycle (and its
        // context-wide lock) until the TCP layer gives up.
        let body: unknown;
        try {
          const text = await this.readTextBounded(res);
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
      if (
        !contentType.toLowerCase().includes('text/event-stream') ||
        !res.body
      ) {
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

      // Learn the daemon's current bus epoch (same header the live
      // path reports) so the next reconnect pairs the cursor with a
      // live epoch instead of forcing a whole-ring replay per cycle.
      const responseEpoch = res.headers.get('x-qwen-event-epoch');
      if (responseEpoch) {
        onEpoch?.(responseEpoch);
      }

      // The frame window is now a real deadline, not a between-frames
      // check: it aborts the cycle's controller, which unparks a
      // silent body in `reader.read()` the same way caller aborts do.
      windowTimer = setTimeout(
        () =>
          cycleCtrl.abort(
            new DOMException('catch-up frame window exceeded', 'AbortError'),
          ),
        CATCH_UP_FRAME_WINDOW_MS,
      );
      for await (const event of parseSseStream(res.body, catchUpSignal)) {
        if (event && typeof event.id === 'number') {
          cursor.value = event.id;
        }
        yield event;
        if (event && event.type === 'replay_complete') break;
      }
    } finally {
      if (windowTimer !== undefined) clearTimeout(windowTimer);
      // Detach the composed signal's fallback listeners from the
      // caller's signal and stop any read the generator was parked in.
      cycleCtrl.abort();
      try {
        await res?.body?.cancel();
      } catch {
        /* body already consumed or cancelled */
      }
    }
  }

  /** Read a response body, giving up after the connect-timeout bound. */
  private async readTextBounded(res: Response): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        res.text(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new DOMException('catch-up body timeout', 'TimeoutError')),
            CATCH_UP_CONNECT_TIMEOUT_MS,
          );
          if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            (timer as { unref: () => void }).unref();
          }
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * The budget lives in module state — one per JS context — rather than
 * per transport instance: the web shell creates one `DaemonClient`
 * (and therefore one `RestSseTransport`) per split-view pane, and the
 * cap must hold across all of them. The singleton is created DORMANT:
 * it starts enforcing the cap on the first `setSseBudgetFocus` call,
 * so a host process that never has a split-view focus concept is never
 * throttled by a limit that does not apply to it.
 */
let sseBudgetRegistry: SseBudgetRegistry | undefined;

export function getSseBudgetRegistry(): SseBudgetRegistry {
  if (!sseBudgetRegistry) {
    sseBudgetRegistry = new SseBudgetRegistry(undefined, false);
  }
  return sseBudgetRegistry;
}

/**
 * Tell the budget which pane has UI focus (split-view focus hook).
 * The focused pane's subscription may evict a background holder;
 * passing `null` clears the priority (no pane may evict). The first
 * call activates the dormant module registry.
 */
export function setSseBudgetFocus(sessionId: string | null): void {
  getSseBudgetRegistry().setFocus(sessionId);
}

/** Test hook: drop the per-context registry so tests start clean. */
export function resetSseBudgetRegistry(): void {
  sseBudgetRegistry = undefined;
}
