/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';

export function hasBlockingBackgroundWork(config: Config): boolean {
  return (
    // hasRunningTasks, not hasUnfinalizedTasks: a cancelled task whose
    // finalize callback hasn't fired yet must not block /clear or
    // session resume — both abort-and-reset the registry right after
    // this gate, suppressing the pending notification anyway. Gating on
    // the unfinalized set made /new silently no-op when typed in the
    // window between cancel and finalize (issue #5949).
    config.getBackgroundTaskRegistry().hasRunningTasks() ||
    config.getMonitorRegistry().getRunning().length > 0 ||
    config.getBackgroundShellRegistry().hasRunningEntries() ||
    // R7 (wenshao): the WorkflowRunRegistry is a 4th sibling that the
    // earlier P4b commit forgot to wire here. Without this OR clause,
    // /clear and session-resume happily ran while a workflow was
    // mid-run, orphaning the dispatch loop.
    config.getWorkflowRunRegistry().hasRunningEntries()
  );
}

export function resetBackgroundStateForSessionSwitch(config: Config): void {
  config.getBackgroundTaskRegistry().reset();
  config.getMonitorRegistry().reset();
  config.getBackgroundShellRegistry().reset();
  // R7 (wenshao): symmetric with hasBlockingBackgroundWork — without
  // this call, terminal workflow rows from the previous session
  // leaked into the next session's pill / dialog / /workflows list.
  config.getWorkflowRunRegistry().reset();
}
