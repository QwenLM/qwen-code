/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Closing out runs the collaboration opt-in left behind.
 *
 * The dispatcher's recovery sweep asks, of every `running` run, whether the
 * runtime body is still there; a missing body with attempts left means a crash,
 * so it requeues and starts again. That is right for a crash and wrong for a
 * run the operator switched off underneath: recovery cannot tell the two apart,
 * because in both cases the daemon restarted and the body is gone.
 *
 * So the distinction is drawn at the only moment it is knowable — a daemon
 * starting with collaboration off — and recorded in the store, where recovery
 * will later find a terminal run rather than a live one to revive.
 */

import * as fsp from 'node:fs/promises';

import { isNodeError } from '../../utils/errors.js';
import { applyAggregateStatus } from './run-lifecycle.js';
import { getAgentsDir, withAgentStoreTransaction } from './store.js';
import type { Thread } from './types.js';

/** Recorded on the run so the reason survives into the UI and any audit. */
export const STRANDED_FAILURE_STAGE = 'collaboration-disabled';

export interface StrandedRunsResult {
  threadsChanged: number;
  runsStranded: number;
}

/**
 * Close every live local run in this workspace as stranded.
 *
 * Terminal, so nothing re-queues or re-dispatches it, and marked
 * `closeKind: 'stranded'` so the UI can say why and flag it as outstanding
 * rather than filing it with ordinary failures. No system message is posted:
 * a message is an event other agents react to, and nothing here is a thing an
 * agent should answer — the audience is a person.
 *
 * Idempotent. A second call finds no live runs and writes nothing, so a daemon
 * that restarts repeatedly with the opt-in off does not churn the store.
 */
export async function strandLocalRuns(
  projectRoot: string,
  now = Date.now(),
): Promise<StrandedRunsResult> {
  // Checked before the transaction, not inside it: opening one creates the
  // store's directory and its lock file. A workspace that never used
  // collaboration must come out of an opted-out daemon's startup with nothing
  // written into it at all — the plan asks for the enabled-workspace filter to
  // run before any collaboration storage is read, and creating the directory in
  // order to find it empty would violate that in the most visible way.
  try {
    await fsp.stat(getAgentsDir(projectRoot));
  } catch (error) {
    // Only a missing store means "never used". Anything else (EACCES, EIO)
    // would otherwise look like a clean sweep with live runs left behind.
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { threadsChanged: 0, runsStranded: 0 };
    }
    throw error;
  }
  return withAgentStoreTransaction(projectRoot, async (transaction) => {
    const { threads } = await transaction.listThreads();
    let threadsChanged = 0;
    let runsStranded = 0;
    for (const thread of threads) {
      // `queued` runs are deliberately left alone: nothing started them, so
      // there is no orphaned body and no ambiguity for recovery to get wrong.
      // They simply wait, and run normally whenever the operator opts back in.
      const live = thread.runs.filter(
        (run) => run.status === 'running' || run.status === 'finishing',
      );
      // A run already being cancelled was going to end as `cancelled`; with
      // its body gone that is simply where it ends. Stranding it instead would
      // record an operator's cancellation as something a person must decide.
      const cancelling = thread.runs.some((run) => run.status === 'cancelling');
      if (live.length === 0 && !cancelling) continue;
      let next: Thread = {
        ...thread,
        runs: thread.runs.map((run) =>
          run.status === 'running' || run.status === 'finishing'
            ? {
                ...run,
                status: 'failed' as const,
                endedAt: now,
                closeKind: 'stranded' as const,
                failureStage: STRANDED_FAILURE_STAGE,
              }
            : run.status === 'cancelling'
              ? { ...run, status: 'cancelled' as const, endedAt: now }
              : run,
        ),
      };
      // Nothing else will touch this thread while collaboration is off, so
      // its status is settled here or it keeps claiming work is in progress.
      next = await applyAggregateStatus(transaction, next, now);
      await transaction.writeThread(next);
      threadsChanged += 1;
      runsStranded += live.length;
    }
    return { threadsChanged, runsStranded };
  });
}
