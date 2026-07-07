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

    const reservation = admission({
      operation: 'spawn',
      workspaceCwd: '/work/a',
    });

    expect(() =>
      admission({ operation: 'spawn', workspaceCwd: '/work/b' }),
    ).toThrow(TotalSessionLimitExceededError);

    if (!reservation) throw new Error('expected reservation');
    reservation.release();
    bridges[1]!.sessionCount = 1;
    expect(() =>
      admission({ operation: 'spawn', workspaceCwd: '/work/c' }),
    ).toThrow(TotalSessionLimitExceededError);
  });

  it('treats undefined, zero, and Infinity as unlimited', () => {
    for (const maxTotalSessions of [undefined, 0, Infinity]) {
      const admission = createTotalSessionAdmissionController({
        maxTotalSessions,
        getBridges: () => [{ sessionCount: 99 }],
      });

      const reservation = admission({
        operation: 'spawn',
        workspaceCwd: '/work/a',
      });
      if (!reservation) throw new Error('expected reservation');
      reservation.release();
    }
  });
});
