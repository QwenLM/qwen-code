/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// One property, asked of every host-side entrance at once: with a planted
// repository in place, NOTHING the pipeline runs on the host may execute out of
// it.
//
// The gates each entrance carries are asserted in their own suites; this file
// exists because those gates were added one call site at a time, and a class
// closed call site by call site is a class that re-opens at the next call site
// somebody adds. So the fixture here is the attack, not a shape: a coherent
// plant — a rewritten gitfile naming an admin entry whose own `commondir`
// names a planted repository carrying `filter.<x>.clean`, which git EXECUTES
// during an ordinary index refresh — plus a canary file the filter writes on
// the host. Every case asserts the canary is absent afterwards, and the first
// case asserts it is PRESENT when the same command runs ungated, so a fixture
// that quietly stops being an attack fails here rather than certifying the
// gates that walked around it.
//
// The backpointer is written the way git writes one — a BARE path in
// `<admin entry>/gitdir`, no `gitdir: ` prefix (that prefix belongs to the
// tree's own `.git` file, and git never writes it in the admin entry). A
// prefixed one fails the round-trip check every route runs first, which turns
// every assertion below into a green statement about the wrong refusal.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isolateHostGitConfig } from './lib/test-utils.js';
import {
  adminEntryInsideReviewTmp,
  mountRootFor,
  untrustedGitfile,
  untrustedRepositoryFrom,
  worktreeResidue,
} from './lib/worktree.js';
import { makeGitProbe } from './comment-status.js';
import { captureLocalDiff } from './lib/local-diff.js';
import { git, gitOpt, resetLaunchDirVerdictForTest } from './lib/git.js';
import { runBaseTree } from './base-tree.js';
import type { BuildTestReport } from './build-test.js';
import { baseWorktreePath } from './lib/paths.js';

// On Windows `mountRootFor` refuses every absolute path (a drive letter is a
// colon), so containment cannot exist there and the question this file asks has
// no answer — the same block-level gate every containment suite uses.
const itWhereContainmentExists = it.skipIf(process.platform === 'win32');

