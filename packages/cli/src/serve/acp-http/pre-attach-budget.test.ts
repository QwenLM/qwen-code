/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AcpPreAttachBudget } from './pre-attach-budget.js';

describe('AcpPreAttachBudget', () => {
  it('atomically enforces frame and byte limits', () => {
    const byFrames = new AcpPreAttachBudget({ maxFrames: 2, maxBytes: 100 });
    expect(byFrames.tryReserve(10)).toBeDefined();
    expect(byFrames.tryReserve(10)).toBeDefined();
    expect(byFrames.tryReserve(1)).toBeUndefined();
    expect(byFrames.snapshot()).toMatchObject({
      usedFrames: 2,
      usedBytes: 20,
      guardFailures: 1,
    });

    const byBytes = new AcpPreAttachBudget({ maxFrames: 10, maxBytes: 20 });
    expect(byBytes.tryReserve(20)).toBeDefined();
    expect(byBytes.tryReserve(1)).toBeUndefined();
    expect(byBytes.snapshot()).toMatchObject({
      usedFrames: 1,
      usedBytes: 20,
      guardFailures: 1,
    });
  });

  it('tracks delivery ownership and releases leases idempotently', () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 2, maxBytes: 100 });
    const lease = budget.tryReserve(40);
    expect(lease).toBeDefined();
    lease?.markPendingDelivery();
    lease?.markPendingDelivery();
    expect(budget.snapshot()).toMatchObject({
      usedFrames: 1,
      usedBytes: 40,
      pendingDeliveryFrames: 1,
      highWaterFrames: 1,
      highWaterBytes: 40,
    });

    lease?.release();
    lease?.release();
    expect(budget.snapshot()).toMatchObject({
      usedFrames: 0,
      usedBytes: 0,
      pendingDeliveryFrames: 0,
      highWaterFrames: 1,
      highWaterBytes: 40,
    });
  });

  it('keeps counters unchanged when pending delivery is marked after release', () => {
    const budget = new AcpPreAttachBudget({ maxFrames: 1, maxBytes: 100 });
    const lease = budget.tryReserve(40);
    lease?.release();
    lease?.markPendingDelivery();
    expect(budget.snapshot()).toMatchObject({
      usedFrames: 0,
      usedBytes: 0,
      pendingDeliveryFrames: 0,
    });
  });
});
