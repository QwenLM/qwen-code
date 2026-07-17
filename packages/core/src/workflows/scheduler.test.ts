/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  it('caps concurrency and queues FIFO beyond it', async () => {
    const sched = new Scheduler(2, 1000);
    let active = 0;
    let peak = 0;
    const run = async () => {
      const release = await sched.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, run));
    expect(peak).toBe(2);
  });

  it('release is one-shot (double release does not over-grant)', async () => {
    const sched = new Scheduler(1, 1000);
    const r1 = await sched.acquire();
    r1();
    r1(); // no-op
    const r2 = await sched.acquire();
    expect(sched.active).toBe(1);
    r2();
  });

  it('lifetime cap trips after N counts', () => {
    const sched = new Scheduler(4, 3);
    expect(sched.tryCountAgent()).toBe(true);
    expect(sched.tryCountAgent()).toBe(true);
    expect(sched.tryCountAgent()).toBe(true);
    expect(sched.tryCountAgent()).toBe(false);
    expect(sched.counted).toBe(3);
  });

  it('default concurrency is at least 1', () => {
    expect(new Scheduler().concurrency).toBeGreaterThanOrEqual(1);
  });
});
