/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveOrchestration,
  structuralBlocker,
  reviewWorkflowEnabled,
  workflowsEnabled,
  REVIEW_WORKFLOW_ENV,
} from './orchestration.js';
import type { RosterPlan } from './roster.js';

/** A small local review: no PR, no worktree, under both Step 3A thresholds. */
function localPlan(over: Record<string, unknown> = {}): RosterPlan {
  return {
    diffLines: 240,
    srcDiffLines: 180,
    files: [{ path: 'src/a.ts', kind: 'source', removedLines: 4 }],
    chunks: [{ id: 1, startLine: 1, endLine: 240 }],
    ...over,
  } as unknown as RosterPlan;
}

/** Both gates open — the only state in which a review may take the new path. */
const ON = {
  QWEN_CODE_ENABLE_WORKFLOWS: '1',
  [REVIEW_WORKFLOW_ENV]: '1',
};

describe('resolveOrchestration — the gates', () => {
  it('routes an eligible review to the workflow path when both gates are open', () => {
    expect(resolveOrchestration(localPlan(), ON).mode).toBe('workflow');
  });

  it('defaults to legacy: an unset environment changes no review', () => {
    const verdict = resolveOrchestration(localPlan(), {});
    expect(verdict.mode).toBe('legacy');
    expect(verdict.reason).toMatch(/workflows are not enabled/);
  });

  // The two switches answer different questions. Folding them would opt a
  // project's reviews in as a side effect of enabling workflows for anything
  // else, and rolling reviews back would take the runtime down with them.
  it('keeps the /review gate independent of the runtime gate', () => {
    const runtimeOnly = resolveOrchestration(localPlan(), {
      QWEN_CODE_ENABLE_WORKFLOWS: '1',
    });
    expect(runtimeOnly.mode).toBe('legacy');
    expect(runtimeOnly.reason).toContain(REVIEW_WORKFLOW_ENV);

    // And the /review gate cannot force a runtime that is off.
    const reviewOnly = resolveOrchestration(localPlan(), {
      [REVIEW_WORKFLOW_ENV]: '1',
    });
    expect(reviewOnly.mode).toBe('legacy');
    expect(reviewOnly.reason).toMatch(/workflows are not enabled/);
  });

  // The kill switch is the one-flip revert for an incident; it must win over
  // every opt-in, including a deliberate one.
  it('honours the runtime kill switch over both opt-ins', () => {
    expect(
      resolveOrchestration(localPlan(), {
        ...ON,
        QWEN_CODE_DISABLE_WORKFLOWS: '1',
      }).mode,
    ).toBe('legacy');
  });

  // The reason a run gives should be the one its reader can act on: "you have
  // not enabled workflows" beats "this plan is a territory fan-out" when both
  // are true, because the first is what stands between them and any workflow.
  it('reports the most global blocker first', () => {
    const verdict = resolveOrchestration(
      localPlan({ srcDiffLines: 2000, diffLines: 6000 }),
      {},
    );
    expect(verdict.reason).toMatch(/workflows are not enabled/);
  });

  // The same ordering, one rung down the ladder: with the runtime on but
  // /review not opted in, a territory diff must still hear about the switch it
  // can flip. Naming the fan-out first would send the reader off to split a
  // diff that was never what stood in their way. This pins the gate order
  // itself -- `structuralBlocker` runs LAST -- which the blocked-plan test
  // above cannot see, because it has both gates open.
  it('reports the /review gate before a structural blocker', () => {
    const verdict = resolveOrchestration(
      localPlan({ srcDiffLines: 2000, diffLines: 6000 }),
      { QWEN_CODE_ENABLE_WORKFLOWS: '1' },
    );
    expect(verdict.mode).toBe('legacy');
    expect(verdict.reason).toContain(REVIEW_WORKFLOW_ENV);
    expect(verdict.reason).not.toMatch(/territory fan-out \(Step 3B\)/);
  });

  // The gates opening must not demote a plan the script cannot express: the
  // routing verdict and the roster builder both read `structuralBlocker`, so
  // an ineligible plan falls back to the hand-launched roster instead of
  // reaching the builder's own refusal as a hard error.
  it('routes a structurally blocked plan to legacy even with both gates open', () => {
    const territory = resolveOrchestration(
      localPlan({ srcDiffLines: 2000, diffLines: 6000 }),
      ON,
    );
    expect(territory.mode).toBe('legacy');
    expect(territory.reason).toMatch(/territory fan-out \(Step 3B\)/);
  });

  // The flagship case: every same-repo PR review has a worktree. It is NOT a
  // structural blocker — the runtime takes `agent({workingDir})` and the
  // generated script passes it — so the gates opening must actually route it.
  it('routes a PR-worktree review to the workflow path, pin and all', () => {
    const worktree = resolveOrchestration(
      localPlan({ worktreePath: '.qwen/tmp/review-pr-42', prNumber: 42 }),
      ON,
    );
    expect(worktree.mode).toBe('workflow');
    // The pin travels with the generated script; the retired claim that the
    // path needs none must not survive in the verdict.
    expect(worktree.reason).not.toMatch(/no worktree pin/);
  });
});

