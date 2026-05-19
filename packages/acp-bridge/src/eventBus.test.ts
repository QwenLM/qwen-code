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

  it('evicts a slow subscriber when its queue overflows (warning precedes eviction)', async () => {
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 2, signal: abort.signal });

    // Publish 3 events without draining the iterator. Queue cap is 2;
    // event 2 fills the queue to 100% (above the 75% warn threshold),
    // so the bus force-pushes a `slow_client_warning`; event 3 then
    // trips the eviction path and appends a `client_evicted`
    // terminal frame.
    bus.publish({ type: 'foo', data: 1 });
    bus.publish({ type: 'foo', data: 2 });
    bus.publish({ type: 'foo', data: 3 });

    const collected: BridgeEvent[] = [];
    for await (const e of iter) {
      collected.push(e);
    }
    expect(collected).toHaveLength(4);
    expect(collected[0]?.data).toBe(1);
    expect(collected[1]?.data).toBe(2);
    expect(collected[2]?.type).toBe('slow_client_warning');
    expect(collected[3]?.type).toBe('client_evicted');
    expect(bus.subscriberCount).toBe(0);
    abort.abort();
  });

  it('emits slow_client_warning exactly once per overflow episode', async () => {
    // Queue size 8; warn threshold = 75% = 6. Push to 6 → warning
    // fires; push to 7 → no additional warning (sub.warned latched).
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 8, signal: abort.signal });

    for (let i = 1; i <= 7; i++) bus.publish({ type: 'foo', data: i });

    const collected: BridgeEvent[] = [];
    // Drain 8 items (7 publishes + 1 warning).
    for (let i = 0; i < 8; i++) {
      const { value, done } = await iter[Symbol.asyncIterator]().next();
      if (done) break;
      collected.push(value);
    }
    const warnings = collected.filter((e) => e.type === 'slow_client_warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.data).toMatchObject({ maxQueued: 8 });
    abort.abort();
  });

  it('slow_client_warning frame has no id (synthetic, no sequence slot)', async () => {
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 2, signal: abort.signal });
    bus.publish({ type: 'foo', data: 1 });
    bus.publish({ type: 'foo', data: 2 });
    bus.publish({ type: 'foo', data: 3 });

    const collected: BridgeEvent[] = [];
    for await (const e of iter) collected.push(e);
    const warning = collected.find((e) => e.type === 'slow_client_warning');
    const evicted = collected.find((e) => e.type === 'client_evicted');
    expect(warning).toBeDefined();
    expect(warning!.id).toBeUndefined();
    expect(evicted!.id).toBeUndefined();
    // The two live events that DID make it through must carry
    // contiguous ids — synthetic frames must not burn a slot.
    const live = collected.filter((e) => e.type === 'foo');
    expect(live.map((e) => e.id)).toEqual([1, 2]);
    abort.abort();
  });

  it('rearms slow_client_warning after queue drains below the hysteresis threshold', async () => {
    // Threshold 75%, reset 37.5%. maxQueued=8 → warn at 6, reset at 3.
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 8, signal: abort.signal });
    const it = iter[Symbol.asyncIterator]();

    // Fill to 6 → first warning fires (force-pushed AFTER the 6th
    // event, so it sits at the back of the queue behind the 6 live
    // events).
    for (let i = 1; i <= 6; i++) bus.publish({ type: 'foo', data: i });
    // Drain all 7 items (events 1–6 + warning frame) — leaves the
    // queue empty, well below the 3-item reset threshold.
    const firstEpisode: BridgeEvent[] = [];
    for (let i = 0; i < 7; i++) firstEpisode.push((await it.next()).value);
    expect(
      firstEpisode.filter((e) => e.type === 'slow_client_warning'),
    ).toHaveLength(1);

    // Trigger another publish so the hysteresis check inside publish()
    // observes the drained queue and re-arms sub.warned. After this
    // publish, live size = 1, well below the 3-item reset threshold.
    bus.publish({ type: 'foo', data: 7 });
    expect((await it.next()).value.data).toBe(7);

    // Re-fill back past the threshold — second overflow episode must
    // produce a second warning because the flag was re-armed.
    for (let i = 8; i <= 13; i++) bus.publish({ type: 'foo', data: i });
    const secondEpisode: BridgeEvent[] = [];
    for (let i = 0; i < 7; i++) secondEpisode.push((await it.next()).value);
    expect(
      secondEpisode.filter((e) => e.type === 'slow_client_warning'),
    ).toHaveLength(1);
    abort.abort();
  });

  it('warn-at-back forced frame does NOT skew the live cap for subsequent publishes (codex P2)', async () => {
    // Regression for the `forcedInBuf` position-invariant bug Codex
    // flagged: a mid-stream slow_client_warning force-pushed to the
    // BACK of the queue, then drained past, would previously cause
    // `next()` to decrement the forced counter on a LIVE shift,
    // making subsequent `push()` cap checks under-count live items
    // and warn/evict the client before they actually had `maxQueued`
    // live items in queue.
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 8, signal: abort.signal });
    const it = iter[Symbol.asyncIterator]();

    // Episode 1: fill to 6 → warn at 75%. buf = [1..6, warning].
    for (let i = 1; i <= 6; i++) bus.publish({ type: 'foo', data: i });

    // Drain ALL 7 items (events 1..6 + warning frame). Live cap should
    // now be 0 — the warning was a forced frame and must NOT have
    // counted as a live drain.
    const drained: BridgeEvent[] = [];
    for (let i = 0; i < 7; i++) drained.push((await it.next()).value);
    expect(
      drained.filter((e) => e.type === 'slow_client_warning'),
    ).toHaveLength(1);

    // Refill to EXACTLY maxQueued (8). Pre-fix: the post-drain live
    // count was wrong, so somewhere between pushes 5 and 7 the 75%
    // threshold (live=6) fired a second warning prematurely or the
    // push at 7 was even rejected. Post-fix: live count is the truth,
    // and the second warning fires exactly at push 8 (live=8, queue
    // full → push 8 fills the cap and either succeeds at the cap line
    // or trips the warn check first).
    let rejected = 0;
    for (let i = 7; i <= 14; i++) {
      // Stop publishing once the queue refuses — the 8th live publish
      // is the maxQueued ceiling.
      const ok = bus.publish({ type: 'foo', data: i }) !== undefined;
      if (!ok) rejected++;
    }
    void rejected; // EventBus.publish never returns false; rejection
    // happens inside the bus when subscriber queues fill.

    // Drain everything that's still alive in the iter. The exact frame
    // shape varies (depending on whether the bus also force-pushed a
    // second warning + evicted), but the ASSERTION we need is: the
    // sub didn't get evicted on a phantom premature overflow — i.e.
    // we received MORE THAN 1 live frame in this episode (pre-fix,
    // the live count drift evicted after 0-1 frames).
    const episode2: BridgeEvent[] = [];
    for (let i = 0; i < 9; i++) {
      const { value, done } = await it.next();
      if (done) break;
      episode2.push(value);
    }
    const live2 = episode2.filter((e) => e.id !== undefined && e.id >= 7);
    // Pre-fix: live2 would be <8 because the queue evicted prematurely
    // after the buggy live count drift. Post-fix: all 8 live frames
    // (ids 7..14) get through cleanly.
    expect(live2.length).toBeGreaterThanOrEqual(8);
    abort.abort();
  });

  it('default ring size is 8000 (#3803 §02 target)', async () => {
    const bus = new EventBus();
    for (let i = 1; i <= 8001; i++) bus.publish({ type: 'foo', data: i });
    // After publishing 8001 frames into the default ring, the replay
    // backlog should hold the most recent 8000 (oldest dropped).
    // A `lastEventId: 0` resume with a queue cap larger than the ring
    // collects exactly 8000 live frames; ids start at 2 because id=1
    // was the one shifted out of the ring.
    const abort = new AbortController();
    const iter = bus.subscribe({
      lastEventId: 0,
      maxQueued: 9000,
      signal: abort.signal,
    });
    const events = await collect(iter, 8000);
    abort.abort();
    const liveIds = events
      .filter((e) => e.id !== undefined)
      .map((e) => e.id as number);
    expect(liveIds).toHaveLength(8000);
    expect(liveIds[0]).toBe(2);
    expect(liveIds[liveIds.length - 1]).toBe(8001);
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
