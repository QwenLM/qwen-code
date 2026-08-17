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
});

describe('structuralBlocker — what a plan itself forecloses', () => {
  it('passes a plain Step 3A review', () => {
    expect(structuralBlocker(localPlan())).toBeNull();
  });

  // A 3B chunk agent carries a per-territory contract the generated script
  // does not express, so emitting a 3A-shaped fan-out for one would launch
  // the wrong agents over the right diff and look complete doing it.
  it('blocks a territory fan-out', () => {
    const reason = structuralBlocker(
      localPlan({ srcDiffLines: 2000, diffLines: 6000 }),
    );
    expect(reason).toMatch(/territory fan-out \(Step 3B\)/);
  });

  // Until `agent()` can be pinned to a directory, a dispatched agent reads the
  // user's main checkout — findings that look plausible and describe the wrong
  // tree.
  it('blocks a PR-worktree review, naming the missing capability', () => {
    const reason = structuralBlocker(
      localPlan({ worktreePath: '.qwen/tmp/review-pr-42', prNumber: 42 }),
    );
    expect(reason).toMatch(/takes no working directory/);
  });

  // Structural means structural: this half must not consult the environment,
  // so the roster builder that asserts against it stays a pure function.
  it('is independent of the environment', () => {
    const plan = localPlan({ worktreePath: '.qwen/tmp/review-pr-42' });
    const before = structuralBlocker(plan);
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
