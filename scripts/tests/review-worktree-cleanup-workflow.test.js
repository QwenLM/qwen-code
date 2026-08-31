/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// possibly dirty workspace. Match the pool itself, not just the output
// reference that usually names it: jobs can also hard-code the shared label
// array, and a checkout on either form inherits the same leftovers.
// Enumerate by pool + checkout instead of job name so the next such job
// fails here instead of on the runners.
const ciCleanSteps = Object.entries(ciYaml.jobs)
  .filter(
    ([, job]) =>
      /ubuntu_runner|ecs-qwen/.test(JSON.stringify(job['runs-on'] ?? '')) &&
      (job.steps ?? []).some((s) =>
        String(s.uses ?? '').includes('actions/checkout'),
      ),
  )
  .map(([id, job]) => ({
    id,
    steps: job.steps,
    run: job.steps.find((s) => s.name === 'Clean stale .qwen before checkout')
      ?.run,
  }));
const reviewYaml = parse(
  readFileSync('.github/workflows/qwen-code-pr-review.yml', 'utf8'),
);
const reviewCleanSteps = reviewYaml.jobs['review-pr'].steps;
const reviewCleanIndex = reviewCleanSteps.findIndex(
  (s) => s.name === 'Clean review worktrees',
);
const reviewCleanStep = reviewCleanSteps[reviewCleanIndex].run;
const agentStateCleanStep = reviewCleanSteps.find(
  (s) => s.name === 'Clean stale agent state',
).run;
const reviewPreCheckoutSweepIndex = reviewCleanSteps.findIndex(
  (s) => s.name === 'Clean stale .qwen before checkout',
);
const reviewPreCheckoutSweepStep =
  reviewCleanSteps[reviewPreCheckoutSweepIndex]?.run;
const reviewCheckoutIndex = reviewCleanSteps.findIndex(
  (s) => s.name === 'Checkout base branch',
);
// Both copies are directly executable (the review copy ends at `done`;
// the ci.yml copy's trailing artifact sweep skips workspaces without a
// .git), and every fixture below that executes a sweep copy — the
// plain-delete, symlink, and quarantine-fallback paths alike — loops over
// BOTH of them against its own workspace: a mutant that survives the
// substring pins — e.g. a `continue` right after the for-loop head
// silently no-op-ing one copy, or a dropped `mkdir -p "$quarantine"`
// defeating one copy's move-out fallback — must fail behaviorally on the
// copy it touches (mutation-probed).
const executableCleanCopies = [
  { id: 'ci.yml', run: ciCleanSteps[0].run },
  { id: 'qwen-code-pr-review.yml', run: reviewPreCheckoutSweepStep },
];
// The step's owner-extraction awk is not a worktree filter: anchor on the
// filter's shape, not the first awk in the step. Derive it once here so the
// pinning test and the behavioral test always execute the same filter.
const worktreeFilter = reviewCleanStep.match(
  /awk '(\$1 == "worktree"[^']+)'/,
)?.[1];

// Comments may name the recipe pieces out of order when explaining them, so
// the order and isolation assertions below cover the commands only.
const stripComments = (run) =>
  run
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

// The steps run under `bash -e` + pipefail, and a failing for-each-ref or
// worktree-list head is exactly the corrupt-leftover state they exist to
// tolerate: every piped sweep loop must degrade to a warning via its
// trailing `|| true`, never fail the job.
function expectPipedLoopsIsolated(code, minLoops) {
  const loops =
    code.match(/\|\s*while read -r \w+; do[\s\S]*?\n\s*done(?: \|\| true)?/g) ??
    [];
  expect(loops.length).toBeGreaterThanOrEqual(minLoops);
  for (const loop of loops) {
    expect(loop.endsWith('done || true')).toBe(true);
  }
}

// prune (sync registrations) -> force-remove -> prune (drop now-stale
// entries) -> delete branches: a branch checked out in a live worktree
// cannot be deleted, so worktree removal must precede the branch sweep.
function expectCleanupRecipe(run) {
  expect(run).toContain(`index($0, "/${worktreePrefix}")`);
  expect(run).toContain('worktree remove --force');
  expect(run).toContain(`refs/heads/${branchFamily}*`);
  // The awk filter matches registered paths by substring, but those paths
  // come from leftover git metadata and are untrusted: the removal loop
  // must reject `..` traversal and re-anchor to the review prefix first.
  expect(run).toContain('skipping suspicious review worktree path');
  expect(run).toContain(`"$GITHUB_WORKSPACE/${worktreePrefix}"*) : ;;`);
  const code = stripComments(run);
  const remove = code.indexOf('worktree remove --force');
  const firstPrune = code.indexOf('worktree prune');
  expect(firstPrune).toBeGreaterThan(-1);
  expect(firstPrune).toBeLessThan(remove);
  expect(code.indexOf('worktree prune', remove)).toBeGreaterThan(remove);
  expect(code.indexOf(`refs/heads/${branchFamily}*`)).toBeGreaterThan(remove);
  expectPipedLoopsIsolated(code, 2);
}

