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
  /**
   * Monotonic per-session id, starting at 1. Absent on synthetic
   * terminal frames (e.g. `client_evicted`) so they don't burn a slot
   * in the sequence other subscribers observe — the gap would be
   * visible on the live stream and the resume ring wouldn't have the
   * skipped id either, silently breaking contiguity.
   */
  id?: number;
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
/**
 * Per-bus subscriber cap. With per-subscriber `maxQueued` defaulting to
 * 256 frames, 64 concurrent subscribers caps the per-session subscriber
 * memory at ~64 × 256 = 16k queued frames (worst case). Keeps a single
 * session from being opened thousands of times by an attacker to amplify
 * each `publish()` (which is O(N) over subscribers) into a CPU/memory
 * DoS. Daemon's HTTP listener also wants `server.maxConnections`
 * configured at the listener level — see `runQwenServe.ts`.
 */
const DEFAULT_MAX_SUBSCRIBERS = 64;

interface InternalSub {
  queue: BoundedAsyncQueue<BridgeEvent>;
  evicted: boolean;
}

export class EventBus {
  private nextId = 1;
  private readonly ring: BridgeEvent[] = [];
  private readonly subs = new Set<InternalSub>();
  private closed = false;

  constructor(
    private readonly ringSize: number = DEFAULT_RING_SIZE,
    private readonly maxSubscribers: number = DEFAULT_MAX_SUBSCRIBERS,
  ) {}

  /** Most recent id ever assigned by `publish`. 0 if no events published. */
  get lastEventId(): number {
    return this.nextId - 1;
  }

  /** Snapshot of the live subscriber count. */
  get subscriberCount(): number {
    return this.subs.size;
  }

