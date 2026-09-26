/**
 * @license
 * Copyright 2025 Qwen
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
  } catch {
    return { threadsChanged: 0, runsStranded: 0 };
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
      if (live.length === 0) continue;
      const next: Thread = {
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
            : run,
        ),
      };
      await transaction.writeThread(next);
      threadsChanged += 1;
      runsStranded += live.length;
    }
    return { threadsChanged, runsStranded };
  });
}
