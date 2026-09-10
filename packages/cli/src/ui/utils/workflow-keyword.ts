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
 *
 * The same reminder carries the `workflow-authoring` reference. This is the
 * one turn that is known in advance to be about orchestration, so the model
 * would otherwise spend a round trip loading a skill it is about to need —
 * and the tool description no longer carries the authoring contract itself.
 */

import {
  resolveWorkflowAuthoringAutoload,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';

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

/** What this turn is doing about the authoring reference. */
export type WorkflowAuthoringAutoloadStatus =
  | 'loaded'
  | 'already-loaded'
  | 'unavailable';

/**
 * The steering note injected into a triggered turn. A soft nudge, not a
 * forced tool call — the model keeps discretion so a casual mention of
 * "workflow" doesn't derail an unrelated request.
 *
 * The closing sentence tells the model where the authoring reference is, so
 * it does not spend a Skill call re-loading text that is already in the same
 * message — or, when nothing was injected, so it knows to go and get it.
 */
export function buildWorkflowSteeringNotice(
  autoload: WorkflowAuthoringAutoloadStatus = 'unavailable',
): string {
  const base =
    'The user\'s message includes the "workflow" keyword. If this request ' +
    'benefits from orchestrating multiple steps or subagents, strongly prefer ' +
    'the Workflow tool — author a script using phase(), log(), agent(), and ' +
    'parallel()/pipeline() — over ad-hoc sequential tool calls. If a workflow ' +
    'is not a good fit for this request, proceed normally.';
  if (autoload === 'loaded') {
    return (
      `${base} The \`${WORKFLOW_AUTHORING_SKILL_NAME}\` reference is ` +
      'included below; do not load it again.'
    );
  }
  if (autoload === 'already-loaded') {
    return (
      `${base} The \`${WORKFLOW_AUTHORING_SKILL_NAME}\` reference is ` +
      'already in this conversation.'
    );
  }
  // Nothing injected: either the reference is unreachable, in which case the
  // Workflow tool's own description carries it, or it could not be tracked.
  // Either way, saying "load it" would be advice the model cannot act on.
  return base;
}

/**
 * The `<system-reminder>` prefix for a turn the keyword triggered, or `null`
 * when the keyword is absent.
 *
 * Separate from the caller so the whole decision — detect, resolve the
 * reference, mark it loaded, render — is testable without a TUI. `markLoaded`
 * is called here rather than by the caller because the returned prefix is the
 * message: once it has been built there is no path that sends the turn
 * without it.
 */
export function buildWorkflowKeywordPrefix(
  config: Config,
  text: string,
): { prefix: string; autoloaded: boolean } | null {
  if (!detectWorkflowKeyword(text)) return null;
  const autoload = resolveWorkflowAuthoringAutoload(config);
  const notice = buildWorkflowSteeringNotice(autoload.status);
  if (autoload.status !== 'loaded') {
    return {
      prefix: `<system-reminder>\n${notice}\n</system-reminder>\n\n`,
      autoloaded: false,
    };
  }
  autoload.markLoaded();
  return {
    prefix: `<system-reminder>\n${notice}\n\n${autoload.content}</system-reminder>\n\n`,
    autoloaded: true,
  };
}
