/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  reviewBranch,
  worktreePath,
} from '../../packages/cli/src/commands/review/lib/paths.js';

// The cleanup steps in ci.yml and qwen-code-pr-review.yml hard-code the
// review-artifact layout owned by worktreePath()/reviewBranch() in paths.ts.
// Derive the expected patterns from that module so renaming the layout there
// fails the build here instead of silently no-op-ing the sweeps on the shared
// runners — a suffix rename already broke a sweeper once (see paths.ts).
const probePr = 12345;
const toPosix = (value) => value.replace(/\\/g, '/');
const worktreePrefix = toPosix(worktreePath(probePr)).slice(
  0,
  -`${probePr}`.length,
);
const branchFamily = toPosix(reviewBranch(probePr)).slice(
  0,
  -`pr-${probePr}`.length,
);

const ciYaml = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const ciCleanStep = ciYaml.jobs.test.steps.find(
  (s) => s.name === 'Clean stale .qwen before checkout',
).run;
const integrationCleanStep = ciYaml.jobs.integration_cli.steps.find(
  (s) => s.name === 'Clean stale .qwen before checkout',
).run;
const reviewYaml = parse(
  readFileSync('.github/workflows/qwen-code-pr-review.yml', 'utf8'),
);
const reviewCleanStep = reviewYaml.jobs['review-pr'].steps.find(
  (s) => s.name === 'Clean review worktrees',
).run;
const agentStateCleanStep = reviewYaml.jobs['review-pr'].steps.find(
  (s) => s.name === 'Clean stale agent state',
).run;

// prune (sync registrations) -> force-remove -> prune (drop now-stale
// entries) -> delete branches: a branch checked out in a live worktree
// cannot be deleted, so worktree removal must precede the branch sweep.
function expectCleanupRecipe(run) {
  expect(run).toContain(`index($0, "/${worktreePrefix}")`);
  expect(run).toContain('worktree remove --force');
  expect(run).toContain(`refs/heads/${branchFamily}*`);
  const remove = run.indexOf('worktree remove --force');
  const firstPrune = run.indexOf('worktree prune');
  expect(firstPrune).toBeGreaterThan(-1);
  expect(firstPrune).toBeLessThan(remove);
  expect(run.indexOf('worktree prune', remove)).toBeGreaterThan(remove);
  expect(run.indexOf(`refs/heads/${branchFamily}*`)).toBeGreaterThan(remove);
}

const awkAvailable = spawnSync('awk', ['BEGIN { exit 0 }']).status === 0;

describe('review worktree cleanup steps', () => {
  it('keeps the ci.yml test-job sweep pinned to paths.ts', () => {
    expectCleanupRecipe(ciCleanStep);
  });

  it('keeps the ci.yml integration_cli sweep pinned to paths.ts', () => {
    expectCleanupRecipe(integrationCleanStep);
  });

  it('keeps the review-job cleanup sweep pinned to paths.ts', () => {
    expectCleanupRecipe(reviewCleanStep);
    // Fallback for worktree directories Git no longer knows about.
    expect(reviewCleanStep).toContain(`rm -rf ${worktreePrefix}*`);
  });

  it('keeps the pre-checkout agent-state sweep pinned to paths.ts', () => {
    // Directories are rm -rf'd first there, so no `worktree remove` to pin.
    expect(agentStateCleanStep).toContain(`rm -rf ${worktreePrefix}*`);
    expect(agentStateCleanStep).toContain(`refs/heads/${branchFamily}*`);
  });

  it('uses one identical worktree filter at every list-driven sweep', () => {
    const filter = reviewCleanStep.match(/awk '([^']+)'/)?.[1];
    expect(filter).toBeTruthy();
    expect(ciCleanStep).toContain(`awk '${filter}'`);
    expect(integrationCleanStep).toContain(`awk '${filter}'`);
  });

  it.skipIf(!awkAvailable)(
    'filter selects review worktrees only, never the main checkout',
    () => {
      const filter = reviewCleanStep.match(/awk '([^']+)'/)?.[1];
      const main = '/home/runner/work/qwen-code/qwen-code';
      const review = `${main}/.qwen/tmp/review-pr-42`;
      const out = spawnSync('awk', [filter], {
        input: [
          `worktree ${main}`,
          `worktree ${review}`,
          'branch qwen-review/pr-42',
          '',
        ].join('\n'),
        encoding: 'utf8',
      });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe(review);
    },
  );
});
