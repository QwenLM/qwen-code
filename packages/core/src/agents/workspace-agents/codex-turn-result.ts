/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview What a Codex turn ending actually tells us (plan P3).
 *
 * Codex has no equivalent of the six `thread_*` tools, so it never calls one to
 * say how its work ended. Locally, a run that reaches `completed` without
 * calling a closing tool is recorded `unclosed` rather than as implicit success
 * (`run-lifecycle.ts`); applied literally to Codex that would make every Codex
 * turn `unclosed` forever, with a person marking each by hand.
 *
 * Architecture §5's rule, implemented here: a turn ending plus a structured
 * result item is a result; a turn merely ending is `unclosed`. The prose the
 * model wrote is never consulted — "Done!" is not evidence, and a rule that
 * read it would be guessing success from natural language, which §5 forbids and
 * which the local path already refuses to do.
 *
 * Names come from the Codex App Server protocol as published, not invented:
 * `turn/completed` carries `status: completed | interrupted | failed`, and
 * items are typed (`fileChange`, `agentMessage`, `exitedReviewMode`, …).
 *
 * Nothing here talks to Codex. Which signals count is the decision worth
 * getting right, and it can be settled — and argued with — without one.
 */

/** Codex `turn/completed` statuses. */
export type CodexTurnStatus = 'completed' | 'interrupted' | 'failed';

/**
 * Item types Codex can produce in a turn.
 *
 * Listed in full rather than as `string` so that a Codex version adding a type
 * is a compile error at the classification below — where somebody has to decide
 * whether it is a deliverable — instead of silently falling through to
 * "no result".
 */
export type CodexItemType =
  | 'userMessage'
  | 'agentMessage'
  | 'plan'
  | 'reasoning'
  | 'commandExecution'
  | 'fileChange'
  | 'mcpToolCall'
  | 'dynamicToolCall'
  | 'collabToolCall'
  | 'webSearch'
  | 'imageView'
  | 'functionCallOutput'
  | 'enteredReviewMode'
  | 'exitedReviewMode'
  | 'contextCompaction';

/**
 * The item types that are, on their own, a task result.
 *
 * `fileChange` is a deliverable: an edit with a path and a diff, which exists
 * whether or not anyone describes it. `exitedReviewMode` is Codex's own
 * explicit completion event for a review, carrying its final text.
 *
 * `agentMessage` is deliberately absent, and it is the whole point. It is
 * where "I've finished the analysis" would appear, and treating it as a result
 * is exactly the natural-language guess the rule exists to prevent.
 * `commandExecution`, `webSearch` and `plan` are work done, not work finished.
 */
export const CODEX_RESULT_ITEM_TYPES: ReadonlySet<CodexItemType> = new Set([
  'fileChange',
  'exitedReviewMode',
]);

export interface CodexTurnObservation {
  status: CodexTurnStatus;
  /** `item/completed` types seen during the turn, in order. */
  completedItemTypes: readonly CodexItemType[];
  /** From `turn/completed` when the status is `failed`. */
  error?: { message: string; codexErrorInfo?: string };
}

export type CodexTurnOutcome =
  /** A structured result arrived; the run may close as work delivered. */
  | { kind: 'result_ready'; evidence: CodexItemType[] }
  /**
   * The turn ended and produced nothing structured. Not a failure and not a
   * success — the same `unclosed` the local path records, awaiting a person.
   */
  | { kind: 'unclosed'; reason: string }
  /** The caller (or a person) stopped it. Distinct from failing. */
  | { kind: 'interrupted' }
  | { kind: 'failed'; message: string; codexErrorInfo?: string };

/**
 * Classify one finished Codex turn.
 *
 * Deliberately total and deliberately blind to content: it sees statuses and
 * item *types*, never item text. A caller that wants to show the assistant's
 * prose can — it just cannot use it to decide that the task is done.
 *
 * Known consequence, worth stating where it will be read: a read-only analysis
 * — which is exactly the first task the plan opens to an external caller —
 * produces an `agentMessage` and nothing else, so it classifies as `unclosed`
 * and waits for a person. That is the conservative answer this rule was chosen
 * for, not an oversight; if it proves too strict in practice the fix is to give
 * the adapter a deliverable to produce (an artifact item), not to start reading
 * the prose.
 */
export function classifyCodexTurn(
  observation: CodexTurnObservation,
): CodexTurnOutcome {
  if (observation.status === 'interrupted') return { kind: 'interrupted' };
  if (observation.status === 'failed') {
    return {
      kind: 'failed',
      message: observation.error?.message ?? 'Codex turn failed',
      ...(observation.error?.codexErrorInfo
        ? { codexErrorInfo: observation.error.codexErrorInfo }
        : {}),
    };
  }
  const evidence = observation.completedItemTypes.filter((type) =>
    CODEX_RESULT_ITEM_TYPES.has(type),
  );
  if (evidence.length > 0) {
    // Deduplicated and ordered by the set, so the evidence reads the same for
    // the same turn however many edits it made.
    return { kind: 'result_ready', evidence: [...new Set(evidence)] };
  }
  return {
    kind: 'unclosed',
    reason:
      'the turn ended with no deliverable and no explicit completion item',
  };
}

/**
 * How a classified turn closes the local run.
 *
 * The mapping is one-way on purpose: `result_ready` is the only outcome that
 * may close a run as delivered work, and `unclosed` maps to the same close kind
 * a local agent gets for ending without a hand-off, so a Codex turn and a Qwen
 * turn that both ended vaguely are recorded identically rather than one of them
 * being flattered by its runtime.
 */
export function codexOutcomeToCloseKind(
  outcome: CodexTurnOutcome,
): 'review' | 'unclosed' | undefined {
  switch (outcome.kind) {
    case 'result_ready':
      // `review`, not a silent completion: the work came from another runtime
      // under someone else's control, so a person accepts it rather than the
      // system accepting it on their behalf.
      return 'review';
    case 'unclosed':
      return 'unclosed';
    case 'interrupted':
    case 'failed':
      // Neither closes with a kind — the run ends by its terminal status, and
      // recording a close kind would claim the agent decided something.
      return undefined;
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unclassified Codex outcome: ${String(unreachable)}`);
    }
  }
}
