/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Event-bus for the daemon's per-session NDJSON stream.
 *
 * Design notes (from issue #3803 §04 / threat-model):
 *   - Each event carries a monotonic `id` (per session) so the SSE
 *     `Last-Event-ID` reconnect protocol can pick up where the client left
 *     off. Backed by a bounded ring of recent events for replay.
 *   - Subscribers use bounded async queues. A slow subscriber that blows
 *     past its queue limit is sent a final `client_evicted` event and
 *     closed; this keeps a stuck client from holding the daemon hostage
 *     (per the resource-exhaustion entry in the threat-model summary).
 *   - The bus is push-based; consumers iterate the returned AsyncIterable.
 *     Aborting the supplied AbortSignal closes the iterator promptly.
 */

export const EVENT_SCHEMA_VERSION = 1 as const;

/** A single frame published on the bus. */
export interface BridgeEvent {
  /** Monotonic per-session id, starting at 1. */
  id: number;
  /** Schema version; bumped on breaking frame changes. */
  v: typeof EVENT_SCHEMA_VERSION;
  /** Frame type: `session_update`, `client_evicted`, or daemon-pushed events. */
  type: string;
  /** Frame payload — opaque JSON. */
  data: unknown;
  /**
   * Identifier of the client that triggered the event, when known. Used by
   * fan-out consumers to suppress echoes of their own actions.
   */
  originatorClientId?: string;
}

export interface SubscribeOptions {
  /**
   * Resume from after this event id. Events with `id <= lastEventId` are
   * skipped (already delivered); newer events still buffered in the ring
   * are replayed before live events flow.
   */
  lastEventId?: number;
  /** Aborts the subscription cleanly. */
  signal?: AbortSignal;
  /**
   * Per-subscriber backlog cap. When exceeded the subscriber is evicted
   * with a final `client_evicted` event. Defaults to 256.
   */
  maxQueued?: number;
}

const DEFAULT_MAX_QUEUED = 256;
const DEFAULT_RING_SIZE = 1000;

interface InternalSub {
  queue: BoundedAsyncQueue<BridgeEvent>;
  evicted: boolean;
}

export class EventBus {
  private nextId = 1;
  private readonly ring: BridgeEvent[] = [];
  private readonly subs = new Set<InternalSub>();
  private closed = false;

  constructor(private readonly ringSize: number = DEFAULT_RING_SIZE) {}

  /** Most recent id ever assigned by `publish`. 0 if no events published. */
  get lastEventId(): number {
    return this.nextId - 1;
  }

  /** Snapshot of the live subscriber count. */
  get subscriberCount(): number {
    return this.subs.size;
  }

  publish(input: Omit<BridgeEvent, 'id' | 'v'>): BridgeEvent {
    if (this.closed) {
      throw new Error('EventBus is closed; cannot publish');
    }
    const event: BridgeEvent = {
      id: this.nextId++,
      v: EVENT_SCHEMA_VERSION,
      ...input,
    };
    this.ring.push(event);
    // Eviction-by-shift is O(n) once the ring is full. With ringSize=1000
    // and per-publish work measured in hundreds of microseconds even on
    // chatty sessions, this isn't a real hotspot today. A circular-buffer
    // refactor would push it to O(1) but adds index bookkeeping; deferred
    // until profiling actually flags it.
    if (this.ring.length > this.ringSize) this.ring.shift();
    for (const sub of this.subs) {
      if (sub.evicted) continue;
      if (!sub.queue.push(event)) {
        sub.evicted = true;
        const evictionFrame: BridgeEvent = {
          id: this.nextId++,
          v: EVENT_SCHEMA_VERSION,
          type: 'client_evicted',
          data: { reason: 'queue_overflow', droppedAfter: event.id },
        };
        // Force-push the eviction frame; close immediately after so the
        // consumer iterator unwinds with a final synthetic event.
        sub.queue.forcePush(evictionFrame);
        sub.queue.close();
      }
    }
    return event;
  }

  /**
   * Note: registration is synchronous — by the time `subscribe()` returns,
   * the subscriber is already attached and will receive any subsequent
   * `publish()` even if the consumer hasn't started iterating yet. (A
   * generator-style implementation would defer registration to the first
   * `next()` call, which races with publishes that happen before the
   * consumer's first await.)
   *
   * The returned iterator is NOT safe to drive from concurrent callers —
   * two simultaneous `.next()` calls would race for the same event from
   * the underlying queue. Daemon usage is sequential (`for await ... of`
   * inside the SSE route), so this is safe in production. Callers that
   * fan an iterator out to multiple consumers must serialize themselves.
   */
  subscribe(opts: SubscribeOptions = {}): AsyncIterable<BridgeEvent> {
    if (this.closed) {
      return emptyAsyncIterable<BridgeEvent>();
    }
    const queue = new BoundedAsyncQueue<BridgeEvent>(
      opts.maxQueued ?? DEFAULT_MAX_QUEUED,
    );

    const sub: InternalSub = { queue, evicted: false };
    this.subs.add(sub);

    if (opts.lastEventId !== undefined) {
      // Force-push replay frames so they bypass the per-subscriber size
      // cap. The cap protects against a slow live consumer; replay is
      // already historical and silently dropping it would undermine the
      // `Last-Event-ID` resume contract (the consumer would think they
      // caught up). If the gap really is enormous, the queue will be
      // primed with a long backlog the consumer drains at its own pace.
      for (const e of this.ring) {
        if (e.id > opts.lastEventId) queue.forcePush(e);
      }
    }

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      this.subs.delete(sub);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    // Abort tears the subscription down immediately, even if the consumer
    // never iterates again — without this the entry would linger in
    // `this.subs` until somebody called `next()`/`return()`. Idempotent
    // through `disposed`, so a double-abort or race with `return()` is
    // safe.
    const onAbort = () => {
      queue.close();
      dispose();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    return {
      [Symbol.asyncIterator]: (): AsyncIterator<BridgeEvent> => ({
        async next(): Promise<IteratorResult<BridgeEvent>> {
          const r = await queue.next();
          if (r.done) dispose();
          return r;
        },
        async return(): Promise<IteratorResult<BridgeEvent>> {
          queue.close();
          dispose();
          return { value: undefined as unknown as BridgeEvent, done: true };
        },
      }),
    };
  }

  /** Close all live subscribers and prevent further `publish`/`subscribe`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subs) sub.queue.close();
    this.subs.clear();
  }
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
      async next(): Promise<IteratorResult<T>> {
        return { value: undefined as unknown as T, done: true };
      },
    }),
  };
}

/**
 * Promise-based bounded queue. `push` returns false (instead of blocking or
 * throwing) when full so callers can decide how to react — the EventBus uses
 * that signal to evict slow subscribers.
 */
class BoundedAsyncQueue<T> {
  private readonly buf: T[] = [];
  private readonly resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly maxSize: number) {}

  /** Returns true if accepted, false if dropped due to overflow. */
  push(value: T): boolean {
    if (this.closed) return false;
    const r = this.resolvers.shift();
    if (r) {
      r({ value, done: false });
      return true;
    }
    if (this.buf.length >= this.maxSize) return false;
    this.buf.push(value);
    return true;
  }

  /** Bypasses the size cap. Used for terminal eviction frames. */
  forcePush(value: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) {
      r({ value, done: false });
      return;
    }
    this.buf.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({
        value: undefined as unknown as T,
        done: true,
      });
    }
  }

  next(): Promise<IteratorResult<T>> {
    // Length check first — `buf.shift() !== undefined` would mis-handle a
    // queue whose element type legitimately includes `undefined`. The bus
    // never pushes undefined today, but the queue is generic.
    if (this.buf.length > 0) {
      const value = this.buf.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({
        value: undefined as unknown as T,
        done: true,
      });
    }
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
}
