/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  TotalSessionLimitExceededError,
  WorkspaceDrainingError,
} from './acp-session-bridge.js';
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
    expect(admission.snapshot()).toEqual({ liveCount: 1, inFlight: 1 });

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
    expect(admission.snapshot()).toEqual({ liveCount: 1, inFlight: 0 });
    bridges[1]!.sessionCount = 1;
    expect(admission.snapshot()).toEqual({ liveCount: 2, inFlight: 0 });
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

  it('tracks per-workspace reservations and supports drain rollback', () => {
    const admission = createTotalSessionAdmissionController({
      getBridges: () => [],
    });
    const reservation = admission.admit({
      operation: 'resume',
      workspaceCwd: '/work/a',
    });
    expect(admission.snapshotForWorkspace('/work/a')).toEqual({
      liveCount: 0,
      inFlight: 1,
    });

    admission.beginWorkspaceDrain('/work/a');
    expect(() =>
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/a' }),
    ).toThrow(WorkspaceDrainingError);
    admission.cancelWorkspaceDrain('/work/a');
    const afterRollback = admission.admit({
      operation: 'branch',
      workspaceCwd: '/work/a',
    });
    afterRollback?.release();
    reservation?.release();
    admission.completeWorkspaceDrain('/work/a');
    expect(admission.snapshotForWorkspace('/work/a').inFlight).toBe(0);
    const afterCompletion = admission.admit({
      operation: 'spawn',
      workspaceCwd: '/work/a',
    });
    afterCompletion?.release();
  });

  it('does not let an old reservation erase a replacement runtime count', () => {
    const admission = createTotalSessionAdmissionController({
      getBridges: () => [],
    });
    const oldReservation = admission.admit({
      operation: 'resume',
      workspaceCwd: '/work/a',
    });
    admission.beginWorkspaceDrain('/work/a');
    admission.completeWorkspaceDrain('/work/a');
    const replacementReservation = admission.admit({
      operation: 'spawn',
      workspaceCwd: '/work/a',
    });
    if (!oldReservation || !replacementReservation) {
      throw new Error('expected reservations');
    }

    oldReservation.release();
    expect(admission.snapshotForWorkspace('/work/a').inFlight).toBe(1);
    replacementReservation.release();
    expect(admission.snapshotForWorkspace('/work/a').inFlight).toBe(0);
  });
});
