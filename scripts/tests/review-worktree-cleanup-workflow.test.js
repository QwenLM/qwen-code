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
  LEASE_PREFIX,
  REVIEW_TMP_DIR,
  reviewBranch,
  worktreePath,
} from '../../packages/cli/src/commands/review/lib/paths.js';

// The cleanup steps in ci.yml and qwen-code-pr-review.yml hard-code the
// review-artifact layout owned by paths.ts: worktreePath()/reviewBranch()
// and LEASE_PREFIX. Derive the expected patterns from that module so
// renaming the layout there fails the build here instead of silently
// no-op-ing the sweeps on the shared runners — a suffix rename already
// broke a sweeper once (see paths.ts).
// npm-cache.yml and qwen-triage.yml also run on the shared pool but are
// deliberately not covered here; extending the sweep to them is follow-up
// work.
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
// Every ci.yml job that checks out on the shared self-hosted pool inherits a
// possibly dirty workspace. Enumerate by pool + checkout instead of job name
// so the next such job fails here instead of on the runners.
const ciCleanSteps = Object.entries(ciYaml.jobs)
  .filter(
    ([, job]) =>
      JSON.stringify(job['runs-on'] ?? '').includes('ubuntu_runner') &&
      (job.steps ?? []).some((s) =>
        String(s.uses ?? '').includes('actions/checkout'),
      ),
  )
  .map(([id, job]) => ({
    id,
    run: job.steps.find((s) => s.name === 'Clean stale .qwen before checkout')
      ?.run,
  }));
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
  // Order assertions below cover the commands only: comments may name the
  // recipe pieces out of order when explaining them.
  const code = run
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const remove = code.indexOf('worktree remove --force');
  const firstPrune = code.indexOf('worktree prune');
  expect(firstPrune).toBeGreaterThan(-1);
  expect(firstPrune).toBeLessThan(remove);
  expect(code.indexOf('worktree prune', remove)).toBeGreaterThan(remove);
  expect(code.indexOf(`refs/heads/${branchFamily}*`)).toBeGreaterThan(remove);
}

function expectHardenedGit(run) {
  expect(run).toContain(
    'GIT_SAFE=(git -c core.hooksPath=/dev/null -c core.fsmonitor= -C "$GITHUB_WORKSPACE")',
  );
  expect(run).not.toMatch(
    /^\s+git(?:\s+-C\s+"\$GITHUB_WORKSPACE")?\s+(?:worktree|for-each-ref|branch)\b/m,
  );
}

const awkAvailable = spawnSync('awk', ['BEGIN { exit 0 }']).status === 0;

describe('review worktree cleanup steps', () => {
  it('keeps every shared-pool ci.yml checkout sweep pinned to paths.ts', () => {
    expect(ciCleanSteps.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'test',
        'web_shell_e2e_smoke',
        'integration_cli',
      ]),
    );
    for (const { id, run } of ciCleanSteps) {
      expect(
        run,
        `job "${id}" checks out on the shared pool and must clean stale .qwen state first`,
      ).toBeDefined();
      expectCleanupRecipe(run);
      expectHardenedGit(run);
    }
    // The copies are deliberate: a pre-checkout step cannot trust leftover
    // workspace scripts, so the recipe stays inline per job. Pin them
    // byte-identical so a fix to one sweep lands in all of them.
    const [firstCopy, ...otherCopies] = ciCleanSteps;
    for (const { id, run } of otherCopies) {
      expect(run, `job "${id}" sweep drifted from the first copy`).toBe(
        firstCopy.run,
      );
    }
  });

  it('keeps the review-job cleanup sweep pinned to paths.ts', () => {
    expectCleanupRecipe(reviewCleanStep);
    expectHardenedGit(reviewCleanStep);
    // Fallback for worktree directories Git no longer knows about.
    expect(reviewCleanStep).toContain(`rm -rf ${worktreePrefix}*`);
    // Leases are session+prompt scoped so a stale one is inert, but the glob
    // must stay in sync with LEASE_PREFIX or it silently never matches.
    expect(reviewCleanStep).toContain(
      `rm -f ${toPosix(REVIEW_TMP_DIR)}/${LEASE_PREFIX}pr-*.json`,
    );
  });

  it('keeps the pre-checkout agent-state sweep pinned to paths.ts', () => {
    // Directories are rm -rf'd first there, so no `worktree remove` to pin.
    expect(agentStateCleanStep).toContain(`rm -rf ${worktreePrefix}*`);
    expect(agentStateCleanStep).toContain(`refs/heads/${branchFamily}*`);
    expectHardenedGit(agentStateCleanStep);
  });

  it('uses one identical worktree filter at every list-driven sweep', () => {
    const filter = reviewCleanStep.match(/awk '([^']+)'/)?.[1];
    expect(filter).toBeTruthy();
    for (const { id, run } of ciCleanSteps) {
      expect(run, id).toContain(`awk '${filter}'`);
    }
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