// Deleting the tree is not always possible: a containerised job on this
// shared pool can leave residue owned by another uid, and on a pool member
// without passwordless sudo nothing unprivileged can unlink it. Leaving it
// in place poisons the checkout of every LATER job scheduled here, so the
// sweep must move it out of the workspace instead of warning and continuing
// — renaming needs write permission only on the two parents, and the
// workspace root is always the runner's own.
function expectQuarantineFallback(run) {
  const code = stripComments(run);
  expect(code).toContain('_qwen-quarantine');
  // A cancelled verify can leave the protected tree under the recovery name
  // seen in run 33146730771, so both known top-level names must be swept.
  // `.qwen.root-orig` is emitted by recovery tooling OUTSIDE this repo —
  // nothing here produces it (git grep matches only the sweep copies and
  // these pins), so the pins keep the copies honest, not the producer: if
  // its naming changes or a third residue name appears on the pool, update
  // the for-loop list in ci.yml and qwen-code-pr-review.yml, or the sweep
  // silently no-ops and the checkout poisoning recurs.
  expect(code).toContain(
    'for stale_qwen in "$GITHUB_WORKSPACE/.qwen" "$GITHUB_WORKSPACE/.qwen.root-orig" "$GITHUB_WORKSPACE/trusted-ci-classifier"; do',
  );
  // The existence guard's `-L` arm is the only thing that sees a dangling
  // symlink (`-e` follows the link and reports it absent), and the chmod
  // guard's `! -L` arm is what keeps `chmod -R u+w` from dereferencing a
  // symlinked leftover into a tree outside the workspace. The behavioral
  // fixtures below execute both copies where permission fixtures are
  // available (skipped on the Windows/root lanes): the dangling-symlink
  // fixture witnesses the existence guard's `-L` arm behaviorally on each
  // copy, but the chmod guard's `! -L` arm has no behavioral witness (the
  // live-symlink fixture asserts content, not mode), so pin both arms
  // textually here on every copy — dropping `-L` fails the dangling-symlink
  // fixture, while dropping `! -L` keeps this suite green and re-poisons
  // the checkout (mutation-probed).
  expect(code).toContain('[ ! -e "$stale_qwen" ] && [ ! -L "$stale_qwen" ]');
  expect(code).toContain('[ -d "$stale_qwen" ] && [ ! -L "$stale_qwen" ]');
  // The move must be the fallback of the removal chain, not an
  // unconditional relocation: a workspace that deletes cleanly keeps its
  // caches.
  expect(code).toMatch(
    /rm -rf -- "\$stale_qwen"[\s\S]*?sudo -n rm -rf -- "\$stale_qwen"[\s\S]*?mv -- "\$stale_qwen"/,
  );
  expect(code).toMatch(
    /mv -- "\$stale_qwen"[\s\S]*?mv -- "\$GITHUB_WORKSPACE"/,
  );
  expect(code).toContain('mkdir -p "$GITHUB_WORKSPACE"');
  expect(code).toContain('cd "$GITHUB_WORKSPACE"');
  // Same filesystem by construction — a cross-device `mv` degrades to
  // copy-then-unlink, which fails on exactly the residue this exists for.
  expect(code).toContain(
    '"$(dirname -- "$GITHUB_WORKSPACE")/_qwen-quarantine"',
  );
  // The quarantined tree still needs a human: the warning must name where
  // it went, and the terminal warning must survive for the case where even
  // the rename fails.
  expect(code).toContain(
    'leaked $stale_name survived every recovery; runner needs manual cleanup',
  );
}

function expectHardenedGit(run) {
  expect(run).toContain(
    'GIT_SAFE=(git -c core.hooksPath=/dev/null -c core.fsmonitor= -C "$GITHUB_WORKSPACE")',
  );
  // Any column, any verb: the review-workflow copies are unindented after
  // YAML block-scalar stripping, and a bare `git` call would run un-hardened
  // against leftover untrusted .git config.
  expect(run).not.toMatch(/^\s*git\s/m);
}

const awkAvailable = spawnSync('awk', ['BEGIN { exit 0 }']).status === 0;

// Substring/order pins cannot see parse or runtime behavior: a dropped
// closing quote fails `bash -n` on the whole `if: always()` step, and a
// dropped `]` in the existence check turns the ladder into a silent no-op —
// both mutants survive every pin above (mutation-probed). Execute the
// extracted function against fixture workspaces to catch that class.
const removeTreeFnStart = reviewCleanStep.indexOf('remove_review_tree() {');
const removeReviewTreeFn = reviewCleanStep.slice(
  removeTreeFnStart,
  reviewCleanStep.indexOf('\n}\n', removeTreeFnStart) + 2,
);
const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;
// The pre-checkout sweep's ladder is individually guarded: every rung ends
// in `|| true` with stderr swallowed, so on a Git-Bash-only PATH without
// coreutils the whole sweep exits 0 while leaving `.qwen` on disk — the
// behavioral fixture asserting removal must skip there instead of failing.
const sweepToolsAvailable =
  bashAvailable &&
  spawnSync(
    'bash',
    [
      '-c',
      'command -v rm >/dev/null && command -v chmod >/dev/null && command -v mv >/dev/null',
    ],
    { stdio: 'ignore' },
  ).status === 0;
