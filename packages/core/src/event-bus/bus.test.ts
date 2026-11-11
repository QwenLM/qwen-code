/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createBusEvent, LoopEventBus } from './bus.js';
import type { AnyBusEvent } from './events.js';

const base = (runId: string) => ({ runId, promptId: 'p' });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('LoopEventBus', () => {
  it('delivers one subscriber’s events of a run serially in publish order', async () => {
    const bus = new LoopEventBus();
    const gate = deferred();
    const seen: string[] = [];
    bus.subscribe(
      'conversation',
      ['tool.cancel', 'tool.settled'],
      async (e) => {
        seen.push(`start ${e.type}`);
        if (e.type === 'tool.cancel') await gate.promise;
        seen.push(`end ${e.type}`);
      },
    );
    bus.publish(
      createBusEvent('tool.cancel', base('r1'), { reason: 'refusal' }),
    );
    bus.publish(
      createBusEvent('tool.settled', base('r1'), { round: 1, results: [] }),
    );
    await flush();
    expect(seen).toEqual(['start tool.cancel']);
    gate.resolve();
    await flush();
    expect(seen).toEqual([
      'start tool.cancel',
      'end tool.cancel',
      'start tool.settled',
      'end tool.settled',
    ]);
  });

  it('does not block another run or another subscriber', async () => {
    const bus = new LoopEventBus();
    const gate = deferred();
    const seen: string[] = [];
    bus.subscribe('conversation', ['loop.cancelled'], async (e) => {
      if (e.runId === 'r1') await gate.promise;
      seen.push(`conversation ${e.runId}`);
    });
    bus.subscribe('tool', ['loop.cancelled'], (e) => {
      seen.push(`tool ${e.runId}`);
    });
    bus.publish(
      createBusEvent('loop.cancelled', base('r1'), { reason: 'abort' }),
    );
    bus.publish(
      createBusEvent('loop.cancelled', base('r2'), { reason: 'abort' }),
    );
    await flush();
    expect([...seen].sort()).toEqual(['conversation r2', 'tool r1', 'tool r2']);
    gate.resolve();
    await flush();
    expect(seen.at(-1)).toBe('conversation r1');
  });

  it('routes by runId and reports a throwing listener as handler.failed', async () => {
    const bus = new LoopEventBus();
    const failures: AnyBusEvent[] = [];
    const error = new Error('boom');
    bus.subscribe(
      'llm',
      ['loop.cancelled'],
      () => {
        throw error;
      },
      { runId: 'r1' },
    );
    bus.subscribe('loop', ['handler.failed'], (e) => {
      failures.push(e);
    });
    bus.publish(
      createBusEvent('loop.cancelled', base('r2'), { reason: 'abort' }),
    );
    bus.publish(
      createBusEvent('loop.cancelled', base('r1'), { reason: 'abort' }, 3),
    );
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      runId: 'r1',
      round: 3,
      data: { source: 'llm', eventType: 'loop.cancelled', error },
    });
  });

  it('only delivers subscribed event types', async () => {
    const bus = new LoopEventBus();
    const seen: string[] = [];
    bus.subscribe('tool', ['tool.cancel'], (e) => {
      seen.push(e.type);
    });
    bus.publish(
      createBusEvent('loop.cancelled', base('r1'), { reason: 'abort' }),
    );
    bus.publish(
      createBusEvent('tool.cancel', base('r1'), { reason: 'refusal' }),
    );
    await flush();
    expect(seen).toEqual(['tool.cancel']);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new LoopEventBus();
    const seen: string[] = [];
    const off = bus.subscribe('tool', ['tool.cancel'], (e) => {
      seen.push(e.type);
    });
    bus.publish(
      createBusEvent('tool.cancel', base('r1'), { reason: 'refusal' }),
    );
    await flush();
    off();
    bus.publish(
      createBusEvent('tool.cancel', base('r1'), { reason: 'refusal' }),
    );
    await flush();
    expect(seen).toEqual(['tool.cancel']);
  });

  it('assigns an eventId on publish and keeps round optional', async () => {
    const bus = new LoopEventBus();
    const seen: AnyBusEvent[] = [];
    bus.subscribe('loop', ['loop.started'], (e) => {
      seen.push(e);
    });
    bus.publish(createBusEvent('loop.started', base('r1'), { promptId: 'p' }));
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].eventId).toBeTruthy();
    expect(seen[0].round).toBeUndefined();
    expect(seen[0].promptId).toBe('p');
  });

  it('does not republish handler.failed when its own listener throws', async () => {
    const bus = new LoopEventBus();
    let deliveries = 0;
    bus.subscribe('loop', ['handler.failed'], () => {
      deliveries += 1;
      throw new Error('failure handler failed');
    });
    bus.publish(
      createBusEvent('handler.failed', base('r1'), {
        source: 'llm',
        eventType: 'loop.cancelled',
        error: new Error('original'),
      }),
    );
    await flush();
    await flush();
    expect(deliveries).toBe(1);
  });

  it('serializes by name independently of source', async () => {
    const bus = new LoopEventBus();
    const gate = deferred();
    const seen: string[] = [];
    bus.subscribe(
      'tool',
      ['tool.cancel'],
      async () => {
        seen.push('a-start');
        await gate.promise;
        seen.push('a-end');
      },
      { name: 'a' },
    );
    bus.subscribe(
      'tool',
      ['tool.cancel'],
      () => {
        seen.push('b');
      },
      { name: 'b' },
    );
    bus.publish(
      createBusEvent('tool.cancel', base('r1'), { reason: 'refusal' }),
    );
    await flush();
    expect(seen).toContain('b');
    expect(seen).not.toContain('a-end');
    gate.resolve();
    await flush();
    expect(seen.at(-1)).toBe('a-end');
  });
});