  publish(input: Omit<BridgeEvent, 'id' | 'v'>): BridgeEvent | undefined {
    // Publishing against a closed bus is a no-op rather than a throw.
    // The shutdown path closes per-session buses *before* awaiting
    // `channel.kill()`, which leaves a small window where the agent can
    // still emit a `sessionUpdate` notification or fire a
    // `requestPermission`. Throwing here would force every call site to
    // wrap publish in try/catch — and would corrupt state in
    // `BridgeClient.requestPermission`, where the daemon-wide pending
    // map mutation runs *before* the publish (see executor in
    // `httpAcpBridge.ts`). Returning undefined keeps callers
    // straightforward; nobody can observe a frame nobody can subscribe
    // to anyway.
    if (this.closed) return undefined;
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
    // Snapshot the subscribers so an in-loop `this.subs.delete(sub)`
    // (the new immediate-eviction cleanup below) doesn't mutate the
    // Set we're iterating.
    for (const sub of Array.from(this.subs)) {
      if (sub.evicted) continue;
      if (!sub.queue.push(event)) {
        sub.evicted = true;
        // Synthetic terminal frame: NO `id` field. Otherwise it would
        // burn a slot in the per-session monotonic sequence (`nextId++`)
        // visible to every OTHER subscriber as a gap (3 → 5, missing 4).
        // Healthy subscribers would see the gap on the live stream and
        // on `Last-Event-ID: 3` resume the ring has no record of 4
        // either — silently broken contiguity contradicts the
        // `BridgeEvent.id` doc-comment. Same pattern as `stream_error`
        // in server.ts; `formatSseFrame` omits the `id:` line when
        // `id` is absent.
        const evictionFrame: BridgeEvent = {
          v: EVENT_SCHEMA_VERSION,
          type: 'client_evicted',
          data: { reason: 'queue_overflow', droppedAfter: event.id },
        };
        // Force-push the eviction frame; close immediately after so the
        // consumer iterator unwinds with a final synthetic event.
        sub.queue.forcePush(evictionFrame);
        sub.queue.close();
        // Drop the evicted sub from the Set IMMEDIATELY rather than
        // waiting for the consumer's next `next()` call. A stalled
        // (already-evicted, never-iterated) consumer would otherwise
        // linger in `this.subs` forever — every subsequent `publish()`
        // pays its `if (sub.evicted) continue` cost AND the
        // `BoundedAsyncQueue` it owns is never GC'd. Under attack
        // (thousands of opened-then-stalled SSE connections) this
        // amplifies every event into thousands of dead-sub iterations
        // and pins memory.
        this.subs.delete(sub);
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
    // Per-bus subscriber cap: refuse rather than admit a subscriber
    // that would push us past the limit. An accepted-but-immediately-
    // evicted alternative would still pay the `BoundedAsyncQueue`
    // allocation + the per-publish iteration cost. Returning an empty
    // iterable lets the caller (the SSE route) cleanly close the
    // response with no frames sent — under attack this is exactly
    // the desired "drop new connections" behavior. Healthy callers
    // won't normally hit the cap; if they do, raise `maxSubscribers`
    // at construction.
    if (this.subs.size >= this.maxSubscribers) {
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
        // The ring only ever contains live events (publish() always
        // assigns an id before pushing to ring), so `e.id` is never
        // undefined here — but the type system can't see that since
        // BridgeEvent.id is optional for synthetic terminal frames.
        // Guard explicitly to keep narrow typing without runtime cost.
        if (e.id !== undefined && e.id > opts.lastEventId) {
          queue.forcePush(e);
        }
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
 *
 * The cap (`maxSize`) applies only to LIVE items pushed via `push()`. Items
 * inserted via `forcePush()` (the `Last-Event-ID` replay path on subscribe
 * and the terminal `client_evicted` frame) are tracked separately and don't
 * count toward the cap. Without this split, a reconnect with a large
 * backlog would force-push ~ringSize entries into `buf`, push `buf.length`
 * past `maxSize`, and the very next live publish would evict the
 * just-resumed subscriber — defeating the resume contract.
 */
class BoundedAsyncQueue<T> {
  private readonly buf: T[] = [];
  private readonly resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private closed = false;
  /**
   * Number of force-pushed items still in `buf`. The cap check in
   * `push()` only applies to LIVE items; this counter tells us how
   * many slots in `buf` are replay-injected and shouldn't count.
   *
   * Position invariant: under the bus's two callers,
   *   1. subscribe-time replay (`Last-Event-ID` resume) — forcePush
   *      fires BEFORE any live `push()`, so replay items are at the
   *      front of `buf`;
   *   2. eviction terminal frame — forcePush fires AFTER `push()`
   *      rejection, then `close()` is called immediately, so the
   *      eviction frame is at the BACK of `buf`.
   *
   * `next()` decrements `forcedInBuf` whenever the counter is > 0 on
   * shift, which is correct for case (1). For case (2) it slightly
   * misaccounts (decrements on the first live shift), but that's
   * harmless: the queue is closed so no `push()` runs the cap check
   * again. The counter only matters for live cap enforcement.
   */
  private forcedInBuf = 0;

  constructor(private readonly maxSize: number) {}

  /** Returns true if accepted, false if dropped due to overflow. */
  push(value: T): boolean {
    if (this.closed) return false;
    const r = this.resolvers.shift();
    if (r) {
      r({ value, done: false });
      return true;
    }
    // Cap is on the LIVE backlog only.
    if (this.buf.length - this.forcedInBuf >= this.maxSize) return false;
    this.buf.push(value);
    return true;
  }

  /** Bypasses the size cap. Used for replay frames and terminal eviction. */
  forcePush(value: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) {
      r({ value, done: false });
      return;
    }
    this.buf.push(value);
    this.forcedInBuf += 1;
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
      // Force-pushed entries are FIFO at the front of `buf` (forcePush
      // only happens at subscribe time, before any live push). So as long
      // as `forcedInBuf > 0` the shifted item is a replay frame.
      if (this.forcedInBuf > 0) this.forcedInBuf -= 1;
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
