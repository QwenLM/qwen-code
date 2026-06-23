/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview P7-trigger: the `workflow` keyword trigger. When a user's
 * prompt mentions `workflow` (as a whole word), the turn is softly steered
 * toward the Workflow tool by prepending a system reminder. This is the
 * qwen-code analogue of upstream's keyword opt-in — deliberately keyed on the
 * plain word `workflow` (never any other marker).
 */

/**
 * Edge punctuation stripped from a token before the keyword comparison, so
 * `workflow.` / `workflow?` / `(workflow)` still count. Deliberately excludes
 * hyphens and digits so compound identifiers (`my-workflow-runner`,
 * `workflow2`) do NOT trigger.
 */
const STRIP_EDGE_PUNCT = /^[.,!?;:'"()[\]{}<>]+|[.,!?;:'"()[\]{}<>]+$/g;

/**
 * True when `text` contains `workflow` as a standalone word (case-insensitive).
 * Tokenizes on whitespace and strips edge punctuation, so `Workflow` and
 * `a workflow.` match while `workflows`, `dataflow`, and `my-workflow-runner`
 * do not — a stricter notion of "word" than `\bworkflow\b` (which treats
 * hyphens as boundaries and would over-match compound identifiers).
 */
export function detectWorkflowKeyword(text: string): boolean {
  return text
    .toLowerCase()
    .split(/\s+/)
    .some((token) => token.replace(STRIP_EDGE_PUNCT, '') === 'workflow');
}

/**
 * The steering note injected into a triggered turn. A soft nudge, not a
 * forced tool call — the model keeps discretion so a casual mention of
 * "workflow" doesn't derail an unrelated request.
 */
export function buildWorkflowSteeringNotice(): string {
  return (
    'The user\'s message includes the "workflow" keyword. If this request ' +
    'benefits from orchestrating multiple steps or subagents, strongly prefer ' +
    'the Workflow tool — author a script using phase(), log(), agent(), and ' +
    'parallel()/pipeline() — over ad-hoc sequential tool calls. If a workflow ' +
    'is not a good fit for this request, proceed normally.'
  );
}
