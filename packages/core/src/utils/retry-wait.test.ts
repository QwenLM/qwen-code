/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  beginRetryWait,
  bindRetryWaitObserver,
  runWithRetryWaitObserver,
  type RetryWaitEvent,
} from './retry-wait.js';

describe('retry wait observer', () => {
  it('is a no-op without an observer', () => {
    expect(() => beginRetryWait(1000)()).not.toThrow();
  });

  it('pairs one start with one end and ignores repeated end calls', () => {
    const events: RetryWaitEvent[] = [];
    runWithRetryWaitObserver(
      (e) => events.push(e),
      () => {
        const end = beginRetryWait(1500);
        end();
        end();
      },
    );
    expect(events).toEqual([
      { phase: 'start', waitId: expect.any(String), delayMs: 1500 },
      { phase: 'end', waitId: events[0]!.waitId },
    ]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'does not announce an invalid delay %s',
    (delayMs) => {
      const events: RetryWaitEvent[] = [];
      runWithRetryWaitObserver(
        (e) => events.push(e),
        () => beginRetryWait(delayMs)(),
      );
      expect(events).toEqual([]);
    },
  );

  it('gives every wait a distinct id', () => {
    const ids = new Set<string>();
    runWithRetryWaitObserver(
      (e) => ids.add(e.waitId),
      () => {
        beginRetryWait(1)();
        beginRetryWait(1)();
      },
    );
    expect(ids.size).toBe(2);
  });

  it('swallows observer errors', () => {
    const end = runWithRetryWaitObserver(
      () => {
        throw new Error('boom');
      },
      () => beginRetryWait(10),
    );
    expect(() => end()).not.toThrow();
  });

  it('keeps the observer across a lazily iterated generator body', async () => {
    const events: RetryWaitEvent[] = [];
    async function* lazy() {
      await Promise.resolve();
      const end = beginRetryWait(10);
      await new Promise((r) => setTimeout(r, 1));
      end();
      yield 1;
      beginRetryWait(20)();
    }
    // Created outside any observer, iterated through the bound wrapper.
    const generator = lazy();
    const values: number[] = [];
    for await (const v of bindRetryWaitObserver(
      (e) => events.push(e),
      generator,
    )) {
      values.push(v);
    }
    expect(values).toEqual([1]);
    expect(events.map((e) => e.phase)).toEqual([
      'start',
      'end',
      'start',
      'end',
    ]);
  });

  it('isolates concurrent observers', async () => {
    const a: RetryWaitEvent[] = [];
    const b: RetryWaitEvent[] = [];
    const work = async (delayMs: number) => {
      await new Promise((r) => setTimeout(r, 1));
      beginRetryWait(delayMs)();
    };
    await Promise.all([
      runWithRetryWaitObserver(
        (e) => a.push(e),
        () => work(1),
      ),
      runWithRetryWaitObserver(
        (e) => b.push(e),
        () => work(2),
      ),
    ]);
    expect(a.filter((e) => e.phase === 'start')).toEqual([
      expect.objectContaining({ delayMs: 1 }),
    ]);
    expect(b.filter((e) => e.phase === 'start')).toEqual([
      expect.objectContaining({ delayMs: 2 }),
    ]);
  });
});
