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

  describe('abort', () => {
    it('run() rejects immediately when the signal is already aborted', async () => {
      const ac = new AbortController();
      ac.abort();
      const limiter = createConcurrencyLimiter(2, ac.signal);
      await expect(limiter.run(async () => 1)).rejects.toThrow(/abort/i);
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
      // One slot; first thunk starts, the rest queue behind it.
      const ps = thunks.map((t) => limiter.run(t).catch(() => {}));
      setTimeout(() => ac.abort(), 5);
      await Promise.all(ps);
      // The first thunk had started; abort must prevent the queued 4 from starting.
      expect(started).toBeLessThan(5);
    });
  });
});
