/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  claimInterruptedWorkflowRuns,
  type InterruptedWorkflowRun,
} from '@qwen-code/qwen-code-core/agents/workflow-checkpoint.js';
import {
  buildResumeCall,
  hasUninlinableResumeArgs,
} from '@qwen-code/qwen-code-core/agents/workflow-resume-call.js';
import { snapshotArgsUnavailable } from '@qwen-code/qwen-code-core/agents/workflow-snapshot.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';

/** Runs named one by one in the notice; the rest are counted. */
const MAX_LISTED_RUNS = 3;

/**
 * The startup notice for runs a previous process left unfinished: one line per
 * run with how far it got, and the call that resumes it when it can be
 * resumed. For the user, not the model — it is never added to the
 * conversation.
 */
export function formatInterruptedWorkflowRunsNotice(
  runs: readonly InterruptedWorkflowRun[],
  options: { nameOnly?: boolean } = {},
): string | undefined {
  if (runs.length === 0) return undefined;
  const lines = [
    runs.length === 1
      ? 'A workflow run was interrupted when the Qwen Code process running it exited:'
      : `${runs.length} workflow runs were interrupted when the Qwen Code process running them exited:`,
  ];
  for (const { snapshot, resumeName, hasJournal } of runs.slice(
    0,
    MAX_LISTED_RUNS,
  )) {
    const name = stripAnsiAndControl(
      snapshot.meta?.name ?? snapshot.workflowName ?? '',
    );
    const agents =
      snapshot.agentsDispatched > 0
        ? ` · ${snapshot.agentsCompleted}/${snapshot.agentsDispatched} agents finished`
        : '';
    lines.push(`  ${snapshot.runId}${name ? ` · ${name}` : ''}${agents}`);
    const target = {
      runId: snapshot.runId,
      scriptPath: snapshot.scriptPath,
      args: snapshot.args,
      resumeName,
      nameOnly: options.nameOnly === true,
    };
    const call = hasJournal ? buildResumeCall(target) : null;
    if (call) {
      // The third reader of this predicate, beside the daemon's refusal and
      // the task projection. This notice is a call to paste, and on this
      // path nothing refuses it: a run whose history cannot name its args
      // would resume with none, replay nothing and re-dispatch every agent.
      const argsNote =
        snapshotArgsUnavailable(snapshot) || hasUninlinableResumeArgs(target)
          ? ' (pass its original args too)'
          : '';
      lines.push(`    resume: ${call}${argsNote}`);
    }
  }
  if (runs.length > MAX_LISTED_RUNS) {
    lines.push(`  …and ${runs.length - MAX_LISTED_RUNS} more.`);
  }
  lines.push('Run /workflows to see them.');
  return lines.join('\n');
}

/**
 * Claim the runs a previous process left unfinished and describe them.
 * Never throws: a notice is not worth failing startup over.
 */
export async function getInterruptedWorkflowRunsNotice(
  config: Config,
): Promise<string | undefined> {
  try {
    const runs = await claimInterruptedWorkflowRuns(config);
    return formatInterruptedWorkflowRunsNotice(runs, {
      nameOnly: config.isWorkflowNameOnly?.() === true,
    });
  } catch {
    return undefined;
  }
}