// The fixtures defeat rm with a chmod-555 parent, which needs POSIX
// permission semantics: Git Bash on Windows resolves `bash` but not chmod,
// and root ignores the bits entirely.
const permissionFixturesAvailable =
  bashAvailable && process.platform !== 'win32' && process.geteuid?.() !== 0;
// The ladder's failure path resolves the leftover with `realpath --`; on a
// host without it (the merge_group macOS lane ships none) the function
// refuses as `path could not be resolved` instead, so the test asserting
// the removal-failure warning gates on it separately — the plain-leftover
// fixture returns before resolution, and the symlink fixture's refusal
// branch fires before the resolved value is consumed.
const realpathAvailable =
  spawnSync('realpath', ['--', '/'], { stdio: 'ignore' }).status === 0;
const runRemoveReviewTree = (workspace, ...args) =>
  spawnSync(
    'bash',
    [
      '-c',
      // Mirror the runner's flags: Actions runs the step under errexit, and
      // the step's own `set -uo pipefail` first line does not turn it back
      // off — an unguarded failing command inside the function must fail
      // these tests exactly as it fails the `if: always()` step.
      `set -euo pipefail\n${removeReviewTreeFn}\nremove_review_tree "$@"`,
      'remove_review_tree',
      ...args,
    ],
    { env: { ...process.env, GITHUB_WORKSPACE: workspace }, encoding: 'utf8' },
  );

// The skip-warning fixture executes the whole step body with `git`
// stubbed to a function whose `worktree list --porcelain` returns
// hostile registrations: the echoes under test sit in the loop, not in
// git, and the stub keeps the fixture free of real worktree state.
const runReviewCleanStep = (workspace, hostileRegistrations) =>
  spawnSync(
    'bash',
    [
      '-c',
      [
        'set -euo pipefail',
        'git() {',
        '  case " $* " in',
        '    *" worktree list "*) printf \'%s\\n\' "$HOSTILE_REGISTRATIONS" ;;',
        '  esac',
        '}',
        reviewCleanStep,
      ].join('\n'),
      'clean-review-worktrees',
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        HOSTILE_REGISTRATIONS: hostileRegistrations
          .map((path) => `worktree ${path}`)
          .join('\n'),
      },
      encoding: 'utf8',
    },
  );

// existsSync follows the link: a dangling leftover reports as absent while
// the link itself still survives, so link presence is asserted via lstat.
const linkExists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

