/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { all, lastX, returnValue, toArray, fromArray } from './generators.js';

/** Helper: create an async generator that yields the given values with optional delays. */
async function* yieldValues<T>(
  values: T[],
  delayMs = 0,
): AsyncGenerator<T, void> {
  for (const v of values) {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    yield v;
  }
}

/** Helper: create a generator that records when it's iterated (for concurrency verification). */
function trackedGenerator(
  id: string,
  values: number[],
  log: string[],
  delayMs = 0,
): AsyncGenerator<number, void> {
  return (async function* () {
    log.push(`start:${id}`);
    for (const v of values) {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      yield v;
      log.push(`yield:${id}:${v}`);
    }
    log.push(`end:${id}`);
  })();
}

describe('lastX', () => {
  it('returns the last yielded value', async () => {
    const result = await lastX(yieldValues([1, 2, 3]));
    expect(result).toBe(3);
  });

  it('returns single value for single-element generator', async () => {
    const result = await lastX(yieldValues(['only']));
    expect(result).toBe('only');
  });

  it('throws on empty generator', async () => {
    await expect(lastX(yieldValues([]))).rejects.toThrow(
      'No items in generator',
    );
  });
});

describe('returnValue', () => {
  it('returns the generator return value', async () => {
    async function* gen(): AsyncGenerator<string, number> {
      yield 'a';
      yield 'b';
      return 42;
    }
    const result = await returnValue(gen());
    expect(result).toBe(42);
  });

  it('works with generator that returns immediately', async () => {
    async function* gen(): AsyncGenerator<never, string> {
      // This generator returns immediately without yielding
      // The return value is what returnValue() extracts
      yield* [] as never[];
      return 'immediate';
    }
    const result = await returnValue(gen());
    expect(result).toBe('immediate');
  });
});

describe('toArray', () => {
  it('collects all values into an array', async () => {
    const result = await toArray(yieldValues([1, 2, 3]));
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns empty array for empty generator', async () => {
    const result = await toArray(yieldValues([]));
    expect(result).toEqual([]);
  });
});

describe('fromArray', () => {
  it('yields each array element', async () => {
    const result = await toArray(fromArray([10, 20, 30]));
    expect(result).toEqual([10, 20, 30]);
  });

  it('yields nothing for empty array', async () => {
    const result = await toArray(fromArray([]));
    expect(result).toEqual([]);
  });
});

describe('all', () => {
  it('yields all values from multiple generators', async () => {
    const gens = [yieldValues([1, 2]), yieldValues([3, 4]), yieldValues([5])];

    const result = await toArray(all(gens));
    expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles empty generator list', async () => {
    const result = await toArray(all([]));
    expect(result).toEqual([]);
  });

  it('handles single generator', async () => {
    const result = await toArray(all([yieldValues([1, 2, 3])]));
    expect(result).toEqual([1, 2, 3]);
  });

  it('handles generators that yield nothing', async () => {
    const gens = [yieldValues<number>([]), yieldValues([1]), yieldValues([])];
    const result = await toArray(all(gens));
    expect(result).toEqual([1]);
  });

  it('respects concurrency cap', async () => {
    const log: string[] = [];
    const gens = [
      trackedGenerator('A', [1], log, 5),
      trackedGenerator('B', [2], log, 5),
      trackedGenerator('C', [3], log, 5),
      trackedGenerator('D', [4], log, 5),
    ];

    await toArray(all(gens, 2));

    // With cap=2, only 2 generators should start initially.
    // A and B start first; C and D start after A or B finish.
    const starts = log.filter((l) => l.startsWith('start:'));
    expect(starts).toHaveLength(4);

    // First two starts should be A and B (order preserved)
    expect(starts[0]).toBe('start:A');
    expect(starts[1]).toBe('start:B');
  });

  it('cap=1 produces serial execution', async () => {
    const log: string[] = [];
    const gens = [
      trackedGenerator('A', [1, 2], log),
      trackedGenerator('B', [3, 4], log),
    ];

    const result = await toArray(all(gens, 1));

    // With cap=1, A should fully complete before B starts
    const aEnd = log.indexOf('end:A');
    const bStart = log.indexOf('start:B');
    expect(aEnd).toBeLessThan(bStart);

    // All values collected
    expect(result).toEqual([1, 2, 3, 4]);
  });

  it('cap=Infinity starts all generators immediately', async () => {
    const log: string[] = [];
    const gens = [
      trackedGenerator('A', [1], log),
      trackedGenerator('B', [2], log),
      trackedGenerator('C', [3], log),
    ];

    await toArray(all(gens, Infinity));

    // All three should start before any yields
    const starts = log.filter((l) => l.startsWith('start:'));
    expect(starts).toHaveLength(3);
    // The first three log entries should all be starts
    expect(log[0]).toBe('start:A');
    expect(log[1]).toBe('start:B');
    expect(log[2]).toBe('start:C');
  });

  it('default concurrency is Infinity (all start immediately)', async () => {
    const log: string[] = [];
    const gens = [
      trackedGenerator('A', [1], log),
      trackedGenerator('B', [2], log),
    ];

    await toArray(all(gens)); // no cap argument

    expect(log[0]).toBe('start:A');
    expect(log[1]).toBe('start:B');
  });

  it('sliding window: finished generator slot is reused', async () => {
    const log: string[] = [];
    // A finishes after one value, freeing a slot for C while B is still producing
    const gens = [
      trackedGenerator('A', [1], log), // finishes quickly
      trackedGenerator('B', [2, 3, 4], log, 5), // slow, multiple values
      trackedGenerator('C', [5], log), // waiting
    ];

    const result = await toArray(all(gens, 2));

    // A and B start first (cap=2)
    expect(log[0]).toBe('start:A');
    expect(log[1]).toBe('start:B');

    // C should start after A ends (takes its slot), and before B ends
    const cStart = log.indexOf('start:C');
    const aEnd = log.indexOf('end:A');
    const bEnd = log.indexOf('end:B');
    expect(cStart).toBeGreaterThan(aEnd);
    expect(cStart).toBeLessThan(bEnd);

    // All values collected
    expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
