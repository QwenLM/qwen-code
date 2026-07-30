/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DAEMON_EMERGENCY_POOL_BYTES,
  ResourceBudget,
} from './resource-budget.js';

describe('ResourceBudget', () => {
  it('atomically enforces parent, normal admission, and category limits', () => {
    const budget = new ResourceBudget({
      capBytes: 100,
      normalAdmissionBytes: 70,
      categoryCaps: { ingress: 60, outbound: 50 },
    });

    const first = budget.tryReserveComposite([
      { category: 'ingress', bytes: 40 },
      { category: 'outbound', bytes: 20 },
    ]);
    expect(first.ok).toBe(true);

    expect(
      budget.tryReserveComposite([{ category: 'ingress', bytes: 21 }]),
    ).toMatchObject({
      ok: false,
      reason: 'category_limit',
      category: 'ingress',
    });
    expect(
      budget.tryReserveComposite([{ category: 'outbound', bytes: 11 }]),
    ).toMatchObject({
      ok: false,
      reason: 'normal_admission_limit',
    });
    expect(budget.snapshot()).toMatchObject({
      usedBytes: 60,
      normalUsedBytes: 60,
      highWaterBytes: 60,
    });
  });

  it('keeps the completion reserve unavailable to normal work', () => {
    const budget = new ResourceBudget({
      capBytes: 100,
      normalAdmissionBytes: 60,
      categoryCaps: { prompt: 100 },
    });
    expect(
      budget.tryReserveComposite([{ category: 'prompt', bytes: 60 }]).ok,
    ).toBe(true);
    expect(
      budget.tryReserveComposite([{ category: 'prompt', bytes: 1 }]),
    ).toMatchObject({
      ok: false,
      reason: 'normal_admission_limit',
    });
    expect(
      budget.tryReserveComposite([{ category: 'prompt', bytes: 40 }], {
        priority: 'completion',
      }).ok,
    ).toBe(true);
    expect(
      budget.tryReserveComposite([{ category: 'prompt', bytes: 1 }], {
        priority: 'completion',
      }),
    ).toMatchObject({ ok: false, reason: 'parent_limit' });
  });

  it('keeps the emergency response pool below 3 MiB', () => {
    const budget = new ResourceBudget();

    expect(budget.snapshot().categories.emergency.capBytes).toBe(
      DAEMON_EMERGENCY_POOL_BYTES,
    );
    expect(DAEMON_EMERGENCY_POOL_BYTES).toBeLessThan(3 * 1024 * 1024);
  });

  it('keeps the emergency pool unavailable to business reservations', () => {
    const budget = new ResourceBudget({
      capBytes: 100,
      normalAdmissionBytes: 60,
      categoryCaps: { outbound: 100, emergency: 10 },
    });
    const normal = budget.tryReserveComposite([
      { category: 'outbound', bytes: 60 },
    ]);
    expect(normal.ok).toBe(true);
    const completion = budget.tryReserveComposite(
      [{ category: 'outbound', bytes: 30 }],
      { priority: 'completion' },
    );
    expect(completion.ok).toBe(true);
    expect(
      budget.tryReserveComposite([{ category: 'outbound', bytes: 1 }], {
        priority: 'completion',
      }),
    ).toMatchObject({ ok: false, reason: 'parent_limit', limitBytes: 90 });
    expect(
      budget.tryReserveComposite([{ category: 'emergency', bytes: 10 }], {
        priority: 'completion',
      }).ok,
    ).toBe(true);
    expect(budget.snapshot().usedBytes).toBe(100);
  });

  it('keeps emergency reservations outside normal admission accounting', () => {
    const budget = new ResourceBudget({
      capBytes: 100,
      normalAdmissionBytes: 80,
      categoryCaps: {
        background: 100,
        emergency: 10,
      },
    });
    const business = budget.tryReserveComposite([
      { category: 'background', bytes: 80 },
    ]);
    expect(business.ok).toBe(true);

    const emergency = budget.tryReserveComposite([
      { category: 'emergency', bytes: 10 },
    ]);
    expect(emergency.ok).toBe(true);
    expect(budget.snapshot()).toMatchObject({
      usedBytes: 90,
      normalUsedBytes: 80,
    });

    if (!business.ok || !emergency.ok) return;
    emergency.lease.release();
    business.lease.release();
    expect(budget.snapshot()).toMatchObject({
      usedBytes: 0,
      normalUsedBytes: 0,
    });
  });

  it('supports split, transfer, grow, shrink, and idempotent release', () => {
    const budget = new ResourceBudget({
      capBytes: 100,
      normalAdmissionBytes: 100,
      categoryCaps: { ingress: 100 },
    });
    const reservation = budget.tryReserveComposite(
      [{ category: 'ingress', bytes: 60 }],
      { owner: { operation: 'request' } },
    );
    if (!reservation.ok) throw new Error('reservation failed');

    const child = reservation.lease.split(
      [{ category: 'ingress', bytes: 20 }],
      { operation: 'delivery' },
    );
    expect(reservation.lease.bytes).toBe(40);
    expect(child.currentOwner).toEqual({ operation: 'delivery' });
    child.transferOwner({ operation: 'owned' });
    expect(child.currentOwner).toEqual({ operation: 'owned' });
    expect(
      reservation.lease.tryGrow([{ category: 'ingress', bytes: 10 }]).ok,
    ).toBe(true);
    reservation.lease.shrink([{ category: 'ingress', bytes: 5 }]);

    child.release();
    child.release();
    reservation.lease.release();
    reservation.lease.release();

    expect(budget.snapshot().usedBytes).toBe(0);
    expect(budget.snapshot().categories.ingress.highWaterBytes).toBe(70);
  });

  it('leaves accounting unchanged after a rejected grow', () => {
    const budget = new ResourceBudget({
      capBytes: 100,
      normalAdmissionBytes: 100,
      categoryCaps: { ingress: 50 },
    });
    const reservation = budget.tryReserveComposite([
      { category: 'ingress', bytes: 40 },
    ]);
    if (!reservation.ok) throw new Error('reservation failed');

    expect(
      reservation.lease.tryGrow([{ category: 'ingress', bytes: 11 }]),
    ).toMatchObject({
      ok: false,
      reason: 'category_limit',
    });
    expect(reservation.lease.bytes).toBe(40);
    expect(budget.snapshot().usedBytes).toBe(40);
  });

  it('rejects invalid configuration and reservations', () => {
    expect(
      () => new ResourceBudget({ capBytes: 10, normalAdmissionBytes: 11 }),
    ).toThrow(/must not exceed/);
    const budget = new ResourceBudget({
      capBytes: 10,
      normalAdmissionBytes: 10,
      categoryCaps: { ingress: 10 },
    });
    expect(() =>
      budget.tryReserveComposite([{ category: 'ingress', bytes: -1 }]),
    ).toThrow(/non-negative safe integer/);
  });

  it('rejects unsafe combined reservations without changing counters', () => {
    const budget = new ResourceBudget();
    expect(() =>
      budget.tryReserveComposite([
        { category: 'ingress', bytes: Number.MAX_SAFE_INTEGER },
        { category: 'ingress', bytes: 1 },
      ]),
    ).toThrow(/combined resource reservation is too large/);
    expect(budget.snapshot().usedBytes).toBe(0);
  });
});
