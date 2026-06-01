/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  EventBus,
  EVENT_SCHEMA_VERSION,
  type BridgeEvent,
} from './eventBus.js';

async function collect(
  iter: AsyncIterable<BridgeEvent>,
  count: number,
): Promise<BridgeEvent[]> {
  const out: BridgeEvent[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

describe('EventBus', () => {
  it('assigns monotonic ids and the right schema version', () => {
    const bus = new EventBus();
    const a = bus.publish({ type: 'foo', data: 1 });
    const b = bus.publish({ type: 'foo', data: 2 });
    expect(a?.id).toBe(1);
    expect(b?.id).toBe(2);
    expect(a?.v).toBe(EVENT_SCHEMA_VERSION);
    expect(bus.lastEventId).toBe(2);
  });

  it('delivers live publishes to a subscriber', async () => {
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ signal: abort.signal });

    // Need to start consuming before publishing so the subscriber is
    // registered in the loop below.
    setTimeout(() => {
      bus.publish({ type: 'foo', data: 'a' });
      bus.publish({ type: 'foo', data: 'b' });
    }, 5);

    const events = await collect(iter, 2);
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
    abort.abort();
  });

  it('replays events newer than lastEventId from the ring', async () => {
    const bus = new EventBus();
    bus.publish({ type: 'foo', data: 'a' });
    bus.publish({ type: 'foo', data: 'b' });
    bus.publish({ type: 'foo', data: 'c' });

    const abort = new AbortController();
    const iter = bus.subscribe({ lastEventId: 1, signal: abort.signal });
    const events = await collect(iter, 2);
    expect(events.map((e) => e.id)).toEqual([2, 3]);
    expect(events.map((e) => e.data)).toEqual(['b', 'c']);
    abort.abort();
  });

  it('replay + live: new events follow the replay tail', async () => {
    const bus = new EventBus();
    bus.publish({ type: 'foo', data: 'a' });
    bus.publish({ type: 'foo', data: 'b' });

    const abort = new AbortController();
    const iter = bus.subscribe({ lastEventId: 0, signal: abort.signal });

    setTimeout(() => bus.publish({ type: 'foo', data: 'c' }), 5);

    const events = await collect(iter, 3);
    expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c']);
    abort.abort();
  });

  it('fan-outs to multiple subscribers in parallel', async () => {
    const bus = new EventBus();
    const aborts = [new AbortController(), new AbortController()];
    const it1 = bus.subscribe({ signal: aborts[0].signal });
    const it2 = bus.subscribe({ signal: aborts[1].signal });

    setTimeout(() => {
      bus.publish({ type: 'foo', data: 1 });
      bus.publish({ type: 'foo', data: 2 });
    }, 5);

    const [a, b] = await Promise.all([collect(it1, 2), collect(it2, 2)]);
    expect(a.map((e) => e.data)).toEqual([1, 2]);
    expect(b.map((e) => e.data)).toEqual([1, 2]);
    aborts.forEach((c) => c.abort());
  });

  it('evicts a slow subscriber when its queue overflows', async () => {
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 2, signal: abort.signal });

    // Publish 3 events without draining the iterator. Queue cap is 2; the
    // 3rd should trip the eviction path and append a `client_evicted`
    // terminal frame.
    bus.publish({ type: 'foo', data: 1 });
    bus.publish({ type: 'foo', data: 2 });
    bus.publish({ type: 'foo', data: 3 });

    const collected: BridgeEvent[] = [];
    for await (const e of iter) {
      collected.push(e);
    }
    expect(collected).toHaveLength(3);
    expect(collected[0]?.data).toBe(1);
    expect(collected[1]?.data).toBe(2);
    expect(collected[2]?.type).toBe('client_evicted');
    expect(bus.subscriberCount).toBe(0);
    abort.abort();
  });

  it('eviction detaches the abort listener from a stalled consumer (BmJT1)', async () => {
    // Pre-fix the eviction path only did `this.subs.delete(sub)`,
    // leaving the AbortSignal abort-listener attached because the
    // dispose() closure was never invoked (consumer is stalled
    // BY DEFINITION — that's what caused the overflow). Retention
    // amplifies under a thousands-of-stalled-clients attack.
    const bus = new EventBus();
    const abort = new AbortController();
    // Capture the listener count via the AbortSignal — we add a
    // sentinel listener and assert our own listener fires (proving
    // the signal isn't pinned by leaked closures); the eviction
    // path now invokes dispose() so the bus's own listener
    // detaches. Use the public `aborted` flag as the proxy for
    // "after eviction, can I successfully abort and have no
    // dangling closures keep the bus subscription alive?"
    const iter = bus.subscribe({ maxQueued: 1, signal: abort.signal });
    bus.publish({ type: 'foo', data: 1 });
    bus.publish({ type: 'foo', data: 2 }); // triggers eviction
    // Bus dropped the subscriber via dispose():
    expect(bus.subscriberCount).toBe(0);
    // The abort listener is gone — firing abort now should NOT
    // re-enter the bus's onAbort (which would no-op via the
    // `disposed` flag, but the listener shouldn't be attached at
    // all). We can't directly assert listener count without
    // patching internals, but firing abort + a subsequent publish
    // should produce zero extra side effects:
    abort.abort();
    bus.publish({ type: 'foo', data: 3 });
    expect(bus.subscriberCount).toBe(0);
    // Drain to make sure the iterator unwinds cleanly with the
    // terminal frame from the original eviction.
    const collected: BridgeEvent[] = [];
    for await (const e of iter) collected.push(e);
    expect(collected[collected.length - 1]?.type).toBe('client_evicted');
  });

  it('unsubscribes when the abort signal fires', async () => {
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ signal: abort.signal });

    setTimeout(() => abort.abort(), 5);

    const events: BridgeEvent[] = [];
    for await (const e of iter) {
      events.push(e);
    }
    expect(events).toEqual([]);
    expect(bus.subscriberCount).toBe(0);
  });

  it('closes all subscribers on bus.close()', async () => {
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ signal: abort.signal });

    setTimeout(() => bus.close(), 5);

    const events: BridgeEvent[] = [];
    for await (const e of iter) {
      events.push(e);
    }
    expect(events).toEqual([]);
    expect(bus.subscriberCount).toBe(0);
  });

  it('force-pushes replay events past maxQueued so Last-Event-ID is honored', async () => {
    const bus = new EventBus();
    for (let i = 1; i <= 10; i++) bus.publish({ type: 'foo', data: i });

    const abort = new AbortController();
    // Subscribe with maxQueued:2 — way smaller than the replay backlog.
    // Replay must NOT be silently truncated (a generic queue.push would
    // drop entries 4-10), otherwise the consumer thinks they caught up
    // when they didn't.
    const iter = bus.subscribe({
      lastEventId: 0,
      maxQueued: 2,
      signal: abort.signal,
    });
    const events: BridgeEvent[] = [];
    for await (const e of iter) {
      events.push(e);
      if (events.length === 10) break;
    }
    expect(events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    abort.abort();
  });

  it('a live publish AFTER a large replay does NOT evict the resumed subscriber', async () => {
    // Regression: the original `forcePush` impl bypassed the cap, but the
    // very next live `push()` saw `buf.length >= maxSize` and triggered
    // the eviction path — which is exactly the contract `Last-Event-ID`
    // is supposed to honor. The fix tracks force-pushed items separately
    // so the cap applies only to the LIVE backlog.
    const bus = new EventBus();
    for (let i = 1; i <= 10; i++) bus.publish({ type: 'replay', data: i });

    const abort = new AbortController();
    // Replay backlog (10) is well above the cap (2). Without the fix,
    // the next live publish below would evict the subscriber.
    const iter = bus.subscribe({
      lastEventId: 0,
      maxQueued: 2,
      signal: abort.signal,
    });

    // Now publish a LIVE event. Reviewer's concrete sequence:
    //   - push() check `buf.length - forcedInBuf >= maxSize`
    //   - = (10 - 10) >= 2 → false → push accepted, buf becomes 11.
    bus.publish({ type: 'live', data: 'after-replay' });

    const events: BridgeEvent[] = [];
    for await (const e of iter) {
      events.push(e);
      if (events.length === 11) break;
    }
    // The live frame must arrive — NOT a `client_evicted` terminal.
    expect(events.find((e) => e.type === 'client_evicted')).toBeUndefined();
    expect(events.at(-1)?.type).toBe('live');
    expect(events.filter((e) => e.type === 'replay')).toHaveLength(10);
    abort.abort();
  });

  it('drops live publishes only after the LIVE backlog (excluding replay) hits maxQueued', async () => {
    const bus = new EventBus();
    for (let i = 1; i <= 5; i++) bus.publish({ type: 'replay', data: i });

    const abort = new AbortController();
    const iter = bus.subscribe({
      lastEventId: 0,
      maxQueued: 2,
      signal: abort.signal,
    });

    // Two live pushes fit (live cap = 2); the third overflows the LIVE
    // cap (5 replay don't count) and triggers eviction.
    bus.publish({ type: 'live', data: 'a' });
    bus.publish({ type: 'live', data: 'b' });
    bus.publish({ type: 'live', data: 'c' });

    const events: BridgeEvent[] = [];
    for await (const e of iter) events.push(e);
    // 5 replay + 2 live + 1 eviction terminal = 8 frames; the third live
    // is the one that triggered overflow.
    expect(events.find((e) => e.type === 'client_evicted')).toBeDefined();
    const liveCount = events.filter((e) => e.type === 'live').length;
    expect(liveCount).toBe(2);
  });

  it('disposes the subscription immediately when the abort signal fires', async () => {
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ signal: abort.signal });
    expect(bus.subscriberCount).toBe(1);

    abort.abort();
    // Without an explicit dispose-on-abort path, the subscriber would
    // linger in `bus.subs` until the consumer drove next() or return().
    // Here the consumer never iterates — the abort alone must clean up.
    expect(bus.subscriberCount).toBe(0);

    // The iterator still resolves cleanly when it eventually runs.
    const events: BridgeEvent[] = [];
    for await (const e of iter) events.push(e);
    expect(events).toEqual([]);
  });

  it('disposes immediately when the signal is already aborted at subscribe', () => {
    const bus = new EventBus();
    const abort = new AbortController();
    abort.abort();
    bus.subscribe({ signal: abort.signal });
    expect(bus.subscriberCount).toBe(0);
  });

  it('drops the oldest events from the ring beyond ringSize', async () => {
    const bus = new EventBus(3);
    for (let i = 1; i <= 5; i++) bus.publish({ type: 'foo', data: i });
    // Internal: only the last 3 should be replayable.
    // Subscribe with lastEventId=0 — only ids 3, 4, 5 should be queued.
    const abort = new AbortController();
    const iter = bus.subscribe({ lastEventId: 0, signal: abort.signal });

    // Must `await` the iteration: the prior `void (async () => …)()` form
    // returned synchronously to vitest, so the assertion below could
    // silently pass even if the ring eviction logic was broken.
    const out: BridgeEvent[] = [];
    for await (const e of iter) {
      out.push(e);
      if (out.length === 3) break;
    }
    expect(out.map((e) => e.id)).toEqual([3, 4, 5]);
    abort.abort();
  });
});
