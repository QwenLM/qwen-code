/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `/simplify` bundled skill — behavior-preserving cleanup with
 * four parallel review agents, or one inline pass when delegation is unavailable.
 */

import { AGENT_TOOL_NAME } from '../../tools/definitions/base-declarations.js';
import type { BundledSkillRegistrar } from './index.js';

interface SimplifyBodyContext {
  skillDir: string;
  sessionId: string;
  toolNames?: readonly string[];
}

const REVIEW_SCOPE = `## Phase 0 — Gather the diff

Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there is no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and
include the working-tree changes. If a PR number, branch name, or file path was
passed as an argument, review that target instead. Treat this diff as the review scope.
`;

const REVIEW_ANGLES = `### Reuse

Find new code that reimplements existing functionality. Search shared utility
modules and files adjacent to the change, and name the existing helper to use.

### Simplification

Find unnecessary complexity introduced by the diff: redundant or derivable state,
copy-paste with slight variation, deep nesting, and dead code left behind.
Name the simpler form that does the same job.

### Efficiency

Find wasted work introduced by the diff: redundant computation, repeated I/O,
independent operations run sequentially, and blocking work added to startup or
hot paths. Check long-lived objects built from closures or captured environments
that retain large values from the enclosing scope; prefer a class or struct that
copies only the fields it needs. Name the cheaper alternative.

### Altitude

Check whether each change addresses the root cause at the right depth instead of
patching a symptom. Look for special cases layered on shared infrastructure.
Name a simpler, more general change to the underlying mechanism when that would
replace a fragile patch.
`;

const APPLY_FIXES = `Deduplicate findings that point at the same line or mechanism, then fix each
remaining issue directly. Skip findings whose fixes would change intended behavior,
require changes well outside the reviewed diff, or are false positives. Note the
skip rather than arguing with it.

Finish with a brief summary of what was fixed and what was skipped, or confirm
that the code was already clean.
`;

function buildSimplifyPrompt(canDelegate: boolean): string {
  const review = canDelegate
    ? `## Phase 1 — Review (4 cleanup agents in parallel)

Launch four independent review agents with the ${AGENT_TOOL_NAME} tool in a single
message so they run concurrently. Give each agent the diff and one of the four
angles below.`
    : `## Phase 1 — Review (4 cleanup angles, single pass)

The ${AGENT_TOOL_NAME} tool is unavailable or cannot spawn another agent in this context.
Review all four angles below yourself in this context, in one pass. Do not skip
an angle because delegation is unavailable.`;
  const apply = canDelegate
    ? `Wait for all four agents to complete. ${APPLY_FIXES}`
    : `${APPLY_FIXES}
State clearly in the summary that this was a single-pass inline review without
${AGENT_TOOL_NAME} delegation, not the full four-agent parallel review.
`;
  return `# Simplify: Code Cleanup

Improve the quality of the changed code without changing intended behavior.
Review reuse, simplification, efficiency, and altitude, then apply the fixes.
Do not hunt for correctness bugs.

${REVIEW_SCOPE}
${review}
For each finding, return \`file\`, \`line\`, a one-line \`summary\`, and the concrete
cost: what is duplicated, wasted, or harder to maintain.

${REVIEW_ANGLES}
## Phase 2 — Apply the fixes

${apply}`;
}

export function registerSimplifySkill(registrar: BundledSkillRegistrar): void {
  registrar.registerBundledSkill({
    name: 'simplify',
    description:
      'Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs.',
    argumentHint: '[<target>]',
    location: 'bundled',
    body: '',
    userInvocable: true,
    disableModelInvocation: true,
    async getBody(args, context?: SimplifyBodyContext) {
      // No tool list means the capability is unknown, so assume delegation works.
      const canDelegate = context?.toolNames?.includes(AGENT_TOOL_NAME) ?? true;
      const target = args?.trim();
      return `${target ? `Review target: \`${target}\`\n\n` : ''}${buildSimplifyPrompt(canDelegate)}`;
    },
  });
}
