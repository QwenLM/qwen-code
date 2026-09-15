/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The line between an agent that failed and a run that failed.
 *
 * A workflow dispatches agents the way a script calls functions, but an agent
 * is not a function: it can hit its turn cap, time out, have its model error
 * out, stall, or fail during setup, and none of that says anything about
 * whether the REST of the script can proceed. Those outcomes are the agent's
 * own, and the script sees them as `null` — the same value `parallel()` and
 * `pipeline()` have always put in a slot whose agent did not come back.
 *
 * The token budget, the agent cap, and cancellation belong to the run. Those
 * throw, because no later `agent()` call can succeed either.
 *
 * Before this split, a bare `await agent()` threw on all of it while the same
 * failure inside `parallel()` became `null`, so the same broken agent ended a
 * sequential script and merely dented a fan-out. `WorkflowAgentFailedError`
 * is the marker that lets the dispatch layer settle the first group to `null`
 * in both shapes, and it is what the journal records as `failed`.
 */

/** Which agent-level outcome produced the failure. */
export type WorkflowAgentFailureKind =
  /** The subagent hit its per-attempt turn ceiling. */
  | 'max_turns'
  /** The subagent hit its per-attempt wall-clock ceiling. */
  | 'timeout'
  /** The subagent's own execution errored out. */
  | 'error'
  /** `agent({schema})`: the subagent never produced a valid structured result. */
  | 'no_structured_output'
  /** The subagent made no progress through every watchdog attempt. */
  | 'stalled';

/**
 * An agent-level failure. The dispatch layer catches this, records `failed`
 * in the journal, and hands the script `null`; the run continues.
 *
 * Carries the terminate mode when there was one, so the failures list can say
 * what actually happened rather than "it failed".
 */
export class WorkflowAgentFailedError extends Error {
  override readonly name = 'WorkflowAgentFailedError';
  readonly kind: WorkflowAgentFailureKind;
  readonly terminateMode: string | undefined;

  constructor(
    message: string,
    kind: WorkflowAgentFailureKind,
    terminateMode?: string,
  ) {
    super(message);
    this.kind = kind;
    this.terminateMode = terminateMode;
  }
}

/**
 * Duck-typed on `name`: the error crosses the stall wrapper, the dispatch
 * scheduler and (for a fan-out slot) a vm realm boundary, any of which can
 * make `instanceof` unreliable. The registry does the same for
 * `WorkflowBudgetExceededError`.
 */
export function isWorkflowAgentFailedError(
  error: unknown,
): error is WorkflowAgentFailedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'WorkflowAgentFailedError'
  );
}

/** The run cannot dispatch another agent because its per-run cap is spent. */
export class WorkflowAgentCapExceededError extends Error {
  override readonly name = 'WorkflowAgentCapExceededError';

  constructor(maxAgents: number) {
    super(
      `Workflow exceeded the maximum of ${maxAgents} agent() calls per run.`,
    );
  }
}

/** Limits that make every later agent call fail too. */
export function isWorkflowRunLevelError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return (
    name === 'WorkflowBudgetExceededError' ||
    name === 'WorkflowAgentCapExceededError'
  );
}

/**
 * Abort reason on a dispatch's per-attempt controller. The stall watchdog
 * owns this value so the wrapper can distinguish its retry from cancellation.
 */
export const WORKFLOW_ABORT_REASON_STALLED = 'stalled';
