/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallResponseInfo } from '../core/turn.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { canonicalToolName, ToolNames } from '../tools/tool-names.js';
import { Kind, MUTATOR_KINDS } from '../tools/tools.js';
import { isShellResultDisplay } from '../utils/shell-result.js';

export interface ExperienceSignals {
  retryArc: boolean;
  userSteer: boolean;
  hasSubstantiveWork: boolean;
}

export type CompletedToolOutcome = Pick<
  ToolCallResponseInfo,
  'callId' | 'executionStatus' | 'error' | 'errorType' | 'resultDisplay'
>;

const SUBSTANTIVE_TOOLS = new Set<string>([
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.NOTEBOOK_EDIT,
  ToolNames.SHELL,
  ToolNames.EXEC,
  ToolNames.AGENT,
]);

export function isSubstantiveToolCall(name: string, kind?: Kind): boolean {
  return (
    SUBSTANTIVE_TOOLS.has(canonicalToolName(name)) ||
    (kind !== undefined && MUTATOR_KINDS.includes(kind)) ||
    kind === Kind.Agent ||
    (name.startsWith('mcp__') && kind === Kind.Other)
  );
}

export function didToolCallProduceWork(outcome: CompletedToolOutcome): boolean {
  return (
    (outcome.executionStatus === 'success' ||
      outcome.executionStatus === 'error') &&
    outcome.errorType !== ToolErrorType.EXECUTION_DENIED &&
    (!isShellResultDisplay(outcome.resultDisplay) ||
      outcome.resultDisplay.outcome !== 'cancelled')
  );
}

export function classifyToolExperience(
  toolName: string,
  outcome: CompletedToolOutcome,
): 'success' | 'failure' | null {
  if (!didToolCallProduceWork(outcome)) return null;
  const shell = isShellResultDisplay(outcome.resultDisplay)
    ? outcome.resultDisplay
    : undefined;
  if (outcome.executionStatus === 'error' && outcome.error) return 'failure';
  if (outcome.error || outcome.executionStatus !== 'success') return null;
  if (
    canonicalToolName(toolName) === ToolNames.SHELL &&
    (!shell || shell.outcome !== 'completed' || shell.exitCode !== 0)
  ) {
    return null;
  }
  return 'success';
}

export function accumulateRetryBatch(
  failedToolNames: Set<string>,
  outcomes: ReadonlyArray<{
    toolName: string;
    outcome: 'success' | 'failure' | null;
  }>,
): boolean {
  const failed = new Set(
    outcomes
      .filter((entry) => entry.outcome === 'failure')
      .map((entry) => canonicalToolName(entry.toolName)),
  );
  let retryArc = false;
  for (const entry of outcomes) {
    const name = canonicalToolName(entry.toolName);
    // Parallel sibling successes do not prove recovery from a sibling failure.
    if (entry.outcome === 'success' && !failed.has(name)) {
      retryArc = failedToolNames.delete(name) || retryArc;
    }
  }
  for (const name of failed) failedToolNames.add(name);
  return retryArc;
}
