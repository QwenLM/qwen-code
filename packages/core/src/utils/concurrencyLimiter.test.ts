/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createConcurrencyLimiter } from './concurrencyLimiter.js';

describe('createConcurrencyLimiter', () => {
  it('throws on a non-positive-integer limit', () => {
    expect(() => createConcurrencyLimiter(0)).toThrow(/positive integer/i);
    expect(() => createConcurrencyLimiter(-1)).toThrow(/positive integer/i);
    expect(() => createConcurrencyLimiter(1.5)).toThrow(/positive integer/i);
    expect(() => createConcurrencyLimiter(Number.NaN)).toThrow(
      /positive integer/i,
    );
  });

  describe('run', () => {
    it('resolves with the thunk value', async () => {
      const limiter = createConcurrencyLimiter(2);
      await expect(limiter.run(async () => 42)).resolves.toBe(42);
    });

    it('propagates a thunk rejection raw (no null coercion)', async () => {
      const limiter = createConcurrencyLimiter(2);
      await expect(
        limiter.run(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });

    it('never runs more than `limit` thunks concurrently', async () => {
      const limit = 3;
      const limiter = createConcurrencyLimiter(limit);
      let active = 0;
      let peak = 0;
      const mk = () => async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return 'x';
      };
      await Promise.all(
        Array.from({ length: 12 }, mk).map((t) => limiter.run(t)),
      );
      // 12 thunks, window 3, all want to run → steady-state fills the window.
      expect(peak).toBe(limit);
    });

    it('processes the full queue (every thunk eventually runs)', async () => {
      const limiter = createConcurrencyLimiter(2);
      let ran = 0;
      await Promise.all(
        Array.from({ length: 20 }, () => () => {
          ran++;
          return Promise.resolve('ok');
        }).map((t) => limiter.run(t)),
      );
      expect(ran).toBe(20);
    });
  });

  describe('settleAll', () => {
    it('returns results in input order regardless of settle timing', async () => {
      const limiter = createConcurrencyLimiter(4);
      const delays = [20, 1, 15, 3, 8];
      const out = await limiter.settleAll(
        delays.map((d, i) => async () => {
          await new Promise((r) => setTimeout(r, d));
          return i;
        }),
      );
      expect(out).toEqual([0, 1, 2, 3, 4]);
    });

    it('maps a rejected thunk to null at its index (errors-as-data)', async () => {
      const limiter = createConcurrencyLimiter(3);
      const out = await limiter.settleAll([
        async () => 'a',
        async () => {
          throw new Error('nope');
        },
        async () => 'c',
      ]);
      expect(out).toEqual(['a', null, 'c']);
    });

    it('never rejects when a thunk throws — only individual slots become null', async () => {
      const limiter = createConcurrencyLimiter(2);
      const out = await limiter.settleAll([
        async () => {
          throw new Error('x');
        },
        async () => {
          throw new Error('y');
        },
      ]);
      expect(out).toEqual([null, null]);
    });

    it('returns [] for empty input without scheduling', async () => {
      const limiter = createConcurrencyLimiter(4);
      await expect(limiter.settleAll([])).resolves.toEqual([]);
    });

    it('shares one window across multiple settleAll calls', async () => {
      const limiter = createConcurrencyLimiter(2);
      let active = 0;
      let peak = 0;
      const mk = () => async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return 1;
      };
      // Two concurrent settleAll calls on the SAME limiter must not exceed
      // the shared window of 2.
      await Promise.all([
        limiter.settleAll(Array.from({ length: 5 }, mk)),
        limiter.settleAll(Array.from({ length: 5 }, mk)),
      ]);
      expect(peak).toBeLessThanOrEqual(2);
    });
  });

  describe('abort', () => {
    it('settleAll rejects when the signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      const limiter = createConcurrencyLimiter(2, ac.signal);
      await expect(
        limiter.settleAll([async () => 1, async () => 2]),
      ).rejects.toThrow(/abort/i);
    });

    it('settleAll rejects when aborted mid-flight (not silent null array)', async () => {
      const ac = new AbortController();
      const limiter = createConcurrencyLimiter(2, ac.signal);
      const p = limiter.settleAll(
        Array.from({ length: 6 }, (_, i) => async () => {
          await new Promise((r) => setTimeout(r, 10));
          return i;
        }),
      );
      setTimeout(() => ac.abort(), 5);
      await expect(p).rejects.toThrow(/abort/i);
    });

    it('does not start queued thunks after abort', async () => {
      const ac = new AbortController();
      const limiter = createConcurrencyLimiter(1, ac.signal);
      let started = 0;
      const thunks = Array.from({ length: 5 }, () => async () => {
        started++;
        await new Promise((r) => setTimeout(r, 10));
        return 1;
      });
      const p = limiter.settleAll(thunks).catch(() => {});
      setTimeout(() => ac.abort(), 5);
      await p;
      // First thunk had started; abort must prevent the remaining 4 from starting.
      expect(started).toBeLessThan(5);
    });
  });
});
