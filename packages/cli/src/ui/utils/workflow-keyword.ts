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
 * The reminder also says where the authoring reference is, because the Workflow
 * tool's description no longer carries it. It names the reference; it does not
 * carry it. The prefix becomes part of the user's own message — rendered in the
 * transcript, restored into the input buffer when a queued turn is cancelled,
 * kept in history on every later request — and a skill body travelling that way
 * would miss everything a real Skill load gets: dedup on resume, `/context`
 * attribution, microcompaction, and the skill's declared side effects.
 */

import {
  resolveWorkflowAuthoringSurface,
  ToolNames,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from '@qwen-code/qwen-code-core';
import type {
  Config,
  WorkflowAuthoringSurface,
} from '@qwen-code/qwen-code-core';

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
 *
 * `surface` is what the Workflow tool's description actually holds. Only a
 * description that points at the skill gets a closing sentence about loading
 * it: when the reference is inlined there is nothing to load, and when the user
 * withheld it there is nothing the model should go looking for.
 */
export function buildWorkflowSteeringNotice(
  surface?: WorkflowAuthoringSurface,
): string {
  const base =
    'The user\'s message includes the "workflow" keyword. If this request ' +
    'benefits from orchestrating multiple steps or subagents, strongly prefer ' +
    'the Workflow tool — author a script using phase(), log(), agent(), and ' +
    'parallel()/pipeline() — over ad-hoc sequential tool calls. If a workflow ' +
    'is not a good fit for this request, proceed normally.';
  const load =
    ` Before writing a script, load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` ` +
    'skill unless it is already in this conversation';
  if (surface === 'pointer') return `${base}${load}.`;
  if (surface === 'pointer-via-tool-search') {
    return `${base}${load}; reveal the Skill tool with ToolSearch first.`;
  }
  return base;
}

/**
 * The `<system-reminder>` prefix for this submission, or `null` when there
 * should be none.
 *
 * `null` when the keyword is absent, when the Workflow tool is not in this
 * session (steering toward a tool the model cannot call helps nobody), and for
 * a shell-mode submission — that text goes to bash, where a leading
 * `<system-reminder>` is a syntax error, and is recorded as the command the
 * user ran.
 *
 * The description shape is read from the Workflow tool instance, which
 * recorded it when it was built, rather than re-derived: a `/skills` toggle
 * since then must not make the reminder and the description disagree.
 */
export function buildWorkflowKeywordPrefix(
  config: Config,
  text: string,
  options: { shellMode?: boolean } = {},
): string | null {
  if (options.shellMode) return null;
  if (!detectWorkflowKeyword(text)) return null;
  let surface: WorkflowAuthoringSurface | undefined;
  try {
    const registry = config.getToolRegistry?.();
    const toolNames = registry?.getAllToolNames?.();
    // Registered counts, deferred included: a Workflow tool withheld by a
    // `tools.eager` allowlist is still one ToolSearch away.
    if (Array.isArray(toolNames) && !toolNames.includes(ToolNames.WORKFLOW)) {
      return null;
    }
    const tool = registry?.getTool?.(ToolNames.WORKFLOW) as
      | { authoringSurface?: WorkflowAuthoringSurface }
      | undefined;
    surface = tool?.authoringSurface ?? resolveWorkflowAuthoringSurface(config);
  } catch {
    // The steering sentence does not depend on the surface; losing only the
    // closing sentence is the right degradation.
    surface = undefined;
  }
  return `<system-reminder>\n${buildWorkflowSteeringNotice(surface)}\n</system-reminder>\n\n`;
}