describe('structuralBlocker — what a plan itself forecloses', () => {
  it('passes a plain Step 3A review', () => {
    expect(structuralBlocker(localPlan())).toBeNull();
  });

  // A 3B roster grows one agent per chunk, and a workflow returns all of them
  // through ONE tool result under the scheduler's output budget — so the loss
  // grows with the diff. The reason must name that delivery bound, not an
  // expressibility claim about the roster, which this PR's own builder
  // disproves: `buildFanOutRoster` serializes chunk agents like any other.
  it('blocks a territory fan-out, naming the delivery bound', () => {
    const reason = structuralBlocker(
      localPlan({ srcDiffLines: 2000, diffLines: 6000 }),
    );
    expect(reason).toMatch(/territory fan-out \(Step 3B\)/);
    expect(reason).toMatch(/one tool result/);
    // The claim the runtime disproves must not come back: the roster IS
    // expressible, and saying otherwise sends a maintainer looking for a
    // script limitation that does not exist.
    expect(reason).not.toMatch(/does not express|expresses the Step 3A roster/);
  });

  // `agent({workingDir})` exists — `KNOWN_AGENT_OPTS` carries it, the
  // orchestrator rebinds the subagent cwd through `worktree-pin.ts`, and the
  // generated script passes it. A worktree is therefore not a structural
  // blocker, and must not be reported as one.
  it('passes a PR-worktree review — the pin the script passes is real', () => {
    expect(
      structuralBlocker(
        localPlan({ worktreePath: '.qwen/tmp/review-pr-42', prNumber: 42 }),
      ),
    ).toBeNull();
  });

  // Structural means structural: this half must not consult the environment,
  // so the roster builder that asserts against it stays a pure function.
  it('is independent of the environment', () => {
    // A plan that IS blocked, so the assertion discriminates: a vacuous
    // `null === null` would hold even if this function started reading env.
    const plan = localPlan({ srcDiffLines: 2000, diffLines: 6000 });
    const before = structuralBlocker(plan);
    expect(before).not.toBeNull();
    process.env[REVIEW_WORKFLOW_ENV] = '1';
    try {
      expect(structuralBlocker(plan)).toBe(before);
    } finally {
      delete process.env[REVIEW_WORKFLOW_ENV];
    }
  });
});

describe('the env predicates', () => {
  it('workflowsEnabled: opt-in, with the kill switch winning', () => {
    expect(workflowsEnabled({})).toBe(false);
    expect(workflowsEnabled({ QWEN_CODE_ENABLE_WORKFLOWS: '1' })).toBe(true);
    expect(
      workflowsEnabled({
        QWEN_CODE_ENABLE_WORKFLOWS: '1',
        QWEN_CODE_DISABLE_WORKFLOWS: '1',
      }),
    ).toBe(false);
  });

  it('reviewWorkflowEnabled: exactly "1", not any truthy string', () => {
    expect(reviewWorkflowEnabled({})).toBe(false);
    expect(reviewWorkflowEnabled({ [REVIEW_WORKFLOW_ENV]: '1' })).toBe(true);
    expect(reviewWorkflowEnabled({ [REVIEW_WORKFLOW_ENV]: 'true' })).toBe(
      false,
    );
    expect(reviewWorkflowEnabled({ [REVIEW_WORKFLOW_ENV]: '0' })).toBe(false);
  });
});
