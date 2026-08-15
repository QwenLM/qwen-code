/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { ToolExecutionStatus } from '../core/turn.js';
import { SHELL_EXIT_CODE_PREFIX } from '../tools/shell-exit-code.js';
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
}

export type ToolExperienceOutcome = 'success' | 'failure';

const SUBSTANTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
  ToolNames.SHELL,
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

function hasKnownShellExitStatus(parts: readonly Part[] | undefined): boolean {
  let finalExitStatus: string | undefined;
  for (const part of parts ?? []) {
    const output = part.functionResponse?.response?.['output'];
    if (typeof output !== 'string') continue;
    for (const line of output.split(/\r?\n/)) {
      if (line.startsWith(SHELL_EXIT_CODE_PREFIX)) {
        finalExitStatus = line.slice(SHELL_EXIT_CODE_PREFIX.length).trim();
      }
    }
  }
  return finalExitStatus !== undefined && /^-?\d+$/.test(finalExitStatus);
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
    !hasKnownShellExitStatus(outcome.responseParts)
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
