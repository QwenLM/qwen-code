/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { ToolExecutionStatus } from '../core/turn.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { canonicalToolName, ToolNames } from '../tools/tool-names.js';

export interface ExperienceSignals {
  retryArc: boolean;
  userSteer: boolean;
  hasSubstantiveWork: boolean;
}

export interface ExperienceSignalAccumulator
  extends Omit<ExperienceSignals, 'userSteer'> {
  failedToolNames: ReadonlySet<string>;
}

export interface CompletedToolCallOutcome {
  callId: string;
  status: 'success' | 'error' | 'cancelled';
  executionStatus?: ToolExecutionStatus;
  errorType?: ToolErrorType;
  responseParts?: readonly Part[];
  /**
   * Structured shell exit status, forwarded only by the foreground-completion
   * path that actually ran a process to term. Absent for renders that never
   * carry a genuine exit code — promoted-to-background, sed-edit,
   * promote-refused — so the gate below classifies from a real exit code
   * instead of scanning output text that the model's own command or arbitrary
   * stdout can spoof with a line-initial `Exit Code: `.
   */
  exitCode?: number | null;
}

export type ToolExperienceOutcome = 'success' | 'failure';

const SUBSTANTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
  ToolNames.SHELL,
  ToolNames.EXEC,
]);

export function isSubstantiveToolCall(name: string): boolean {
  return SUBSTANTIVE_TOOL_NAMES.has(canonicalToolName(name));
}

export function didToolCallProduceWork(
  outcome: CompletedToolCallOutcome,
): boolean {
  return (
    outcome.executionStatus === 'success' || outcome.executionStatus === 'error'
  );
}

export function classifyToolExperienceOutcome(
  toolName: string,
  outcome: CompletedToolCallOutcome,
): ToolExperienceOutcome | null {
  if (!didToolCallProduceWork(outcome)) {
    return null;
  }
  if (outcome.errorType === ToolErrorType.EXECUTION_DENIED) {
    return null;
  }
  if (outcome.status === 'error' && outcome.executionStatus === 'error') {
    return 'failure';
  }
  if (outcome.status !== 'success' || outcome.executionStatus !== 'success') {
    return null;
  }
  if (
    canonicalToolName(toolName) === ToolNames.SHELL &&
    typeof outcome.exitCode !== 'number'
  ) {
    return null;
  }
  return 'success';
}

export function accumulateExperienceOutcome(
  initial: ExperienceSignalAccumulator,
  toolName: string,
  outcome: ToolExperienceOutcome,
): ExperienceSignalAccumulator {
  let { retryArc } = initial;
  const failedToolNames = new Set(initial.failedToolNames);
  const canonicalName = canonicalToolName(toolName);
  if (outcome === 'failure') {
    failedToolNames.add(canonicalName);
  } else if (failedToolNames.delete(canonicalName)) {
    retryArc = true;
  }
  return {
    retryArc,
    hasSubstantiveWork: initial.hasSubstantiveWork,
    failedToolNames,
  };
}
