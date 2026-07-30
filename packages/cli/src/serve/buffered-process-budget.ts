/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ResourceAdmissionError,
  type ResourceBudget,
} from './resource-budget.js';
import type { FairDaemonProcessScheduler } from './fair-daemon-bulk-scheduler.js';

export type BufferedProcessRunner = <T>(
  workspaceCwd: string,
  operation: string,
  maximumBufferedBytes: number,
  task: () => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;

export function createBufferedProcessRunner(
  scheduler: FairDaemonProcessScheduler,
  budget: ResourceBudget,
): BufferedProcessRunner {
  return (workspaceCwd, operation, maximumBufferedBytes, task, signal) =>
    runBufferedProcessOperation(
      scheduler,
      budget,
      workspaceCwd,
      operation,
      maximumBufferedBytes,
      task,
      signal,
    );
}

export async function runBufferedProcessOperation<T>(
  scheduler: FairDaemonProcessScheduler,
  budget: ResourceBudget,
  workspaceCwd: string,
  operation: string,
  maximumBufferedBytes: number,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(maximumBufferedBytes) || maximumBufferedBytes < 1) {
    throw new TypeError('maximumBufferedBytes must be a positive safe integer');
  }
  const reservation = budget.tryReserveComposite(
    [{ category: 'process', bytes: maximumBufferedBytes }],
    { owner: { workspaceId: workspaceCwd, operation } },
  );
  if (!reservation.ok) throw new ResourceAdmissionError(reservation);
  try {
    return await scheduler.run(workspaceCwd, operation, task, signal);
  } finally {
    reservation.lease.release();
  }
}
