/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { TotalSessionLimitExceededError } from './acp-session-bridge.js';
import { createTotalSessionAdmissionController } from './total-session-admission.js';

describe('createTotalSessionAdmissionController', () => {
  it('counts live bridge sessions plus in-flight reservations across runtimes', () => {
    const bridges = [{ sessionCount: 1 }, { sessionCount: 0 }];
    const admission = createTotalSessionAdmissionController({
      maxTotalSessions: 2,
      getBridges: () => bridges,
    });

    const reservation = admission.admit({
      operation: 'spawn',
      workspaceCwd: '/work/a',
    });
    expect(admission.snapshot()).toEqual({ inFlight: 1 });

    expect(() =>
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/b' }),
    ).toThrow(TotalSessionLimitExceededError);
    try {
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/b' });
    } catch (err) {
      expect(err).toMatchObject({
        operation: 'spawn',
        workspaceCwd: '/work/b',
      });
    }

    if (!reservation) throw new Error('expected reservation');
    reservation.release();
    expect(admission.snapshot()).toEqual({ inFlight: 0 });
    bridges[1]!.sessionCount = 1;
    expect(() =>
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/c' }),
    ).toThrow(TotalSessionLimitExceededError);
  });

  it('treats undefined, zero, and Infinity as unlimited', () => {
    for (const maxTotalSessions of [undefined, 0, Infinity]) {
      const admission = createTotalSessionAdmissionController({
        maxTotalSessions,
        getBridges: () => [{ sessionCount: 99 }],
      });

      const reservation = admission.admit({
        operation: 'spawn',
        workspaceCwd: '/work/a',
      });
      if (!reservation) throw new Error('expected reservation');
      reservation.release();
    }
  });

  it('ignores duplicate release calls', () => {
    const admission = createTotalSessionAdmissionController({
      maxTotalSessions: 1,
      getBridges: () => [{ sessionCount: 0 }],
    });

    const reservation = admission.admit({
      operation: 'spawn',
      workspaceCwd: '/work/a',
    });
    if (!reservation) throw new Error('expected reservation');

    expect(() =>
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/b' }),
    ).toThrow(TotalSessionLimitExceededError);

    reservation.release();
    reservation.release();

    const nextReservation = admission.admit({
      operation: 'spawn',
      workspaceCwd: '/work/c',
    });
    if (!nextReservation) throw new Error('expected reservation');
    nextReservation.release();
  });
});
