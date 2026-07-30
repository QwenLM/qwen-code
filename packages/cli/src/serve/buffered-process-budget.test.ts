/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DaemonBulkAdmissionError,
  FairDaemonProcessScheduler,
} from './fair-daemon-bulk-scheduler.js';
import { ResourceBudget } from './resource-budget.js';
import { runBufferedProcessOperation } from './buffered-process-budget.js';

describe('runBufferedProcessOperation', () => {
  it('holds the declared process output budget until completion', async () => {
    const budget = new ResourceBudget({
      capBytes: 1024,
      normalAdmissionBytes: 1024,
      categoryCaps: { process: 1024 },
    });
    let observed = 0;
    await runBufferedProcessOperation(
      new FairDaemonProcessScheduler(),
      budget,
      '/workspace',
      'git',
      256,
      async () => {
        observed = budget.snapshot().categories.process.usedBytes;
      },
    );
    expect(observed).toBe(256);
    expect(budget.snapshot().usedBytes).toBe(0);
  });

  it('releases the reservation when the task or scheduler rejects', async () => {
    const budget = new ResourceBudget({
      capBytes: 1024,
      normalAdmissionBytes: 1024,
      categoryCaps: { process: 1024 },
    });
    const scheduler = new FairDaemonProcessScheduler();

    await expect(
      runBufferedProcessOperation(
        scheduler,
        budget,
        '/workspace',
        'git',
        256,
        async () => {
          throw new Error('process failed');
        },
      ),
    ).rejects.toThrow('process failed');
    expect(budget.snapshot().usedBytes).toBe(0);

    scheduler.seal();
    await expect(
      runBufferedProcessOperation(
        scheduler,
        budget,
        '/workspace',
        'git',
        256,
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(DaemonBulkAdmissionError);
    expect(budget.snapshot().usedBytes).toBe(0);
  });
});