describe('review worktree cleanup steps', () => {
  it('keeps every shared-pool ci.yml checkout sweep pinned to paths.ts', () => {
    expect(ciCleanSteps.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'test',
        'web_shell_e2e_smoke',
        'integration_cli',
      ]),
    );
    for (const { id, steps, run } of ciCleanSteps) {
      expect(
        run,
        `job "${id}" checks out on the shared pool and must clean stale .qwen state first`,
      ).toBeDefined();
      // Position is load-bearing: the sweep must run after the ownership
      // restore (git refuses root-owned leftovers) and before checkout
      // (after checkout it no-ops on the fresh tree).
      const cleanIdx = steps.findIndex(
        (s) => s.name === 'Clean stale .qwen before checkout',
      );
      const checkoutIdx = steps.findIndex((s) =>
        String(s.uses ?? '').includes('actions/checkout'),
      );
      const restoreIdx = steps.findIndex(
        (s) => s.name === 'Restore workspace ownership',
      );
      expect(cleanIdx, id).toBeGreaterThan(restoreIdx);
      expect(cleanIdx, id).toBeLessThan(checkoutIdx);
      expectCleanupRecipe(run);
      expectHardenedGit(run);
      expectQuarantineFallback(run);
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

  it.skipIf(!sweepToolsAvailable)(
    'removes both known qwen state names without touching .qwenignore',
    () => {
      for (const { id, run } of executableCleanCopies) {
        const root = mkdtempSync(join(tmpdir(), 'qwen-ci-cleanup-'));
        const workspace = join(root, 'workspace');
        mkdirSync(join(workspace, '.qwen', 'agents'), { recursive: true });
        mkdirSync(join(workspace, '.qwen.root-orig', 'agents'), {
          recursive: true,
        });
        writeFileSync(join(workspace, '.qwenignore'), 'keep\n');

        try {
          const result = spawnSync('bash', ['-c', run], {
            cwd: workspace,
            env: { ...process.env, GITHUB_WORKSPACE: workspace },
            encoding: 'utf8',
          });

          expect(result.status, `${id}: ${result.stderr}`).toBe(0);
          expect(existsSync(join(workspace, '.qwen')), id).toBe(false);
          expect(existsSync(join(workspace, '.qwen.root-orig')), id).toBe(
            false,
          );
          expect(existsSync(join(workspace, '.qwenignore')), id).toBe(true);
          // Deleted, not moved: a workspace that removes cleanly must not
          // leave a quarantine directory behind on either copy.
          expect(existsSync(join(root, '_qwen-quarantine')), id).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!sweepToolsAvailable)(
    'removes a leftover trusted-ci-classifier before the classifier checkout',
    () => {
      // actions/checkout reuses a leftover directory whose origin URL
      // matches and runs git — hooks included — inside it, so a residue of
      // an earlier classifier checkout on the shared pool is a code-
      // execution hole, not a warm cache. Both shared-pool workflows sweep
      // the name (the review job inherits the same residue on the same
      // pool), and the byte-identity pin above already forces every ci.yml
      // copy to match the one exercised here.
      for (const { id, run } of executableCleanCopies) {
        const root = mkdtempSync(join(tmpdir(), 'qwen-ci-cleanup-'));
        const workspace = join(root, 'workspace');
        mkdirSync(join(workspace, 'trusted-ci-classifier', '.git', 'hooks'), {
          recursive: true,
        });
        writeFileSync(
          join(
            workspace,
            'trusted-ci-classifier',
            '.git',
            'hooks',
            'post-checkout',
          ),
          '#!/bin/sh\n',
        );

        try {
          const result = spawnSync('bash', ['-c', run], {
            cwd: workspace,
            env: { ...process.env, GITHUB_WORKSPACE: workspace },
            encoding: 'utf8',
          });

          expect(result.status, `${id}: ${result.stderr}`).toBe(0);
          expect(existsSync(join(workspace, 'trusted-ci-classifier')), id).toBe(
            false,
          );
          expect(existsSync(join(root, '_qwen-quarantine')), id).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it('sweeps both known qwen state names before the review checkout', () => {
    expect(reviewPreCheckoutSweepStep).toBeDefined();
    expect(reviewPreCheckoutSweepIndex).toBeGreaterThan(
      reviewCleanSteps.findIndex(
        (s) => s.name === 'Restore workspace ownership',
      ),
    );
    expect(reviewPreCheckoutSweepIndex).toBeLessThan(reviewCheckoutIndex);
    expectQuarantineFallback(reviewPreCheckoutSweepStep);
  });

  it.skipIf(!permissionFixturesAvailable)(
    'pre-checkout sweeps unlink a dangling-symlink .qwen via the -L existence arm',
    () => {
      for (const { id, run } of executableCleanCopies) {
        const root = mkdtempSync(join(tmpdir(), 'qwen-ci-cleanup-'));
        const workspace = join(root, 'workspace');
        mkdirSync(workspace, { recursive: true });
        const link = join(workspace, '.qwen');
        try {
          symlinkSync(join(root, 'missing-target'), link);
          // -e follows the link, so a dangling leftover reports as absent:
          // only the -L arm of the existence guard keeps the sweep from
          // skipping it and leaving checkout to trip on the very residue the
          // sweep exists to clear.
          const result = spawnSync('bash', ['-c', run], {
            cwd: workspace,
            env: { ...process.env, GITHUB_WORKSPACE: workspace },
            encoding: 'utf8',
          });

          expect(result.status, `${id}: ${result.stderr}`).toBe(0);
          expect(linkExists(link), id).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable)(
    'pre-checkout sweeps unlink a live-symlink .qwen without touching its target',
    () => {
      for (const { id, run } of executableCleanCopies) {
        const root = mkdtempSync(join(tmpdir(), 'qwen-ci-cleanup-'));
        const workspace = join(root, 'workspace');
        const target = join(root, 'outside-target');
        const marker = join(target, 'marker.txt');
        mkdirSync(workspace, { recursive: true });
        mkdirSync(target, { recursive: true });
        writeFileSync(marker, 'keep\n');
        const link = join(workspace, '.qwen');
        try {
          symlinkSync(target, link);
          const result = spawnSync('bash', ['-c', run], {
            cwd: workspace,
            env: { ...process.env, GITHUB_WORKSPACE: workspace },
            encoding: 'utf8',
          });

          expect(result.status, `${id}: ${result.stderr}`).toBe(0);
          expect(linkExists(link), id).toBe(false);
          expect(readFileSync(marker, 'utf8'), id).toBe('keep\n');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it('keeps the review-job cleanup sweep pinned to paths.ts', () => {
    // `always()` and the end-of-job position are what make the step fire on
    // the failure/cancellation paths it exists for: Actions' default
    // success() condition would skip it once any earlier step fails.
    expect(reviewCleanSteps[reviewCleanIndex].if).toBe('always()');
    expect(reviewCleanIndex).toBe(reviewCleanSteps.length - 1);
    expectCleanupRecipe(reviewCleanStep);
    expectHardenedGit(reviewCleanStep);
    // Fallback for worktree directories Git no longer knows about.
    expect(reviewCleanStep).toContain(`rm -rf ${worktreePrefix}*`);
    // The leftover loop's glob is the only call site that feeds surviving
    // permission-poisoned trees into the ladder: a rename here matches
    // nothing, and every pin and fixture stays green while the sweep
    // silently skips the trees it exists to heal.
    expect(reviewCleanStep).toContain(`for leftover in ${worktreePrefix}*; do`);
    // Leases are session+prompt scoped so a stale one is inert, but the glob
    // must stay in sync with LEASE_PREFIX or it silently never matches.
    expect(reviewCleanStep).toContain(
      `rm -f ${toPosix(REVIEW_TMP_DIR)}/${LEASE_PREFIX}pr-*.json`,
    );
    // A failed rm must not be left to poison the next job's checkout: the
    // sweep owns its own permission repair — chmod, then passwordless sudo
    // chown/chmod where the pool member has it — and retries the removal per
    // leftover entry (measured, run 32577821716 / PR #9718: a foreign-owned
    // scratch-verify tree killed the next review at checkout with EACCES).
    // Pin the ladder's EFFECT, not mechanism substrings: those double-match
    // (the non-sudo chmod rung hides inside the sudo line) and let a
    // rewrite silently drop the ladder back to warn-and-leave.
    const reviewCleanCode = stripComments(reviewCleanStep);
    // Three removal attempts: the initial rm plus one retry after EACH
    // repair rung, so a chmod-repaired tree never escalates to sudo.
    expect(reviewCleanCode.match(/rm -rf "\$abs"/g)).toHaveLength(3);
    // The first rm must run BEFORE the refusal guard: a guard-first rewrite
    // refuses a symlinked leftover that the plain rm would simply have
    // unlinked (measured: one spurious refusal, documented behavior gone).
    const guardPos = reviewCleanCode.indexOf('if [ -n "$reason" ]');
    expect(reviewCleanCode.indexOf('rm -rf "$abs"')).toBeLessThan(guardPos);
    // The non-sudo rung must exist as its own command, not just inside the
    // sudo line, with its errexit guard intact: the leftover loop calls the
    // function bare under the runner's -e, so an unguarded failing rung
    // would kill the `if: always()` step mid-ladder.
    expect(reviewCleanCode).toMatch(
      /^\s*chmod -R u\+rwX "\$abs" 2>\/dev\/null \|\| true$/m,
    );
    // The rung's retry rm must sit directly under it: hoisting the sudo
    // block between the two escalates every chmod-repaired tree to sudo,
    // breaking the never-escalates ordering the rm count pins above.
    expect(reviewCleanCode).toMatch(
      /^\s*chmod -R u\+rwX "\$abs"[^\n]*\n\s*rm -rf "\$abs"/m,
    );
    // Both sudo rungs pinned in full: dropping the chmod leg or chowning to
    // root leaves a foreign-owned tree owned-but-locked, so the retry rm
    // still fails and the leftover survives the ladder built to heal it.
    expect(reviewCleanCode).toContain(
      'sudo -n chown -R "$(id -u):$(id -g)" "$abs" 2>/dev/null || true',
    );
    expect(reviewCleanCode).toContain(
      'sudo -n chmod -R u+rwX "$abs" 2>/dev/null || true',
    );
    expect(reviewCleanCode).toContain('remove_review_tree "$leftover"');
    // The symlink-refusal guard must survive, including the direction of
    // its comparison and the deciding reason it now carries.
    expect(reviewCleanCode).toContain(
      'refusing to repair review worktree path (${reason})',
    );
    expect(reviewCleanCode).toContain('!= "$ws_real/$rel"');
    // The realpath fallbacks keep the assignments errexit-safe: a leftover
    // realpath cannot resolve (a symlink loop, or a dangling link with
    // missing target ancestry, under a locked parent) must warn and
    // continue, not die at the assignment and skip the trailing sweeps.
    expect(reviewCleanCode).toContain(
      'abs_real="$(realpath -- "$abs" 2>/dev/null)" || abs_real=\'\'',
    );
    expect(reviewCleanCode).toMatch(
      /ws_real="\$\(realpath -- "\$GITHUB_WORKSPACE" 2>\/dev\/null\)" \|\|\n\s*ws_real="\$GITHUB_WORKSPACE"/,
    );
    // Order and derivation are load-bearing too, not just presence
    // (mutation-probed): with the refusal guard below the rungs, a rewrite
    // chmod/chowns through a planted link before the check runs; with the
    // sudo block above the chmod rung, a chmod-repaired tree escalates to
    // sudo anyway; with rel blanked, every leftover refuses as "outside the
    // workspace" and the incident this PR exists for recurs.
    const chmodPos = reviewCleanCode.indexOf('chmod -R u+rwX "$abs"');
    const sudoPos = reviewCleanCode.indexOf('sudo -n chown -R');
    expect(guardPos).toBeGreaterThan(-1);
    expect(guardPos).toBeLessThan(chmodPos);
    expect(guardPos).toBeLessThan(sudoPos);
    expect(chmodPos).toBeLessThan(sudoPos);
    expect(reviewCleanCode).toContain('rel="${abs#"$GITHUB_WORKSPACE/"}"');
    // Leftover names are untrusted glob entries: every direct expansion in
    // both warnings must strip CR as well as LF — the runner splits step
    // stdout on bare CR too — and the owner enrichment must read only ls's
    // first line, or a newline-bearing name's later lines are emitted
    // standalone and a `::` among them parses as a workflow command.
    const warningLines = removeReviewTreeFn
      .split('\n')
      .filter((line) => line.includes('::warning::'));
    expect(warningLines).toHaveLength(2);
    for (const line of warningLines) {
      // Command substitutions pass the path as an argument, never to the
      // log line; only direct interpolations reach stdout.
      const direct = line.replace(/\$\([^()]*\)/g, '');
      expect(direct).not.toMatch(/\$\{abs[^/]|\$abs\b/);
    }
    expect(
      reviewCleanCode.match(/\$\{abs\/\/\[\$'\\r\\n'\]\/ \}/g),
    ).toHaveLength(2);
    // The registered-worktree loop's two skip warnings reach the same
    // stdout with an untrusted registered path, so the identical strip
    // protects them: a bare `$worktree` there injects a standalone
    // workflow-command line on the runner's stdout (executed by the
    // CR-bearing-registration fixture below).
    const skipWarningLines = reviewCleanCode
      .split('\n')
      .filter(
        (line) =>
          line.includes('skipping suspicious review worktree') ||
          line.includes('skipping unexpected review worktree'),
      );
    expect(skipWarningLines).toHaveLength(2);
    for (const line of skipWarningLines) {
      expect(line).not.toMatch(/\$worktree\b/);
    }
    expect(
      reviewCleanCode.match(/\$\{worktree\/\/\[\$'\\r\\n'\]\/ \}/g),
    ).toHaveLength(2);
    expect(reviewCleanCode).toContain("awk 'NR==1 {print $3}'");
    // The failure warning carries the deciding state (sudo probe + owner),
    // and the function returns 0 unconditionally: even a failed warning
    // echo must not fail the `if: always()` job via errexit.
    expect(reviewCleanCode).toMatch(
      /could not remove review worktree[^\n]*sudo: \$sudo_probe[^\n]*owner:/,
    );
    expect(reviewCleanCode).toMatch(
      /could not remove review worktree[^\n]*\n\s*return 0/,
    );
    // The probe must keep all three sudo states apart: the incident this
    // ladder exists for was a runner WITH sudo and no NOPASSWD entry, and
    // "absent" sends the on-call to install a package instead of writing a
    // sudoers rule. The 'ok' assignment is pinned for the mirror case:
    // without it a working passwordless sudo reports as password-gated and
    // sends the on-call to add a sudoers rule that already exists.
    expect(reviewCleanCode).toContain("local sudo_probe='password-gated'");
    expect(reviewCleanCode).toContain(
      "command -v sudo >/dev/null 2>&1 || sudo_probe='absent'",
    );
    // The ok/password-gated split lives in the `sudo -n true` predicate:
    // dropping it reports `sudo: ok` on exactly the NOPASSWD-less runners
    // this ladder exists for, and mis-triages the on-call.
    expect(reviewCleanCode).toContain(
      'command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null',
    );
    expect(reviewCleanCode).toContain("sudo_probe='ok'");
  });

  it('keeps the pre-checkout agent-state sweep pinned to paths.ts', () => {
    // Directories are rm -rf'd first there, so no `worktree remove` to pin.
    expect(agentStateCleanStep).toContain(`rm -rf ${worktreePrefix}*`);
    expect(agentStateCleanStep).toContain(`refs/heads/${branchFamily}*`);
    expectHardenedGit(agentStateCleanStep);
    expectPipedLoopsIsolated(stripComments(agentStateCleanStep), 1);
  });

  it('uses one identical worktree filter at every list-driven sweep', () => {
    expect(worktreeFilter).toBeTruthy();
    for (const { id, run } of ciCleanSteps) {
      expect(run, id).toContain(`awk '${worktreeFilter}'`);
    }
  });

  it.skipIf(!awkAvailable)(
    'filter selects review worktrees only, never the main checkout',
    () => {
      const main = '/home/runner/work/qwen-code/qwen-code';
      const review = `${main}/.qwen/tmp/review-pr-42`;
      const out = spawnSync('awk', [worktreeFilter], {
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

  it.skipIf(!sweepToolsAvailable || process.platform === 'win32')(
    'the pre-checkout sweep quarantines the workspace when the residue itself cannot move',
    () => {
      for (const { id, run } of executableCleanCopies) {
        const root = mkdtempSync(join(tmpdir(), 'ci-quarantine-'));
        const workspace = join(root, 'repo', 'repo');
        const residue = join(workspace, '.qwen.root-orig');
        const marker = join(workspace, 'warm-cache-marker');
        try {
          mkdirSync(residue, { recursive: true });
          writeFileSync(join(residue, 'review-context.json'), '{}\n');
          writeFileSync(marker, 'warm\n');
          const out = spawnSync(
            'bash',
            [
              '-c',
              // Model the incident runner: delete/permission repair fail and
              // the foreign-owned residue cannot cross to another parent,
              // while the runner-owned workspace itself still can.
              `set -euo pipefail\nrm() { return 1; }\nchmod() { return 1; }\nsudo() { return 1; }\nmv() {\n  if [ "$2" = "$GITHUB_WORKSPACE/.qwen.root-orig" ]; then return 1; fi\n  command mv "$@"\n}\n${run}\nprintf '::cwd::%s\\n' "$PWD"`,
              'clean-stale-qwen',
            ],
            {
              cwd: workspace,
              env: { ...process.env, GITHUB_WORKSPACE: workspace },
              encoding: 'utf8',
            },
          );
          expect(out.status, `${id}: ${out.stderr}`).toBe(0);
          const quarantine = join(root, 'repo', '_qwen-quarantine');
          expect(existsSync(quarantine), id).toBe(true);
          expect(readdirSync(quarantine), id).toHaveLength(1);
          const movedWorkspace = join(quarantine, readdirSync(quarantine)[0]);
          expect(
            readFileSync(join(movedWorkspace, 'warm-cache-marker'), 'utf8'),
            id,
          ).toBe('warm\n');
          expect(
            readFileSync(
              join(movedWorkspace, '.qwen.root-orig/review-context.json'),
              'utf8',
            ),
            id,
          ).toBe('{}\n');
          expect(readdirSync(workspace), id).toEqual([]);
          expect(out.stdout, id).toContain(`::cwd::${workspace}`);
          const warnings = out.stdout
            .split('\n')
            .filter((line) => line.startsWith('::warning::'));
          expect(warnings, id).toHaveLength(1);
          expect(warnings[0], id).toContain('moved the whole workspace');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable)(
    'the pre-checkout sweep still deletes residue it can remove',
    () => {
      for (const { id, run } of executableCleanCopies) {
        // The fallback must stay a fallback: a workspace that deletes
        // cleanly keeps its caches instead of accumulating quarantined
        // copies.
        const root = mkdtempSync(join(tmpdir(), 'ci-quarantine-'));
        const workspace = join(root, 'repo', 'repo');
        try {
          mkdirSync(
            join(workspace, `${toPosix(REVIEW_TMP_DIR)}/review-pr-77`),
            { recursive: true },
          );
          const out = spawnSync('bash', ['-c', run], {
            cwd: workspace,
            env: { ...process.env, GITHUB_WORKSPACE: workspace },
            encoding: 'utf8',
          });
          expect(out.status, `${id}: ${out.stderr}`).toBe(0);
          expect(existsSync(join(workspace, '.qwen')), id).toBe(false);
          expect(existsSync(join(root, 'repo', '_qwen-quarantine')), id).toBe(
            false,
          );
          expect(out.stdout, id).not.toContain('::warning::');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable)(
    'remove_review_tree actually removes a plain leftover',
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'review-tree-fixture-'));
      try {
        const leftover = join(fixture, '.qwen/tmp/review-pr-101');
        mkdirSync(leftover, { recursive: true });
        writeFileSync(join(leftover, 'leftover.txt'), 'x');
        // Relative input: the leftover loop's glob entries are relative.
        const out = runRemoveReviewTree(fixture, '.qwen/tmp/review-pr-101');
        expect(out.status).toBe(0);
        expect(out.stdout).toBe('');
        expect(existsSync(leftover)).toBe(false);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable)(
    'remove_review_tree refuses a symlinked leftover without touching its target',
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'review-tree-fixture-'));
      try {
        const target = join(fixture, 'target');
        mkdirSync(target);
        writeFileSync(join(target, 'keep.txt'), 'x');
        const leftoverDir = join(fixture, '.qwen/tmp');
        mkdirSync(leftoverDir, { recursive: true });
        const link = join(leftoverDir, 'review-pr-102');
        symlinkSync(target, link);
        // Make rm fail so the ladder reaches the refusal branch: with a
        // writable parent the first rung unlinks the link itself, which is
        // correct but never exercises the guard.
        chmodSync(leftoverDir, 0o555);
        const out = runRemoveReviewTree(fixture, link);
        expect(out.status).toBe(0);
        const warnings = out.stdout
          .split('\n')
          .filter((line) => line.startsWith('::warning::'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(
          'refusing to repair review worktree path (path is a symlink)',
        );
        expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('x');
      } finally {
        chmodSync(join(fixture, '.qwen/tmp'), 0o755);
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable || !realpathAvailable)(
    'remove_review_tree keeps a newline-bearing leftover name on one warning line',
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'review-tree-fixture-'));
      try {
        const leftoverDir = join(fixture, '.qwen/tmp');
        mkdirSync(leftoverDir, { recursive: true });
        const hostile = join(leftoverDir, 'review-pr-\n::error::injected');
        mkdirSync(hostile);
        chmodSync(leftoverDir, 0o555);
        const out = runRemoveReviewTree(fixture, hostile);
        expect(out.status).toBe(0);
        expect(existsSync(hostile)).toBe(true);
        // The runner parses every stdout line as a possible workflow
        // command: the stripped name must stay inside the single warning
        // line, never surface `::error::` on its own line.
        const lines = out.stdout.split(/\r?\n/).filter((line) => line);
        expect(lines).toHaveLength(1);
        expect(
          lines[0].startsWith('::warning::could not remove review worktree'),
        ).toBe(true);
      } finally {
        chmodSync(join(fixture, '.qwen/tmp'), 0o755);
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable)(
    'remove_review_tree unlinks a symlinked leftover over a writable parent',
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'review-tree-fixture-'));
      try {
        const target = join(fixture, 'target');
        mkdirSync(target);
        writeFileSync(join(target, 'keep.txt'), 'x');
        const leftoverDir = join(fixture, '.qwen/tmp');
        mkdirSync(leftoverDir, { recursive: true });
        const link = join(leftoverDir, 'review-pr-103');
        symlinkSync(target, link);
        // The parent stays writable, so the first rm must unlink the link
        // before the guard runs: deadening that rm routes the leftover to
        // the symlink refusal instead, warning and leaving it behind.
        const out = runRemoveReviewTree(fixture, link);
        expect(out.status).toBe(0);
        expect(out.stdout).toBe('');
        expect(linkExists(link)).toBe(false);
        expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('x');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable)(
    'remove_review_tree removes a dangling symlink via the -L existence arm',
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'review-tree-fixture-'));
      try {
        const leftoverDir = join(fixture, '.qwen/tmp');
        mkdirSync(leftoverDir, { recursive: true });
        const link = join(leftoverDir, 'review-pr-104');
        symlinkSync(join(fixture, 'missing-target'), link);
        // -e follows the link and is false here: only the -L arm keeps the
        // remove-or-named-warning contract for dangling links.
        const out = runRemoveReviewTree(fixture, link);
        expect(out.status).toBe(0);
        expect(out.stdout).toBe('');
        expect(linkExists(link)).toBe(false);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable)(
    'remove_review_tree refuses a path outside the workspace',
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'review-tree-fixture-'));
      const outside = mkdtempSync(join(tmpdir(), 'review-tree-outside-'));
      const leftover = join(outside, 'review-pr-105');
      try {
        mkdirSync(leftover);
        writeFileSync(join(leftover, 'keep.txt'), 'x');
        // Lock the tree AND its parent: rm may run before the guard and
        // unlinks anything it can, so both locks are needed to observe the
        // refusal leaving a foreign tree completely untouched.
        chmodSync(leftover, 0o555);
        chmodSync(outside, 0o555);
        const out = runRemoveReviewTree(fixture, leftover);
        expect(out.status).toBe(0);
        const warnings = out.stdout
          .split('\n')
          .filter((line) => line.startsWith('::warning::'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(
          'refusing to repair review worktree path (outside the workspace)',
        );
        expect(existsSync(join(leftover, 'keep.txt'))).toBe(true);
      } finally {
        chmodSync(outside, 0o755);
        chmodSync(leftover, 0o755);
        rmSync(fixture, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!permissionFixturesAvailable || !realpathAvailable)(
    'remove_review_tree repairs a permission-locked tree and then removes it',
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'review-tree-fixture-'));
      const leftover = join(fixture, '.qwen/tmp/review-pr-106');
      try {
        mkdirSync(leftover, { recursive: true });
        writeFileSync(join(leftover, 'locked.txt'), 'x');
        // Lock the tree itself, not the parent: the rungs repair $abs only,
        // so the chmod-555-parent fixtures never reach the repair-success
        // path this exercises — first rm fails, chmod rung heals, retry rm
        // removes.
        chmodSync(leftover, 0o555);
        const out = runRemoveReviewTree(fixture, '.qwen/tmp/review-pr-106');
        expect(out.status).toBe(0);
        expect(out.stdout).toBe('');
        expect(existsSync(leftover)).toBe(false);
      } finally {
        if (existsSync(leftover)) chmodSync(leftover, 0o755);
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(!bashAvailable || !awkAvailable)(
    'skip warnings keep a CR-bearing registered path on one runner line',
    () => {
      const fixture = mkdtempSync(join(tmpdir(), 'review-skip-echo-fixture-'));
      try {
        // The step exits early without a checkout.
        mkdirSync(join(fixture, '.git'));
        const hostile = [
          // `..` routes to the suspicious-skip echo; the other two fail
          // the workspace prefix check and route to the unexpected-skip
          // echo.
          `${fixture}/.qwen/tmp/review-pr-1/../pwn\r::stop-commands::pwned`,
          `/elsewhere/.qwen/tmp/review-pr-2\r::endgroup::`,
          `/elsewhere/.qwen/tmp/review-pr-3\r::notice::forged/git`,
        ];
        const out = runReviewCleanStep(fixture, hostile);
        expect(out.status).toBe(0);
        // The runner splits step stdout on bare CR as well as LF and
        // parses every line for workflow commands: the stripped path must
        // stay inside its warning line, never surface a standalone `::`
        // line.
        const lines = out.stdout.split(/[\r\n]/).filter((line) => line);
        expect(
          lines.filter((line) => line.startsWith('::warning::skipping')),
        ).toHaveLength(3);
        expect(
          lines.filter(
            (line) => line.startsWith('::') && !line.startsWith('::warning::'),
          ),
        ).toEqual([]);
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
