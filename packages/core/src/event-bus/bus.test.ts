/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createBusEvent, QueryEventBus } from './bus.js';
import type { AnyBusEvent } from './events.js';

const base = (queryId: string) => ({ sessionId: 's', queryId });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('QueryEventBus', () => {
  it('delivers one subscriber’s events of a query serially in publish order', async () => {
    const bus = new QueryEventBus();
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
      createBusEvent('tool.cancel', base('q1'), { reason: 'refusal' }),
    );
    bus.publish(
      createBusEvent('tool.settled', base('q1'), {
        toolUseIds: [],
        permissionDenialCount: 0,
        hasUnknownOutcomes: false,
        stopRequested: false,
        bounded: true,
      }),
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

  it('does not block another query or another subscriber', async () => {
    const bus = new QueryEventBus();
    const gate = deferred();
    const seen: string[] = [];
    bus.subscribe('conversation', ['tool.cancel'], async (e) => {
      if (e.queryId === 'q1') await gate.promise;
      seen.push(`conversation ${e.queryId}`);
    });
    bus.subscribe('tool', ['tool.cancel'], (e) => {
      seen.push(`tool ${e.queryId}`);
    });
    bus.publish(
      createBusEvent('tool.cancel', base('q1'), { reason: 'refusal' }),
    );
    bus.publish(
      createBusEvent('tool.cancel', base('q2'), { reason: 'refusal' }),
    );
    await flush();
    expect([...seen].sort()).toEqual(['conversation q2', 'tool q1', 'tool q2']);
    gate.resolve();
    await flush();
    expect(seen.at(-1)).toBe('conversation q1');
  });

  it('routes by queryId and reports a throwing listener as handler.failed', async () => {
    const bus = new QueryEventBus();
    const failures: AnyBusEvent[] = [];
    const error = new Error('boom');
    bus.subscribe(
      'llm',
      ['llm.request'],
      () => {
        throw error;
      },
      { queryId: 'q1' },
    );
    bus.subscribe('query', ['handler.failed'], (e) => {
      failures.push(e);
    });
    bus.publish(
      createBusEvent(
        'llm.request',
        base('q2'),
        { reason: 'initial', requestIndex: 1 },
        'r',
      ),
    );
    bus.publish(
      createBusEvent(
        'llm.request',
        base('q1'),
        { reason: 'initial', requestIndex: 1 },
        'r1',
      ),
    );
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      queryId: 'q1',
      roundId: 'r1',
      data: { source: 'llm', eventType: 'llm.request', error },
    });
  });
});
