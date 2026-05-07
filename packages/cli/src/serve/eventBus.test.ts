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
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.v).toBe(EVENT_SCHEMA_VERSION);
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

  it('drops the oldest events from the ring beyond ringSize', () => {
    const bus = new EventBus(3);
    for (let i = 1; i <= 5; i++) bus.publish({ type: 'foo', data: i });
    // Internal: only the last 3 should be replayable.
    // Subscribe with lastEventId=0 — only ids 3, 4, 5 should be queued.
    const abort = new AbortController();
    const iter = bus.subscribe({ lastEventId: 0, signal: abort.signal });

    void (async () => {
      const out: BridgeEvent[] = [];
      for await (const e of iter) {
        out.push(e);
        if (out.length === 3) break;
      }
      expect(out.map((e) => e.id)).toEqual([3, 4, 5]);
      abort.abort();
    })();
  });
});
