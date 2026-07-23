/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_QUEUED_BYTES,
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
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assigns monotonic ids and the right schema version', () => {
    const bus = new EventBus();
    const a = bus.publish({ type: 'foo', data: 1 });
    const b = bus.publish({ type: 'foo', data: 2 });
    expect(a?.id).toBe(1);
    expect(b?.id).toBe(2);
    expect(a?.v).toBe(EVENT_SCHEMA_VERSION);
    expect(bus.lastEventId).toBe(2);
  });

  it('rejects invalid maxQueuedBytes options', () => {
    expect(
      () => new EventBus(100, undefined, undefined, { maxQueuedBytes: 0 }),
    ).toThrow(TypeError);
    expect(
      () =>
        new EventBus(100, undefined, undefined, {
          maxQueuedBytes: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new EventBus(100, undefined, undefined, {
          maxQueuedBytes: Number.MAX_SAFE_INTEGER + 1,
        }),
    ).toThrow(TypeError);
  });

  it('stamps published events with serverTimestamp metadata', () => {
    const bus = new EventBus();
    const before = Date.now();
    const event = bus.publish({
      type: 'foo',
      data: 1,
      _meta: { source: 'test' },
    });
    const after = Date.now();

    expect(event?._meta?.['source']).toBe('test');
    expect(event?._meta?.['serverTimestamp']).toBeGreaterThanOrEqual(before);
    expect(event?._meta?.['serverTimestamp']).toBeLessThanOrEqual(after);
  });

  it('preserves an existing serverTimestamp when publishing', () => {
    const bus = new EventBus();
    const event = bus.publish({
      type: 'foo',
      data: 1,
      _meta: { serverTimestamp: 123 },
    });

    expect(event?._meta?.['serverTimestamp']).toBe(123);
  });

  it('delivers live publishes to a subscriber', async () => {
    const bus = new EventBus();
    const abort = new AbortController();
    const iter = bus.subscribe({ signal: abort.signal });

    // Need to start consuming before publishing so the subscriber is
    // registered in the loop below.
    setTimeout(() => {
      bus.publish({ type: 'foo', data: 'a', promptId: 'prompt-live' });
      bus.publish({ type: 'foo', data: 'b' });
    }, 5);

    const events = await collect(iter, 2);
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
    expect(events.map((e) => e.promptId)).toEqual(['prompt-live', undefined]);
    abort.abort();
  });

  it('replays events newer than lastEventId from the ring', async () => {
    const bus = new EventBus();
    bus.publish({ type: 'foo', data: 'a', promptId: 'prompt-a' });
    bus.publish({ type: 'foo', data: 'b', promptId: 'prompt-b' });
    bus.publish({ type: 'foo', data: 'c', promptId: 'prompt-c' });

    const abort = new AbortController();
    const iter = bus.subscribe({ lastEventId: 1, signal: abort.signal });
    const events = await collect(iter, 2);
    expect(events.map((e) => e.id)).toEqual([2, 3]);
    expect(events.map((e) => e.data)).toEqual(['b', 'c']);
    expect(events.map((e) => e.promptId)).toEqual(['prompt-b', 'prompt-c']);
    abort.abort();
  });

  it('replay + live: new events follow the replay tail (with replay_complete sentinel)', async () => {
    const bus = new EventBus();
    bus.publish({ type: 'foo', data: 'a' });
    bus.publish({ type: 'foo', data: 'b' });

    const abort = new AbortController();
    const iter = bus.subscribe({ lastEventId: 0, signal: abort.signal });

    setTimeout(() => bus.publish({ type: 'foo', data: 'c' }), 5);

    // The replay loop drains the ring, emits a `replay_complete`
    // sentinel (id-less, lets consumers drop catch-up indicators), and
    // then live events flow. Sentinel goes AFTER the ring tail so the
    // consumer sees historical frames first, then the "you're live now"
    // signal, then live events.
    const events = await collect(iter, 4);
    expect(events.map((e) => e.type)).toEqual([
      'foo',
      'foo',
      'replay_complete',
      'foo',
    ]);
    expect(events.map((e) => e.data)).toEqual([
      'a',
      'b',
      // D4: canonical `lastReplayedEventId` + deprecated `lastEventId` alias.
      expect.objectContaining({
        lastReplayedEventId: 2,
        lastEventId: 2,
        replayedCount: 2,
      }),
      'c',
    ]);
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
    expect(collected[3]?.data).toMatchObject({
      reason: 'queue_overflow',
      queueSize: 2,
      maxQueued: 2,
      maxQueuedBytes: DEFAULT_MAX_QUEUED_BYTES,
    });
    expect(
      (collected[3]?.data as { queuedBytes?: number }).queuedBytes,
    ).toBeGreaterThan(0);
    expect(
      (collected[3]?.data as { eventBytes?: number }).eventBytes,
    ).toBeUndefined();
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining(
        'qwen serve: EventBus subscriber evicted {"reason":"queue_overflow"',
      ),
    );
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
    expect(warnings[0]?.data).toMatchObject({
      maxQueued: 8,
      threshold: 'frames',
    });
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining(
        'qwen serve: EventBus slow_client_warning {"queueSize":6,"maxQueued":8',
      ),
    );
    abort.abort();
  });

  it('reports frames_and_bytes when both warning thresholds are crossed', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 1200,
    });
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 4, signal: abort.signal });

    for (let i = 1; i <= 3; i++) {
      bus.publish({
        type: 'foo',
        data: 'x'.repeat(300),
        _meta: { serverTimestamp: i },
      });
    }

    const collected: BridgeEvent[] = [];
    const it = iter[Symbol.asyncIterator]();
    for (let i = 0; i < 4; i++) collected.push((await it.next()).value);

    const warning = collected.find((e) => e.type === 'slow_client_warning');
    expect(warning?.data).toMatchObject({
      queueSize: 3,
      maxQueued: 4,
      maxQueuedBytes: 1200,
      threshold: 'frames_and_bytes',
      lastEventId: 3,
    });
    expect(
      (warning?.data as { queuedBytes?: number }).queuedBytes,
    ).toBeGreaterThanOrEqual(900);
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

  it('does not rearm slow_client_warning until frame and byte backlogs both reset', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 16000,
    });
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 8, signal: abort.signal });
    const it = iter[Symbol.asyncIterator]();

    for (let i = 1; i <= 6; i++) {
      bus.publish({
        type: 'foo',
        data: 'x'.repeat(2400),
        _meta: { serverTimestamp: i },
      });
    }

    const partiallyDrained: BridgeEvent[] = [];
    for (let i = 0; i < 3; i++) {
      partiallyDrained.push((await it.next()).value);
    }
    expect(
      partiallyDrained.filter((e) => e.type === 'slow_client_warning'),
    ).toHaveLength(0);

    for (let i = 7; i <= 9; i++) {
      bus.publish({
        type: 'foo',
        data: 'y'.repeat(2400),
        _meta: { serverTimestamp: i },
      });
    }

    const afterPartialDrain: BridgeEvent[] = [];
    for (let i = 0; i < 7; i++) {
      afterPartialDrain.push((await it.next()).value);
    }
    expect(
      afterPartialDrain.filter((e) => e.type === 'slow_client_warning'),
    ).toHaveLength(1);

    bus.publish({
      type: 'foo',
      data: 'small',
      _meta: { serverTimestamp: 10 },
    });
    expect((await it.next()).value.data).toBe('small');

    for (let i = 11; i <= 16; i++) {
      bus.publish({
        type: 'foo',
        data: 'z'.repeat(2400),
        _meta: { serverTimestamp: i },
      });
    }

    const afterFullReset: BridgeEvent[] = [];
    for (let i = 0; i < 7; i++) {
      afterFullReset.push((await it.next()).value);
    }
    expect(
      afterFullReset.filter((e) => e.type === 'slow_client_warning'),
    ).toHaveLength(1);
    abort.abort();
  });

  it('evicts a slow subscriber when live queued bytes overflow', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 1200,
    });
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 100, signal: abort.signal });

    bus.publish({
      type: 'foo',
      data: 'x'.repeat(1000),
      _meta: { serverTimestamp: 1 },
    });
    bus.publish({
      type: 'foo',
      data: 'y'.repeat(1000),
      _meta: { serverTimestamp: 2 },
    });

    const collected: BridgeEvent[] = [];
    for await (const e of iter) collected.push(e);

    const live = collected.filter((e) => e.type === 'foo');
    const evicted = collected.find((e) => e.type === 'client_evicted');
    expect(live).toHaveLength(1);
    expect(evicted).toBeDefined();
    expect(evicted!.id).toBeUndefined();
    expect(evicted!.data).toMatchObject({
      reason: 'queue_bytes_overflow',
      droppedAfter: 2,
      queueSize: 1,
      maxQueued: 100,
      maxQueuedBytes: 1200,
    });
    expect(
      (evicted!.data as { queuedBytes?: number }).queuedBytes,
    ).toBeGreaterThan(0);
    expect(
      (evicted!.data as { eventBytes?: number }).eventBytes,
    ).toBeGreaterThan(0);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining(
        'qwen serve: EventBus subscriber evicted {"reason":"queue_bytes_overflow"',
      ),
    );
    expect(bus.subscriberCount).toBe(0);
    abort.abort();
  });

  it('keeps sibling subscribers alive after one subscriber is byte-evicted', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 1200,
    });
    const slowAbort = new AbortController();
    const fastAbort = new AbortController();
    const slowIter = bus.subscribe({
      maxQueued: 100,
      signal: slowAbort.signal,
    });
    const fastIter = bus.subscribe({
      maxQueued: 100,
      signal: fastAbort.signal,
    });
    const fastIt = fastIter[Symbol.asyncIterator]();

    const fastFirst = fastIt.next();
    bus.publish({
      type: 'foo',
      data: 'x'.repeat(1000),
      _meta: { serverTimestamp: 1 },
    });
    expect((await fastFirst).value.data).toBe('x'.repeat(1000));

    const fastSecond = fastIt.next();
    bus.publish({
      type: 'foo',
      data: 'y'.repeat(1000),
      _meta: { serverTimestamp: 2 },
    });
    expect((await fastSecond).value.data).toBe('y'.repeat(1000));

    const slowEvents: BridgeEvent[] = [];
    for await (const e of slowIter) slowEvents.push(e);
    expect(
      slowEvents.find((e) => e.type === 'client_evicted')?.data,
    ).toMatchObject({
      reason: 'queue_bytes_overflow',
      droppedAfter: 2,
    });
    expect(bus.subscriberCount).toBe(1);

    const fastThird = fastIt.next();
    bus.publish({
      type: 'foo',
      data: 'tail',
      _meta: { serverTimestamp: 3 },
    });
    expect((await fastThird).value.data).toBe('tail');

    await fastIt.return?.();
    slowAbort.abort();
    fastAbort.abort();
  });

  it('allows one oversized live event on an empty queue before byte eviction', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 256,
    });
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 100, signal: abort.signal });

    bus.publish({
      type: 'foo',
      data: 'x'.repeat(1024),
      _meta: { serverTimestamp: 1 },
    });
    bus.publish({
      type: 'foo',
      data: 'tail',
      _meta: { serverTimestamp: 2 },
    });

    const collected: BridgeEvent[] = [];
    for await (const e of iter) collected.push(e);

    expect(collected[0]?.type).toBe('foo');
    const warning = collected.find((e) => e.type === 'slow_client_warning');
    expect(warning).toBeDefined();
    expect(warning!.id).toBeUndefined();
    expect(warning!.data).toMatchObject({
      queueSize: 1,
      maxQueued: 100,
      maxQueuedBytes: 256,
      threshold: 'bytes',
      lastEventId: 1,
    });
    expect(
      (warning!.data as { queuedBytes?: number }).queuedBytes,
    ).toBeGreaterThan(256);

    const evicted = collected.find((e) => e.type === 'client_evicted');
    expect(evicted?.data).toMatchObject({
      reason: 'queue_bytes_overflow',
      droppedAfter: 2,
    });
    abort.abort();
  });

  it('rejects an unserializable event without throwing, even with a waiting subscriber', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 1,
    });
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 100, signal: abort.signal });
    const it = iter[Symbol.asyncIterator]();
    const next = it.next();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    // never-throws holds; the circular event is rejected at the
    // serializability gate (DAEMON-011) instead of being delivered
    // with a fake 0-byte weight.
    expect(() => bus.publish({ type: 'foo', data: circular })).not.toThrow();
    expect(bus.publish({ type: 'foo', data: 'tail' })?.id).toBe(1);

    const delivered = await next;
    expect(delivered.done).toBe(false);
    expect(delivered.value.data).toBe('tail');
    expect(bus.subscriberCount).toBe(1);
    await it.return?.();
    abort.abort();
  });

  it('rejects a buffered unserializable event and keeps the queue healthy', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 256,
    });
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 100, signal: abort.signal });
    const it = iter[Symbol.asyncIterator]();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => {
      bus.publish({
        type: 'foo',
        data: circular,
        _meta: { serverTimestamp: 1 },
      });
      bus.publish({
        type: 'foo',
        data: 'tail',
        _meta: { serverTimestamp: 2 },
      });
    }).not.toThrow();

    // The unserializable event is rejected at the gate (DAEMON-011);
    // only the healthy tail event reaches the buffered queue.
    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value.data).toBe('tail');
    expect(first.value.id).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining(
        'qwen serve: EventBus event sizing failed {"type":"foo"}',
      ),
    );
    expect(bus.subscriberCount).toBe(1);
    await it.return?.();
    abort.abort();
  });

  it('does not count replay frames toward queued bytes', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 64,
    });
    for (let i = 1; i <= 3; i++) {
      bus.publish({
        type: 'replay',
        data: 'x'.repeat(512),
        _meta: { serverTimestamp: i },
      });
    }

    const abort = new AbortController();
    const iter = bus.subscribe({
      lastEventId: 0,
      maxQueued: 2,
      signal: abort.signal,
    });
    bus.publish({
      type: 'live',
      data: 'y'.repeat(512),
      _meta: { serverTimestamp: 4 },
    });

    const events: BridgeEvent[] = [];
    for await (const e of iter) {
      events.push(e);
      if (events.length === 5) break;
    }

    expect(events.find((e) => e.type === 'client_evicted')).toBeUndefined();
    expect(events.filter((e) => e.type === 'replay')).toHaveLength(3);
    expect(events.find((e) => e.type === 'replay_complete')).toBeDefined();
    expect(events.at(-1)?.type).toBe('live');
    abort.abort();
  });

  it('rearms byte-based slow_client_warning after queued bytes drain', async () => {
    const bus = new EventBus(100, undefined, undefined, {
      maxQueuedBytes: 1200,
    });
    const abort = new AbortController();
    const iter = bus.subscribe({ maxQueued: 100, signal: abort.signal });
    const it = iter[Symbol.asyncIterator]();

    bus.publish({
      type: 'foo',
      data: 'x'.repeat(1000),
      _meta: { serverTimestamp: 1 },
    });
    const firstEpisode: BridgeEvent[] = [];
    firstEpisode.push((await it.next()).value);
    firstEpisode.push((await it.next()).value);
    expect(
      firstEpisode.filter((e) => e.type === 'slow_client_warning'),
    ).toHaveLength(1);

    // A large event can jump from fully drained to above the byte warn
    // threshold; that single publish must not both re-arm and warn.
    bus.publish({
      type: 'foo',
      data: 'y'.repeat(1000),
      _meta: { serverTimestamp: 2 },
    });
    expect((await it.next()).value.data).toBe('y'.repeat(1000));

    bus.publish({
      type: 'foo',
      data: 'reset',
      _meta: { serverTimestamp: 3 },
    });
    expect((await it.next()).value.data).toBe('reset');

    bus.publish({
      type: 'foo',
      data: 'z'.repeat(1000),
      _meta: { serverTimestamp: 4 },
    });
    const secondEpisode: BridgeEvent[] = [];
    secondEpisode.push((await it.next()).value);
    secondEpisode.push((await it.next()).value);
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
    //
    // #4175 F4 prereq: `lastEventId: 0` + earliest-id-in-ring = 2
    // crosses the eviction-detection threshold (earliest > last + 1),
    // so an extra synthetic `state_resync_required` frame is emitted
    // FIRST. The filter below restricts to live ids, which excludes
    // the synthetic (no id), so the original "8000 live frames"
    // invariant is preserved.
    const abort = new AbortController();
    const iter = bus.subscribe({
      lastEventId: 0,
      maxQueued: 9000,
      signal: abort.signal,
    });
    // Collect 8001 frames now: 1 synthetic resync + 8000 live.
    const events = await collect(iter, 8001);
    abort.abort();
    const liveIds = events
      .filter((e) => e.id !== undefined)
      .map((e) => e.id as number);
    expect(liveIds).toHaveLength(8000);
    expect(liveIds[0]).toBe(2);
    expect(liveIds[liveIds.length - 1]).toBe(8001);
    // The synthetic resync frame is the first one.
    expect(events[0]?.type).toBe('state_resync_required');
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
      // 10 replay + 1 replay_complete sentinel + 1 live = 12 total
      if (events.length === 12) break;
    }
    // The live frame must arrive — NOT a `client_evicted` terminal.
    expect(events.find((e) => e.type === 'client_evicted')).toBeUndefined();
    expect(events.at(-1)?.type).toBe('live');
    expect(events.filter((e) => e.type === 'replay')).toHaveLength(10);
    // `replay_complete` sentinel signals end-of-replay before live frames.
    expect(events.filter((e) => e.type === 'replay_complete')).toHaveLength(1);
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
      // state_resync_required (synthetic) + 3 replay frames +
      // replay_complete sentinel = 5 frames.
      if (out.length === 5) break;
    }
    // First frame is the synthetic state_resync_required (no id).
    expect(out[0]?.type).toBe('state_resync_required');
    expect(out[0]?.id).toBeUndefined();
    // Then the 3 surviving ring frames.
    expect(out.slice(1, 4).map((e) => e.id)).toEqual([3, 4, 5]);
    // The replay_complete sentinel fires at the end of replay even on
    // the resync path — `replayedCount` is the actual frames pushed (3),
    // NOT `earliestAvailableId - lastEventId` (which would over-count
    // across the evicted hole).
    expect(out[4]?.type).toBe('replay_complete');
    expect(out[4]?.id).toBeUndefined();
    expect(out[4]?.data).toMatchObject({ replayedCount: 3 });
    abort.abort();
  });

  describe('state_resync_required (#4175 F4 prereq, Ilya0527 issue #15)', () => {
    it('emits state_resync_required when lastEventId is past the ring head', async () => {
      // Setup: ring holds 3, ids 1..5 published → ring contains [3,4,5].
      // Consumer reconnects with Last-Event-ID: 1 → events 2 was evicted.
      // Daemon must emit state_resync_required FIRST so SDK reducer
      // knows its state is stale before applying any replay frames.
      const bus = new EventBus(3);
      for (let i = 1; i <= 5; i++) bus.publish({ type: 'foo', data: i });
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 1,
        signal: abort.signal,
      });
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // resync + 3 replay frames + replay_complete = 5.
        if (out.length === 5) break;
      }
      // First frame is the resync terminal (synthetic, no id).
      expect(out[0]?.type).toBe('state_resync_required');
      expect(out[0]?.id).toBeUndefined();
      const data = out[0]?.data as {
        reason: string;
        lastDeliveredId: number;
        earliestAvailableId: number;
      };
      expect(data.reason).toBe('ring_evicted');
      expect(data.lastDeliveredId).toBe(1);
      expect(data.earliestAvailableId).toBe(3); // event 2 was evicted
      // Replay continues after the resync frame (per design — SDK can
      // compute "what you missed" diff later) — so we still get the
      // 3 surviving ring frames.
      expect(out.slice(1, 4).map((e) => e.id)).toEqual([3, 4, 5]);
      // replay_complete sentinel closes the replay even when a resync
      // gap preceded it; replayedCount counts only the 3 surviving
      // frames actually delivered (not the evicted hole).
      expect(out[4]?.type).toBe('replay_complete');
      expect(out[4]?.data).toMatchObject({ replayedCount: 3 });
      abort.abort();
    });

    it('does NOT emit state_resync_required when lastEventId is in the ring', async () => {
      // Consumer's lastEventId is well within the ring → no gap → no
      // resync needed.
      const bus = new EventBus(10);
      for (let i = 1; i <= 5; i++) bus.publish({ type: 'foo', data: i });
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 2,
        signal: abort.signal,
      });
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        if (out.length === 3) break;
      }
      // No resync frame — just the 3 replay frames (ids 3, 4, 5).
      expect(out.map((e) => e.id)).toEqual([3, 4, 5]);
      expect(out.some((e) => e.type === 'state_resync_required')).toBe(false);
      abort.abort();
    });

    it('does NOT emit state_resync_required at the exact boundary (lastEventId === earliest - 1)', async () => {
      // Boundary: ring's earliest id is N, lastEventId is N-1.
      // No gap → no resync. Off-by-one guard.
      const bus = new EventBus(3);
      for (let i = 1; i <= 5; i++) bus.publish({ type: 'foo', data: i });
      // Ring is now [3, 4, 5]. lastEventId=2 means "I have 1 and 2";
      // next expected is 3, which IS in the ring. No gap.
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 2,
        signal: abort.signal,
      });
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // 3 replay frames + 1 replay_complete sentinel = 4 total
        if (out.length === 4) break;
      }
      expect(out.some((e) => e.type === 'state_resync_required')).toBe(false);
      // Replay frames in order, then the sentinel (id-less, signals
      // catch-up complete).
      expect(out.filter((e) => e.type === 'foo').map((e) => e.id)).toEqual([
        3, 4, 5,
      ]);
      expect(out.filter((e) => e.type === 'replay_complete')).toHaveLength(1);
      abort.abort();
    });

    it('emits epoch_reset resync when lastEventId is past the bus high-water (D1)', async () => {
      // doudouOUC #4484 post-merge review (D1): a fresh bus (nextId=1,
      // empty ring) that receives a consumer presenting `lastEventId: 5`
      // means the consumer's cursor is from a PREVIOUS bus epoch (daemon
      // restart rebuilt the EventBus). Pre-fix this slid past the
      // `ring_evicted` check (empty ring) and emitted a bare
      // `replay_complete{replayedCount:0}` — a false "you're caught up"
      // while the consumer's reducer still held dead-epoch state. Now it
      // must emit `state_resync_required{reason:'epoch_reset'}` first.
      const bus = new EventBus(10);
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 5,
        signal: abort.signal,
      });
      // Publish one live event AFTER subscribe to confirm the stream works.
      setTimeout(() => bus.publish({ type: 'foo', data: 1 }), 0);
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // resync + replay_complete (0 frames) + 1 live = 3 total.
        if (out.length === 3) break;
      }
      expect(out[0]?.type).toBe('state_resync_required');
      expect(out[0]?.id).toBeUndefined();
      const data = out[0]?.data as {
        reason: string;
        lastDeliveredId: number;
        earliestAvailableId: number;
      };
      expect(data.reason).toBe('epoch_reset');
      expect(data.lastDeliveredId).toBe(5);
      expect(data.earliestAvailableId).toBe(1);
      expect(out[1]?.type).toBe('replay_complete');
      expect(out[1]?.data).toMatchObject({ replayedCount: 0 });
      expect(out[2]?.type).toBe('foo');
      expect(out[2]?.id).toBe(1);
      abort.abort();
    });

    it('epoch_reset replays the WHOLE fresh ring (stale cursor must not filter new low ids)', async () => {
      // After a restart the new epoch starts ids at 1 again. A consumer
      // reconnecting with `lastEventId: 50` (dead epoch) must still receive
      // the fresh ring's low-id events — filtering replay by 50 would drop
      // ids 1..3 entirely, leaving the consumer permanently behind.
      const bus = new EventBus(10);
      for (let i = 1; i <= 3; i++) bus.publish({ type: 'foo', data: i });
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 50,
        signal: abort.signal,
      });
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // resync + 3 replay frames + replay_complete = 5.
        if (out.length === 5) break;
      }
      expect(out[0]?.type).toBe('state_resync_required');
      expect((out[0]?.data as { reason: string }).reason).toBe('epoch_reset');
      // All three fresh events replay despite ids < stale cursor.
      expect(out.slice(1, 4).map((e) => e.id)).toEqual([1, 2, 3]);
      expect(out[4]?.type).toBe('replay_complete');
      expect(out[4]?.data).toMatchObject({ replayedCount: 3 });
      abort.abort();
    });

    it('does NOT emit epoch_reset at the caught-up boundary (lastEventId === high-water)', async () => {
      // Consumer fully caught up: lastEventId equals the bus high-water
      // (nextId - 1). nextId is one past it, so `lastEventId >= nextId` is
      // false — no epoch reset. Off-by-one guard for D1.
      const bus = new EventBus(10);
      for (let i = 1; i <= 3; i++) bus.publish({ type: 'foo', data: i });
      // high-water is 3; nextId is 4. lastEventId: 3 is the caught-up case.
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 3,
        signal: abort.signal,
      });
      setTimeout(() => bus.publish({ type: 'foo', data: 99 }), 0);
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // replay_complete (0 frames) + 1 live = 2.
        if (out.length === 2) break;
      }
      expect(out.some((e) => e.type === 'state_resync_required')).toBe(false);
      expect(out[0]?.type).toBe('replay_complete');
      expect(out[1]?.id).toBe(4);
      abort.abort();
    });

    it('does NOT emit state_resync_required when no lastEventId is provided (fresh subscribe)', async () => {
      // First-time subscriber has no prior state to resync — resync
      // would be meaningless. Check the no-lastEventId branch is
      // skipped entirely.
      const bus = new EventBus(3);
      for (let i = 1; i <= 5; i++) bus.publish({ type: 'foo', data: i });
      const abort = new AbortController();
      const iter = bus.subscribe({ signal: abort.signal });
      // Live-only — publish one event after subscribe to give the
      // iterator something to yield.
      setTimeout(() => bus.publish({ type: 'foo', data: 99 }), 0);
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        if (out.length === 1) break;
      }
      expect(out[0]?.type).toBe('foo');
      expect(out.some((e) => e.type === 'state_resync_required')).toBe(false);
      abort.abort();
    });
  });

  describe('serializability gate (DAEMON-011)', () => {
    it('rejects an unserializable event without burning an id', async () => {
      const bus = new EventBus();
      const abort = new AbortController();
      const iter = bus.subscribe({ signal: abort.signal });

      const ok1 = bus.publish({ type: 'foo', data: 1 });
      const rejected = bus.publish({
        type: 'bad',
        data: { big: BigInt(1) },
      });
      const ok2 = bus.publish({ type: 'foo', data: 2 });

      expect(ok1?.id).toBe(1);
      expect(rejected).toBeUndefined();
      // The rejected event must not burn an id — a gap would be misread
      // as ring eviction by resume logic.
      expect(ok2?.id).toBe(2);
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining('EventBus event sizing failed'),
      );

      // Live fanout skips the rejected event entirely.
      const collected = await collect(iter, 2);
      expect(collected.map((e) => e.data)).toEqual([1, 2]);
      abort.abort();

      // Replay (ring) never saw it either.
      const replayAbort = new AbortController();
      const replayed = await collect(
        bus.subscribe({ lastEventId: 0, signal: replayAbort.signal }),
        3,
      );
      expect(replayed.map((e) => e.type)).toEqual([
        'foo',
        'foo',
        'replay_complete',
      ]);
      replayAbort.abort();
    });

    it('does not ingest a rejected event into the compaction engine', () => {
      const ingested: BridgeEvent[] = [];
      const engine = {
        ingest(event: BridgeEvent) {
          ingested.push(event);
        },
        seedReplayEvents() {},
        snapshot() {
          return { compactedTurns: [], liveJournal: [], lastEventId: 0 };
        },
        close() {},
      };
      const bus = new EventBus(100, undefined, engine);

      bus.publish({ type: 'ok', data: 1 });
      bus.publish({ type: 'bad', data: { big: BigInt(1) } });

      expect(ingested.map((e) => e.type)).toEqual(['ok']);
    });
  });

  describe('replay budget (DAEMON-011)', () => {
    const bigPayload = () => 'x'.repeat(100);

    it('truncates an over-budget replay burst and demands a resync', async () => {
      const bus = new EventBus(100, undefined, undefined, {
        replayBudgetBytes: 400,
      });
      for (let i = 0; i < 5; i++) {
        bus.publish({ type: 'payload', data: bigPayload() });
      }

      const abort = new AbortController();
      const iter = bus.subscribe({ lastEventId: 0, signal: abort.signal });
      const it = iter[Symbol.asyncIterator]();
      const frames: BridgeEvent[] = [];
      for (let i = 0; i < 4; i++) {
        frames.push((await it.next()).value as BridgeEvent);
      }

      // Two ~190-byte frames fit the 400-byte budget; the third trips it.
      expect(frames[0]?.id).toBe(1);
      expect(frames[1]?.id).toBe(2);
      expect(frames[2]?.type).toBe('state_resync_required');
      expect(frames[2]?.data).toEqual({
        reason: 'replay_budget_exceeded',
        lastDeliveredId: 2,
        earliestAvailableId: 3,
      });
      expect(frames[3]?.type).toBe('replay_complete');
      expect((frames[3]?.data as { replayedCount: number }).replayedCount).toBe(
        2,
      );

      // Truncation is NOT eviction: the subscription stays live.
      const nextLive = it.next();
      const live = bus.publish({ type: 'after', data: 1 });
      expect(((await nextLive).value as BridgeEvent).id).toBe(live?.id);
      abort.abort();
    });

    it('replays a single frame larger than the budget (first-item rule)', async () => {
      const bus = new EventBus(100, undefined, undefined, {
        replayBudgetBytes: 10,
      });
      bus.publish({ type: 'payload', data: bigPayload() });

      const abort = new AbortController();
      const frames = await collect(
        bus.subscribe({ lastEventId: 0, signal: abort.signal }),
        2,
      );
      expect(frames[0]?.id).toBe(1);
      expect(frames[1]?.type).toBe('replay_complete');
      abort.abort();
    });

    it('does not emit a resync frame when the replay fits the budget', async () => {
      const bus = new EventBus();
      for (let i = 0; i < 5; i++) {
        bus.publish({ type: 'payload', data: bigPayload() });
      }

      const abort = new AbortController();
      const frames = await collect(
        bus.subscribe({ lastEventId: 0, signal: abort.signal }),
        6,
      );
      expect(frames.some((e) => e.type === 'state_resync_required')).toBe(
        false,
      );
      expect(frames[5]?.type).toBe('replay_complete');
      expect((frames[5]?.data as { replayedCount: number }).replayedCount).toBe(
        5,
      );
      abort.abort();
    });
  });

  describe('epoch token (DAEMON-001)', () => {
    it('exposes a stable per-instance epoch that differs across instances', () => {
      const a = new EventBus();
      const b = new EventBus();
      expect(a.epoch).toBeTruthy();
      expect(a.epoch).toBe(a.epoch);
      expect(a.epoch).not.toBe(b.epoch);
    });

    it('forces epoch_reset resync with detail=epoch_mismatch when the presented epoch does not match', async () => {
      // The numeric heuristic alone is defeated once the new epoch's event
      // count catches up with the stale cursor: lastEventId 2 with 3 fresh
      // events looks like a perfectly valid suffix resume. The epoch token
      // makes staleness provable regardless of the numbers.
      const bus = new EventBus(10);
      for (let i = 1; i <= 3; i++) bus.publish({ type: 'foo', data: i });
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 2,
        epoch: 'dead-epoch-token',
        signal: abort.signal,
      });
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // resync + 3 full-ring replay frames + replay_complete = 5.
        if (out.length === 5) break;
      }
      expect(out[0]?.type).toBe('state_resync_required');
      expect(out[0]?.id).toBeUndefined();
      const data = out[0]?.data as {
        reason: string;
        detail?: string;
        lastDeliveredId: number;
        earliestAvailableId: number;
      };
      expect(data.reason).toBe('epoch_reset');
      expect(data.detail).toBe('epoch_mismatch');
      expect(data.lastDeliveredId).toBe(2);
      expect(data.earliestAvailableId).toBe(1);
      // Full fresh-ring replay: the stale cursor must not filter low ids.
      expect(out.slice(1, 4).map((e) => e.id)).toEqual([1, 2, 3]);
      expect(out[4]?.type).toBe('replay_complete');
      expect(out[4]?.data).toMatchObject({ replayedCount: 3 });
      abort.abort();
    });

    it('resumes normally (no resync frame) when the presented epoch matches', async () => {
      const bus = new EventBus(10);
      for (let i = 1; i <= 3; i++) bus.publish({ type: 'foo', data: i });
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 1,
        epoch: bus.epoch,
        signal: abort.signal,
      });
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // 2 suffix replay frames + replay_complete = 3.
        if (out.length === 3) break;
      }
      expect(out.some((e) => e.type === 'state_resync_required')).toBe(false);
      expect(out.slice(0, 2).map((e) => e.id)).toEqual([2, 3]);
      expect(out[2]?.type).toBe('replay_complete');
      abort.abort();
    });

    it('numeric-heuristic epoch_reset does NOT carry detail (only epoch-token mismatches do)', async () => {
      // `detail` is the operator-facing discriminator between the two
      // triggers — the heuristic path must not claim it.
      const bus = new EventBus(10);
      const abort = new AbortController();
      const iter = bus.subscribe({ lastEventId: 5, signal: abort.signal });
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // resync + replay_complete (empty ring) = 2.
        if (out.length === 2) break;
      }
      const data = out[0]?.data as { reason: string; detail?: string };
      expect(out[0]?.type).toBe('state_resync_required');
      expect(data.reason).toBe('epoch_reset');
      expect(data.detail).toBeUndefined();
      abort.abort();
    });

    it('ring_evicted resync does NOT carry detail either', async () => {
      const bus = new EventBus(3);
      for (let i = 1; i <= 5; i++) bus.publish({ type: 'foo', data: i });
      const abort = new AbortController();
      const iter = bus.subscribe({
        lastEventId: 1,
        epoch: bus.epoch,
        signal: abort.signal,
      });
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        // resync + 3 surviving frames + replay_complete = 5.
        if (out.length === 5) break;
      }
      const data = out[0]?.data as { reason: string; detail?: string };
      expect(out[0]?.type).toBe('state_resync_required');
      expect(data.reason).toBe('ring_evicted');
      expect(data.detail).toBeUndefined();
      abort.abort();
    });

    it('ignores a mismatching epoch when no lastEventId is presented (nothing to resume)', async () => {
      // Without a cursor there is no stale state to protect — the fresh
      // subscriber is live-only regardless of what epoch it presents.
      const bus = new EventBus(10);
      bus.publish({ type: 'foo', data: 1 });
      const abort = new AbortController();
      const iter = bus.subscribe({
        epoch: 'dead-epoch-token',
        signal: abort.signal,
      });
      setTimeout(() => bus.publish({ type: 'foo', data: 2 }), 0);
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        if (out.length === 1) break;
      }
      expect(out[0]?.type).toBe('foo');
      expect(out[0]?.id).toBe(2);
      expect(out.some((e) => e.type === 'state_resync_required')).toBe(false);
      abort.abort();
    });
  });

  describe('compaction degradation (DAEMON-008)', () => {
    function makeEngine(
      overrides: Partial<{
        ingest: (event: BridgeEvent) => void;
        seedReplayEvents: (events: BridgeEvent[]) => void;
      }> = {},
    ) {
      return {
        ingest: overrides.ingest ?? vi.fn(),
        seedReplayEvents: overrides.seedReplayEvents ?? vi.fn(),
        snapshot: () => ({
          compactedTurns: [],
          liveJournal: [],
          lastEventId: 0,
        }),
        close: vi.fn(),
      };
    }

    it('marks the snapshot degraded and fires onCompactionError exactly once when ingest throws', () => {
      const onCompactionError = vi.fn();
      const engine = makeEngine({
        ingest: () => {
          throw new Error('boom');
        },
      });
      const bus = new EventBus(10, undefined, engine, { onCompactionError });

      // publish() keeps its never-throws contract across repeated failures.
      expect(() => bus.publish({ type: 'foo', data: 1 })).not.toThrow();
      expect(() => bus.publish({ type: 'foo', data: 2 })).not.toThrow();

      expect(onCompactionError).toHaveBeenCalledTimes(1);
      expect((onCompactionError.mock.calls[0]![0] as Error).message).toBe(
        'boom',
      );
      expect(bus.snapshotReplay()?.degraded).toBe(true);
    });

    it('marks the snapshot degraded when seedReplayEvents throws', () => {
      const onCompactionError = vi.fn();
      const engine = makeEngine({
        seedReplayEvents: () => {
          throw new Error('seed boom');
        },
      });
      const bus = new EventBus(10, undefined, engine, { onCompactionError });

      expect(() =>
        bus.seedReplayEvents([{ type: 'foo', data: 1 }]),
      ).not.toThrow();

      expect(onCompactionError).toHaveBeenCalledTimes(1);
      expect(bus.snapshotReplay()?.degraded).toBe(true);
    });

    it('does not mark degraded on the healthy path', () => {
      const engine = makeEngine();
      const bus = new EventBus(10, undefined, engine);
      bus.publish({ type: 'foo', data: 1 });
      expect(bus.snapshotReplay()?.degraded).toBeUndefined();
    });

    it('survives a throwing onCompactionError callback', () => {
      const engine = makeEngine({
        ingest: () => {
          throw new Error('boom');
        },
      });
      const bus = new EventBus(10, undefined, engine, {
        onCompactionError: () => {
          throw new Error('diagnostics blew up');
        },
      });
      expect(() => bus.publish({ type: 'foo', data: 1 })).not.toThrow();
      expect(bus.snapshotReplay()?.degraded).toBe(true);
    });
  });
});
