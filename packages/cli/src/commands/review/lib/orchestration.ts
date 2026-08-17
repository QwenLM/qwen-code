/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which engine dispatches Step 3's fan-out: the workflow runtime, or the
// orchestrator launching agents by hand.
//
// One predicate, because two would drift. `emit-workflow` refuses the reviews
// it cannot serve, and the skill has to know which path to take BEFORE it runs
// anything — if those were separate decisions, a run could be told "use the
// workflow" and then be refused by the emitter, or worse, be told "use the
// roster" while the emitter would happily have produced a script. The skill
// asks by running the emitter; this function is what it asks.
//
// Eligibility is not a preference. Every `legacy` verdict below is a fact
// about what the workflow path cannot do yet — not a policy dial — so the list
// shrinks as the runtime gains capability, and each entry names the specific
// missing piece rather than saying "unsupported".

import { isTerritoryFanOut, reviewMode, type RosterPlan } from './roster.js';

/** How Step 3 should dispatch, and why. */
export interface OrchestrationVerdict {
  mode: 'workflow' | 'legacy';
  /**
   * One sentence, written for the reader of a terminal. On `legacy` it names
   * what is missing and what to do; on `workflow` it names what was checked.
   */
  reason: string;
}

/**
 * Is the workflow runtime available to run what `emit-workflow` emits?
 *
 * Mirrors `Config.isWorkflowsEnabled`'s env half. The settings half is not
 * visible from a subcommand, which has no Config — so a project that enabled
 * workflows only through settings is treated as off here and has to set the
 * env var as well. That is the fail-closed direction: emitting a script
 * nothing can run wastes a step and reports no reason.
 */
export function workflowsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env['QWEN_CODE_DISABLE_WORKFLOWS'] === '1') return false;
  return env['QWEN_CODE_ENABLE_WORKFLOWS'] === '1';
}

/**
 * The `/review`-specific gate, on top of the runtime's own.
 *
 * Two switches rather than one because they answer different questions.
 * `QWEN_CODE_ENABLE_WORKFLOWS` says the runtime may run scripts at all — a
 * project-wide capability decision. This one says `/review` may route ITS
 * fan-out through that runtime, which is the thing under A/B and the thing
 * that has to be revertible on its own. Folding them would mean a project
 * that wants workflows for anything else has silently opted its reviews in
 * too, and rolling reviews back would take the runtime down with them.
 */
export const REVIEW_WORKFLOW_ENV = 'QWEN_REVIEW_WORKFLOW';

export function reviewWorkflowEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[REVIEW_WORKFLOW_ENV] === '1';
}

/**
 * What about this plan itself — independent of any environment — the generated
 * fan-out cannot serve. `null` when nothing does.
 *
 * Separate from the env gates because it has a second caller with a different
 * job: the roster builder is a pure function and must stay one, so it asserts
 * against this rather than re-deriving the same facts or reaching for
 * `process.env`. Both callers therefore agree on WHICH reviews are eligible by
 * construction, not by two lists kept in step.
 */
export function structuralBlocker(plan: RosterPlan): string | null {
  // 3B is not a bigger 3A. Its chunk agents carry a per-territory contract —
  // paging rules, the uncoverable rule, a `Covered:` receipt — and its
  // retirement ledger reads transcripts per chunk. Emitting a 3A-shaped
  // fan-out for one would launch the wrong agents over the right diff.
  if (isTerritoryFanOut(plan)) {
    return (
      'this plan is a territory fan-out (Step 3B), and the generated fan-out ' +
      'expresses the Step 3A roster only — a chunk agent carries a ' +
      'per-territory contract (paging, the uncoverable rule, a `Covered:` ' +
      'receipt) this script does not express.'
    );
  }

  // Every review agent is pinned to the PR worktree today (`working_dir` on
  // the Agent tool). A workflow dispatch has no equivalent, so the agents
  // would run in the user's main checkout and review whatever is there —
  // findings that look plausible and describe the wrong tree.
  if (reviewMode(plan) === 'pr-worktree') {
    return (
      'this review has a PR worktree, and a workflow dispatch cannot yet be ' +
      'pinned to it (`agent()` takes no working directory), so its agents ' +
      'would read the main checkout and describe the wrong tree.'
    );
  }

  return null;
}

/**
 * Decide how this review's Step 3 fan-out is dispatched.
 *
 * Ordered cheapest-and-most-global first, so the reason a run gives is the
 * one the reader can act on: an environment that cannot run workflows at all
 * is a more useful answer than "this particular plan is a territory fan-out".
 */
export function resolveOrchestration(
  plan: RosterPlan,
  env: NodeJS.ProcessEnv = process.env,
): OrchestrationVerdict {
  if (!workflowsEnabled(env)) {
    return {
      mode: 'legacy',
      reason:
        'workflows are not enabled in this environment, so nothing could run ' +
        'a generated fan-out. Set QWEN_CODE_ENABLE_WORKFLOWS=1 (and leave ' +
        'QWEN_CODE_DISABLE_WORKFLOWS unset) to opt in.',
    };
  }

  if (!reviewWorkflowEnabled(env)) {
    return {
      mode: 'legacy',
      reason:
        `the workflow fan-out is opt-in for /review while it is under A/B: ` +
        `set ${REVIEW_WORKFLOW_ENV}=1 to route Step 3 through it. This is ` +
        'the one-switch rollback, kept separate from the runtime gate on ' +
        'purpose.',
    };
  }

  const structural = structuralBlocker(plan);
  if (structural) {
    return { mode: 'legacy', reason: structural };
  }

  return {
    mode: 'workflow',
    reason:
      'workflows are enabled, this review is a Step 3A roster, and it needs ' +
      'no worktree pin.',
  };
}