describe('a planted repository reaches no host-side execution', () => {
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  const made: string[] = [];
  const tmp = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    made.push(dir);
    return dir;
  };

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    resetLaunchDirVerdictForTest();
  });
  afterEach(() => {
    resetLaunchDirVerdictForTest();
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
    gitIsolation.dispose();
  });

  const g = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  /** A repository with one commit, and `.qwen/tmp` ready for its trees. */
  const repository = () => {
    const repo = tmp('qwen-canary-repo-');
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'config', 'user.email', 't@t.t');
    g(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    g(repo, 'add', 'a.ts');
    g(repo, 'commit', '-qm', 'init');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    return repo;
  };

  /**
   * A repository the reviewed code planted, carrying a filter git runs.
   *
   * `clean`, not `smudge`: the entrances this file is about are READS —
   * `git status` refreshing the index re-hashes a file whose stat no longer
   * matches, and re-hashing runs the clean filter. A checkout-only canary would
   * stay silent on exactly the routes that need a witness.
   */
  const plantedRepositoryAt = (dir: string, from: string, canary: string) => {
    cpSync(from, dir, { recursive: true });
    rmSync(join(dir, 'worktrees'), { recursive: true, force: true });
    appendFileSync(
      join(dir, 'config'),
      `\n[filter "evil"]\n\tclean = sh -c "echo PWNED > ${canary}; cat"\n\tsmudge = cat\n`,
    );
    mkdirSync(join(dir, 'info'), { recursive: true });
    writeFileSync(join(dir, 'info', 'attributes'), '* filter=evil\n');
    return dir;
  };

  /** The admin entry `<tree>/.git` is rewritten to point at. */
  const plantedAdminEntryAt = (
    entry: string,
    realEntry: string,
    tree: string,
    commonDir: string,
  ) => {
    cpSync(realEntry, entry, { recursive: true });
    writeFileSync(join(entry, 'commondir'), `${commonDir}\n`);
    // BARE, the way git writes a backpointer.
    writeFileSync(join(entry, 'gitdir'), `${join(tree, '.git')}\n`);
    rmSync(join(tree, '.git'), { force: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${entry}\n`);
    return entry;
  };

  /**
   * The single-layer geometry: a review worktree under `<repo>/.qwen/tmp`
   * whose gitfile the reviewed code rewrote, with the plant beside it.
   */
  const poisoned = () => {
    const repo = repository();
    const canaryDir = tmp('qwen-canary-out-');
    const canary = join(canaryDir, 'PWNED');
    const tree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    g(repo, 'worktree', 'add', '-q', '--detach', tree, 'HEAD');
    const headSha = g(tree, 'rev-parse', 'HEAD');
    const realEntry = join(repo, '.git', 'worktrees', 'review-pr-1');
    const common = plantedRepositoryAt(
      join(repo, '.qwen', 'tmp', '.evil-common'),
      join(repo, '.git'),
      canary,
    );
    const entry = plantedAdminEntryAt(
      join(repo, '.qwen', 'tmp', '.evil-git'),
      realEntry,
      tree,
      common,
    );
    // The index refresh only re-hashes a file whose stat changed, and only a
    // re-hash runs the clean filter. This is what a review's own build leaves
    // behind, so it is the ordinary state, not a contrivance.
    writeFileSync(join(tree, 'a.ts'), 'export const x = 2;\n');
    return { repo, tree, entry, canary, headSha };
  };

  itWhereContainmentExists(
    'the fixture is a live attack: ungated, the index refresh runs the plant',
    () => {
      // The negative control the rest of the file rests on. This is the exact
      // command `worktreeResidue` reaches once its identity gates pass —
      // pinned to the admin entry the gitfile names, `core.fsmonitor` already
      // emptied — so a green assertion below means a gate refused, not that
      // the plant was inert.
      const { tree, entry, canary } = poisoned();
      expect(existsSync(canary)).toBe(false);
      execFileSync(
        'git',
        [
          `--git-dir=${entry}`,
          `--work-tree=${tree}`,
          '-c',
          'core.fsmonitor=',
          'status',
          '--porcelain',
        ],
        { cwd: tree, encoding: 'utf8' },
      );
      expect(existsSync(canary)).toBe(true);
    },
  );

  itWhereContainmentExists(
    'the residue probe refuses to measure through it (scratch-tree, agent-prompt)',
    () => {
      // Entrance 1: `worktreeResidue` runs BEFORE the reuse/rebuild gates at
      // both of its call sites, so gating only the checkouts left the
      // measurement itself as the execution. Every identity check it carries
      // passes here — the plant writes both halves of the round trip, HEAD is
      // the copied entry's so the sha pin matches, and no symlink is involved.
      const { tree, canary, headSha } = poisoned();
      const residue = worktreeResidue(tree, 12, headSha);
      expect(existsSync(canary)).toBe(false);
      expect(residue.paths).toEqual([]);
      expect(residue.unmeasured).toContain('review temp dir');
    },
  );

  itWhereContainmentExists(
    'a launch directory that resolves into the plant is refused (fetch-pr)',
    () => {
      // Entrance 2: `cleanStale` and step 2's `git fetch` discover their
      // repository from `process.cwd()`, so a poisoned launch directory made
      // them run the plant's transport config long before the step-4 gate. The
      // same answer from a SUBDIRECTORY, which has no `.git` of its own — the
      // nested/dogfood shape a review actually launches from.
      const { tree, canary } = poisoned();
      expect(untrustedRepositoryFrom(tree, mountRootFor)).toContain(
        'review temp dir',
      );
      const sub = join(tree, 'packages', 'cli');
      mkdirSync(sub, { recursive: true });
      expect(untrustedRepositoryFrom(sub, mountRootFor)).toContain(
        'review temp dir',
      );
      expect(existsSync(canary)).toBe(false);
    },
  );

  itWhereContainmentExists(
    'the comment-status code probe degrades to unknown rather than reading it',
    () => {
      // Entrance 3: four ungated `git -C <review worktree>` probes. No
      // execution witness is claimed for `log`/`rev-parse` — what is at stake
      // is the answer: `changedSinceComment: false` sourced from a repository
      // the PR author planted is this command certifying that the code behind
      // a blocker thread did not move.
      const { tree, canary, headSha } = poisoned();
      const probe = makeGitProbe(tree);
      expect(probe('a.ts', headSha)).toEqual({
        changed: 'unknown',
        touchedBy: [],
        touchedByTotal: 0,
      });
      expect(existsSync(canary)).toBe(false);
    },
  );

  itWhereContainmentExists(
    'every wrapper in lib/git refuses to run from a poisoned launch directory',
    () => {
      // The launch-directory half, closed where all of it goes through rather
      // than at each command that happens to run git: `load-rules` reading this
      // review's own rules with `show <base>:<path>`, `submit` reading where a
      // submission goes, `match-remote` choosing the remote, `cleanup` pruning
      // — none of them knows it is asking this question, and none of them
      // should have to.
      const { tree, canary } = poisoned();
      const saved = process.cwd();
      try {
        process.chdir(tree);
        // The throwing wrapper throws...
        expect(() => git('rev-parse', 'HEAD')).toThrow(/review temp dir/);
        // ...and the probing wrapper answers its own "could not run" value,
        // which every caller already handles, rather than the plant's answer.
        expect(gitOpt('remote', 'get-url', 'origin')).toBeNull();
      } finally {
        process.chdir(saved);
      }
      expect(existsSync(canary)).toBe(false);
    },
  );

  itWhereContainmentExists(
    'the local-review capture refuses a poisoned launch directory (capture-local)',
    () => {
      // The local lane's copy of the fetch-pr entrance. `captureLocalDiff`
      // finds the repository from `process.cwd()` with `--show-toplevel`, and
      // the `git diff` that follows is not a safe read through a plant: it
      // refreshes the index (clean filters) and honours
      // `diff.<driver>.command`.
      const { tree, canary } = poisoned();
      const saved = process.cwd();
      try {
        process.chdir(tree);
        expect(() => captureLocalDiff({})).toThrow(/review temp dir/);
      } finally {
        process.chdir(saved);
      }
      expect(existsSync(canary)).toBe(false);
    },
  );

  itWhereContainmentExists(
    'the base-tree reuse fast path does not certify a planted tree (base-tree)',
    () => {
      // The entrance a census found rather than the review: the reuse branch
      // RETURNS before the gate that guards the rebuild, on two facts that both
      // live inside the mount — a marker file in the base tree, and
      // `rev-parse HEAD` resolved through that tree's own `.git`. Reused, the
      // A/B's BASE side is the reviewed code's own tree, and every "the base
      // behaves differently" verdict belongs to its author.
      const repo = repository();
      const canaryDir = tmp('qwen-canary-out-');
      const canary = join(canaryDir, 'PWNED');
      const worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
      g(repo, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
      const baseSha = g(worktree, 'rev-parse', 'HEAD');
      // The base tree the pipeline would build, standing and marked. Through
      // the real path helper, so the fixture cannot drift from the location
      // the command actually reuses.
      const tree = baseWorktreePath(worktree);
      g(repo, 'worktree', 'add', '-q', '--detach', tree, 'HEAD');
      writeFileSync(join(tree, '.qwen-review-base-ok'), `${baseSha}\n`);
      const common = plantedRepositoryAt(
        join(repo, '.qwen', 'tmp', '.evil-common'),
        join(repo, '.git'),
        canary,
      );
      plantedAdminEntryAt(
        join(repo, '.qwen', 'tmp', '.evil-git'),
        join(repo, '.git', 'worktrees', basename(tree)),
        tree,
        common,
      );
      const plan = join(repo, 'plan.json');
      writeFileSync(plan, `${JSON.stringify({ mergeBaseSha: baseSha })}\n`);

      const report = runBaseTree({
        plan,
        worktree,
        timeout: 60_000,
        install: false,
        // The build seam: reaching it at all means the tree was REBUILT, which
        // is the acceptable outcome here — what must not happen is the reuse
        // branch returning the planted tree as an already-built base.
        build: () =>
          ({
            ok: true,
            toolchain: 'npm',
            build: [],
            note: 'built',
          }) as unknown as BuildTestReport,
      });

      expect(JSON.stringify(report)).not.toContain('reusing it');
      expect(existsSync(canary)).toBe(false);
    },
  );

  itWhereContainmentExists(
    'an ancestor layer of the nested geometry is inside the writable surface too',
    () => {
      // Entrance 4: a review running inside another review's worktree nests one
      // `.qwen/tmp` inside another. The MOUNT is the innermost one — widening
      // it would pull `<repo>/.git` and every sibling checkout into the
      // container — but the OUTER review's containerized phase held the outer
      // temp dir read-write, so a plant one layer up is reachable and, judged
      // against the innermost root alone, was admitted by every gate.
      const repo = repository();
      const canaryDir = tmp('qwen-canary-out-');
      const canary = join(canaryDir, 'PWNED');
      const outer = join(repo, '.qwen', 'tmp', 'review-pr-1');
      g(repo, 'worktree', 'add', '-q', '--detach', outer, 'HEAD');
      const inner = join(outer, '.qwen', 'tmp', 'review-pr-2');
      mkdirSync(dirname(inner), { recursive: true });
      g(outer, 'worktree', 'add', '-q', '--detach', inner, 'HEAD');
      // git puts a linked worktree's admin entry under the MAIN repository's
      // `.git/worktrees/` even when `worktree add` runs from inside another
      // linked worktree — which is why widening the judgement costs the honest
      // layout nothing.
      const realEntry = join(repo, '.git', 'worktrees', 'review-pr-2');
      expect(existsSync(realEntry)).toBe(true);

      const innerRoot = mountRootFor(inner);
      expect(innerRoot).toBe(realpathSync(join(outer, '.qwen', 'tmp')));

      const common = plantedRepositoryAt(
        join(repo, '.qwen', 'tmp', '.evil-common'),
        join(repo, '.git'),
        canary,
      );
      // Planted in the OUTER temp dir: outside the inner root, inside the
      // outer review's read-write mount.
      const entry = plantedAdminEntryAt(
        join(repo, '.qwen', 'tmp', '.evil-git'),
        realEntry,
        inner,
        common,
      );
      expect(mountRootFor(entry)).toBe(
        realpathSync(join(repo, '.qwen', 'tmp')),
      );

      // The judgement, asked against the innermost root the mount was cut at:
      // it must still refuse, because the question is where reviewed code can
      // write, not where the bind mount starts.
      expect(adminEntryInsideReviewTmp(entry, () => innerRoot, inner)).toBe(
        true,
      );
      expect(untrustedGitfile(inner, mountRootFor)).toContain(
        'review temp dir',
      );
      writeFileSync(join(inner, 'a.ts'), 'export const x = 2;\n');
      expect(
        worktreeResidue(inner, 12, g(outer, 'rev-parse', 'HEAD')).unmeasured,
      ).toContain('review temp dir');
      expect(existsSync(canary)).toBe(false);
    },
  );

  itWhereContainmentExists(
    'and the honest nested layout still measures, resolves and probes',
    () => {
      // The admit arm, without which every assertion above is satisfied by a
      // gate that refuses everything — and the layout it admits is the
      // pipeline's own dogfood geometry, two layers deep.
      const repo = repository();
      const outer = join(repo, '.qwen', 'tmp', 'review-pr-1');
      g(repo, 'worktree', 'add', '-q', '--detach', outer, 'HEAD');
      const inner = join(outer, '.qwen', 'tmp', 'review-pr-2');
      mkdirSync(dirname(inner), { recursive: true });
      g(outer, 'worktree', 'add', '-q', '--detach', inner, 'HEAD');
      const headSha = g(inner, 'rev-parse', 'HEAD');

      expect(untrustedGitfile(inner, mountRootFor)).toBeNull();
      expect(untrustedRepositoryFrom(inner, mountRootFor)).toBeNull();
      writeFileSync(join(inner, '__probe__.test.ts'), 'probe\n');
      const residue = worktreeResidue(inner, 12, headSha);
      expect(residue.unmeasured).toBeUndefined();
      expect(residue.paths).toEqual(['__probe__.test.ts']);
      expect(makeGitProbe(inner)('a.ts', headSha).changed).not.toBe('unknown');
    },
  );

  itWhereContainmentExists(
    'the gitfile the pipeline itself writes is what the fixture rewrites',
    () => {
      // Coherence: if `git worktree add` ever stopped writing a gitfile, or the
      // admin entry moved, the plant above would be building a shape the
      // pipeline never produces and every refusal would be about nothing.
      const repo = repository();
      const tree = join(repo, '.qwen', 'tmp', 'review-pr-1');
      g(repo, 'worktree', 'add', '-q', '--detach', tree, 'HEAD');
      const real = join(repo, '.git', 'worktrees', 'review-pr-1');
      expect(readFileSync(join(tree, '.git'), 'utf8').trim()).toBe(
        `gitdir: ${real}`,
      );
      // And git's own backpointer is bare — the format the fixtures use.
      expect(readFileSync(join(real, 'gitdir'), 'utf8').trim()).toBe(
        join(tree, '.git'),
      );
    },
  );
});
