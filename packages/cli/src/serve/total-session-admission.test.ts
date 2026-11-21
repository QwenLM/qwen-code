/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SystemOverloadedError,
  TotalSessionLimitExceededError,
  WorkspaceDrainingError,
} from './acp-session-bridge.js';
import type { LoadAdmissionSnapshot } from './load-admission.js';
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

describe('createTotalSessionAdmissionController load admission', () => {
  const overloadedSnapshot: LoadAdmissionSnapshot = {
    enabled: true,
    overloaded: true,
    reason: 'cpu_load',
    loadRatio: 2.5,
    eventLoopLagP99Ms: 120,
    sampledAtMs: 1_000,
  };
  const normalSnapshot: LoadAdmissionSnapshot = {
    ...overloadedSnapshot,
    overloaded: false,
    reason: null,
    loadRatio: 0.3,
  };

  it('refuses every fresh-child operation while overloaded, without reserving', () => {
    const admission = createTotalSessionAdmissionController({
      getBridges: () => [],
      loadAdmission: { snapshot: () => overloadedSnapshot },
    });
    for (const operation of ['spawn', 'load', 'resume', 'branch'] as const) {
      expect(() =>
        admission.admit({ operation, workspaceCwd: '/work/a' }),
      ).toThrow(SystemOverloadedError);
    }
    expect(admission.snapshot()).toEqual({ liveCount: 0, inFlight: 0 });
  });

  it('carries the monitor reason and readings on the error', () => {
    const admission = createTotalSessionAdmissionController({
      getBridges: () => [],
      loadAdmission: { snapshot: () => overloadedSnapshot },
    });
    try {
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/a' });
      throw new Error('expected SystemOverloadedError');
    } catch (err) {
      expect(err).toBeInstanceOf(SystemOverloadedError);
      expect(err).toMatchObject({
        reason: 'cpu_load',
        loadRatio: 2.5,
        eventLoopLagP99Ms: 120,
      });
    }
  });

  it('admits normally when the monitor reports no overload', () => {
    const admission = createTotalSessionAdmissionController({
      maxTotalSessions: 1,
      getBridges: () => [],
      loadAdmission: { snapshot: () => normalSnapshot },
    });
    const reservation = admission.admit({
      operation: 'spawn',
      workspaceCwd: '/work/a',
    });
    expect(admission.snapshot().inFlight).toBe(1);
    reservation?.release();
    expect(admission.snapshot().inFlight).toBe(0);
  });

  it('reads the monitor at admission time, not at construction', () => {
    let snapshot = normalSnapshot;
    const admission = createTotalSessionAdmissionController({
      getBridges: () => [],
      loadAdmission: { snapshot: () => snapshot },
    });
    const reservation = admission.admit({
      operation: 'spawn',
      workspaceCwd: '/work/a',
    });
    reservation?.release();
    snapshot = overloadedSnapshot;
    expect(() =>
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/a' }),
    ).toThrow(SystemOverloadedError);
  });

  it('keeps drain precedence over load refusal', () => {
    const admission = createTotalSessionAdmissionController({
      getBridges: () => [],
      loadAdmission: { snapshot: () => overloadedSnapshot },
    });
    admission.beginWorkspaceDrain('/work/a');
    expect(() =>
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/a' }),
    ).toThrow(WorkspaceDrainingError);
  });

  it('reports overload before the count limit when both trip', () => {
    const admission = createTotalSessionAdmissionController({
      maxTotalSessions: 1,
      getBridges: () => [{ sessionCount: 1 }],
      loadAdmission: { snapshot: () => overloadedSnapshot },
    });
    expect(() =>
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/a' }),
    ).toThrow(SystemOverloadedError);
  });

  it('behaves exactly as before when no monitor is wired', () => {
    const admission = createTotalSessionAdmissionController({
      maxTotalSessions: 1,
      getBridges: () => [{ sessionCount: 0 }],
    });
    const reservation = admission.admit({
      operation: 'spawn',
      workspaceCwd: '/work/a',
    });
    expect(() =>
      admission.admit({ operation: 'spawn', workspaceCwd: '/work/b' }),
    ).toThrow(TotalSessionLimitExceededError);
    reservation?.release();
  });
});
