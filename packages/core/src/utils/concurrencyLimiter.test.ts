/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ConcurrencyLimiter } from './concurrencyLimiter.js';

describe('ConcurrencyLimiter', () => {
  it('treats capacity <= 0 as unlimited and resolves immediately', async () => {
    const limiter = new ConcurrencyLimiter(0);
    const release = await limiter.acquire();
    expect(typeof release).toBe('function');
    expect(limiter.limit).toBe(0);
    expect(limiter.inFlight).toBe(0);
    release();
    release(); // double-release on the no-op path is safe
  });

  it('caps in-flight count at the configured capacity', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const r1 = await limiter.acquire();
    const r2 = await limiter.acquire();
    expect(limiter.inFlight).toBe(2);

    let r3Resolved = false;
    const r3Promise = limiter.acquire().then((release) => {
      r3Resolved = true;
      return release;
    });

    // r3 is parked behind the cap.
    await Promise.resolve();
    expect(r3Resolved).toBe(false);
    expect(limiter.queued).toBe(1);

    r1();
    const r3 = await r3Promise;
    expect(r3Resolved).toBe(true);
    expect(limiter.inFlight).toBe(2); // r2 + r3

    r2();
    r3();
    expect(limiter.inFlight).toBe(0);
  });

  it('preserves FIFO ordering of waiters', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const r1 = await limiter.acquire();

    const order: number[] = [];
    const p2 = limiter.acquire().then((release) => {
      order.push(2);
      release();
    });
    const p3 = limiter.acquire().then((release) => {
      order.push(3);
      release();
    });
    const p4 = limiter.acquire().then((release) => {
      order.push(4);
      release();
    });

    r1();
    await Promise.all([p2, p3, p4]);
    expect(order).toEqual([2, 3, 4]);
  });

  it('runExclusive releases the slot on success and on failure', async () => {
    const limiter = new ConcurrencyLimiter(1);

    const ok = await limiter.runExclusive(async () => 'value');
    expect(ok).toBe('value');
    expect(limiter.inFlight).toBe(0);

    await expect(
      limiter.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(limiter.inFlight).toBe(0);
  });

  it('release is idempotent so accidental double-releases do not over-credit', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    release();
    release(); // second call is a no-op
    expect(limiter.inFlight).toBe(0);

    // The next acquire still respects the cap.
    const r2 = await limiter.acquire();
    expect(limiter.inFlight).toBe(1);
    r2();
  });

  it('coerces NaN / Infinity capacities to "unlimited"', async () => {
    const nanLimiter = new ConcurrencyLimiter(Number.NaN);
    expect(nanLimiter.limit).toBe(0);
    const infLimiter = new ConcurrencyLimiter(Number.POSITIVE_INFINITY);
    expect(infLimiter.limit).toBe(0);
    // Both should be effectively no-op.
    await nanLimiter.runExclusive(async () => undefined);
    await infLimiter.runExclusive(async () => undefined);
  });
});
