/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Against a REAL git repo, because the part that breaks is the worktree
// lifecycle — a detached add at a specific SHA, a stale sibling from a crashed
// run, a path that must sit beside the review worktree rather than inside it.
// None of that is exercised by mocking `spawnSync`, and all of it is what makes
// the command fail on a real review.
//
// The build is the seam. It is the slow half and it has its own suite; what
// matters here is that a base tree only counts as `available` when the build
// actually succeeded, since an A/B against a half-built tree measures the build,
// not the diff.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  utimesSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBaseTree, type BaseTreeReport } from './base-tree.js';
import { baseWorktreePath } from './lib/paths.js';
import { baseTreeTrustPath, runNonce } from './lib/base-tree-trust.js';
import { adminEntryOf, plantAdminEntry } from './lib/test-utils.js';
import { runEpochMs } from './lib/prompt-record.js';
import type { BuildTestReport } from './build-test.js';

const okBuild = {
  ok: true,
  toolchain: 'npm',
  build: [{ command: 'npm run build', exitCode: 0 }],
  note: 'built',
} as unknown as BuildTestReport;
const failedBuild = {
  ok: false,
  note: 'TS2307',
  build: [{ command: 'npm run build', exitCode: 2 }],
} as unknown as BuildTestReport;

// Skipped on win32 for the same reason as the sibling suites: `mountRootFor`
// refuses every absolute Windows path (a drive letter is a colon), so
// containment is unavailable there by design and this gate never speaks. The
// assertion would fail for that reason and nothing else — first inside the
// merge queue, where that lane actually runs.
const itWhereContainmentExists = it.skipIf(process.platform === 'win32');

describe('runBaseTree', () => {
  let repo: string;
  let worktree: string;
  let baseSha: string;
  let headSha: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const writePlan = (over: Record<string, unknown> = {}): string => {
    const p = join(repo, 'plan.json');
    writeFileSync(
      p,
      JSON.stringify({ mergeBaseSha: baseSha, files: [], ...over }),
    );
    return p;
  };

  // Captured ONCE per test, the way `fetch-pr` captures it once per run: the
  // reuse marker is fenced on the plan's epoch, so a helper that re-captured on
  // every call would simulate a new run each time and the fast path — the
  // concurrent-shard guard the reuse test below pins — could never speak.
  let planPath = '';
  const run = (
    over: { plan?: Record<string, unknown>; worktree?: string } = {},
    build: (w: string) => BuildTestReport = () => okBuild,
  ): BaseTreeReport => {
    const { plan: planOver, ...rest } = over;
    if (planOver !== undefined || !planPath) planPath = writePlan(planOver);
    return runBaseTree({
      plan: planPath,
      worktree,
      timeout: 60,
      install: false,
      build,
      ...rest,
    });
  };

  beforeEach(() => {
    planPath = '';
    repo = mkdtempSync(join(tmpdir(), 'qwen-base-tree-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'before\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    baseSha = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), 'after\n');
    git(repo, 'commit', '-qam', 'head');
    headSha = git(repo, 'rev-parse', 'HEAD');
    // The review worktree the base tree is created beside.
    worktree = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    git(repo, 'worktree', 'add', '--detach', '-q', worktree, headSha);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  itWhereContainmentExists(
    'reports BUSY and leaves the tree standing when a tree THIS RUN built fails a reuse check (tracked dirt)',
    () => {
      // `rev-parse HEAD` does not move when working files change, and this tree
      // is a direct child of the directory the sandbox mounts read-write — but
      // tracked dirt on a tree THIS run stamped is not necessarily a rewrite by
      // the reviewed code: a build can modify tracked files (codegen, lockfile
      // rewrites), and a concurrent shard's A/B writes one (a snapshot
      // `--update`). Discarding on that signal sweeps a live tree another shard
      // may be mid-A/B in — the concurrent-shard clobber the fast path exists
      // to prevent — so the fence declines, the way the build lock's EEXIST arm
      // does, and the dirtied tree stands for the shard that is using it.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // One tracked file rewritten, the plan untouched: same run, genuine stamp.
      writeFileSync(join(tree, 'a.txt'), 'after\n');

      const second = run({}, build);
      expect(second.available).toBe(false);
      expect(second.note).toContain('no longer passes a reuse check');
      expect(second.note).not.toContain('reusing it');
      expect(builds).toEqual([tree]); // declined — no sweep, no rebuild
      // The dirtied file is still on disk: discarding it is what was refused.
      expect(readFileSync(join(tree, 'a.txt'), 'utf8')).toBe('after\n');
    },
  );

  itWhereContainmentExists(
    "does not REUSE when an untracked path appears that THIS RUN's build did not leave",
    () => {
      // The epoch fence excludes only trees a DIFFERENT run built: reviewed
      // code holding the read-write mount can drop an untracked executable
      // into a tree this run stamped, after the stamp — and
      // `--untracked-files=no` cannot see it, while refusing all untracked
      // files would disable every legitimate reuse (the pipeline's own build
      // leaves `node_modules/` and `dist/` here). So the set the build left is
      // recorded host-side at marker write, and anything beyond it is a
      // plant: content, not concurrency, so the rebuild's discard sweeps it.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      // Same run: the plan — and with it the run's identity — is untouched.
      mkdirSync(join(tree, 'dist'), { recursive: true });
      writeFileSync(
        join(tree, 'dist', 'cli.js'),
        'planted by the reviewed build',
      );

      const second = run({}, build);
      expect(second.note).not.toContain('reusing it');
      expect(builds).toEqual([tree, tree]); // the rebuild fired again
      // The plant went with the tree it was standing in.
      expect(existsSync(join(tree, 'dist', 'cli.js'))).toBe(false);
      expect(second.available).toBe(true);
    },
  );

  itWhereContainmentExists(
    'refuses a stamp forged from the mount-visible epoch formula (production geometry)',
    () => {
      // The plan lives at `.qwen/tmp/qwen-review-pr-<n>-fetch.json`, INSIDE
      // the directory the sandbox mounts read-write, so reviewed code can
      // stat it and compute the epoch the stamp used to carry — then rewrite
      // the marker and overwrite an executable beside the build's own
      // residue, where the untracked-set fence cannot tell it from what the
      // build left. The stamp now carries a run secret that never enters the
      // mount: the forge below produces exactly what the old fence compared
      // against, and it matches nothing.
      const tree = baseWorktreePath(worktree);
      planPath = join(repo, '.qwen', 'tmp', 'qwen-review-pr-1-fetch.json');
      writeFileSync(
        planPath,
        JSON.stringify({ mergeBaseSha: baseSha, files: [] }),
      );
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        if (builds.length === 1) {
          // The residue a real build leaves, recorded host-side as legitimate.
          mkdirSync(join(w, 'dist'), { recursive: true });
          writeFileSync(join(w, 'dist', 'cli.js'), 'built by round 1');
        }
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);

      // The reviewed code's move: plant over the executable the A/B will run,
      // and refresh the stamp to the epoch formula the mount exposes.
      writeFileSync(
        join(tree, 'dist', 'cli.js'),
        'planted by the reviewed code',
      );
      writeFileSync(
        join(tree, '.qwen-review-base-ok'),
        `${baseSha}\n${runEpochMs(planPath)}\n`,
      );

      const second = run({}, build);
      expect(second.note).not.toContain('reusing it');
      expect(builds).toEqual([tree, tree]); // rebuilt, not reused
      // The plant went with the tree it was standing in.
      expect(existsSync(join(tree, 'dist', 'cli.js'))).toBe(false);
    },
  );

  it('does not settle on a planted FAILED marker that carries no run secret', () => {
    // The failed-marker fast path settles the question with NO build at all —
    // "infrastructure, never a finding against the PR" — and the file lives
    // inside the mount, so a sha-only marker is one planted line away from
    // suppressing the A/B lane for the whole round, reading as infrastructure
    // rather than as an attack. Only a marker stamped with this run's secret
    // settles it.
    const tree = baseWorktreePath(worktree);
    git(repo, 'worktree', 'add', '--detach', '-q', tree, baseSha);
    writeFileSync(join(tree, '.qwen-review-base-failed'), `${baseSha}\n`);

    const builds: string[] = [];
    const r = run({}, (w) => {
      builds.push(w);
      return okBuild;
    });
    expect(r.note).not.toContain('already failed');
    expect(builds).toEqual([tree]); // the rebuild was attempted
    expect(r.available).toBe(true);
  });

  itWhereContainmentExists(
    'does not REUSE a base tree an EARLIER RUN built, whose untracked plants the dirt check cannot see',
    () => {
      // `cleanStale` releases the review worktree and its branch but never
      // `-base`, so this tree stands into the next round with a whole
      // containerized build/test phase in between — and inside the mount the
      // reviewed code writes where it likes. What it can drop there is
      // untracked executable content, `dist/cli.js` and `node_modules/.bin/`
      // being exactly what a host-side A/B measurement runs, and
      // `--untracked-files=no` cannot see it: a blanket untracked refusal
      // would disable every correctly-built tree's reuse and bring back the
      // concurrent-shard clobber the fast path exists to prevent. So the
      // marker carries the run that built it, and a stamp from another run is
      // not a tree this run may certify.
      const tree = baseWorktreePath(worktree);
      const builds: string[] = [];
      const build = (w: string) => {
        builds.push(w);
        return okBuild;
      };
      expect(run({}, build).available).toBe(true);
      mkdirSync(join(tree, 'dist'), { recursive: true });
      writeFileSync(
        join(tree, 'dist', 'cli.js'),
        'planted by the reviewed build',
      );

      // The next run captures its own plan, and the plan's mtime IS the epoch.
      const later = new Date(Date.now() + 60_000);
      utimesSync(planPath, later, later);

      const second = run({}, build);
      expect(second.note).not.toContain('reusing it');
      expect(builds).toEqual([tree, tree]);
      // The plant went with the tree it was standing in.
      expect(existsSync(join(tree, 'dist', 'cli.js'))).toBe(false);
    },
  );

  itWhereContainmentExists(
    'refuses to build through a rewritten review-worktree gitfile',
    () => {
      // `worktree add` resolves the repository through the REVIEW worktree's own
      // gitfile, which lives in the directory the sandbox mounts read-write and
      // which the build/test phase already ran the PR's code against. It checks
      // files out, so it runs whatever that pointer leads to, on the host.
      plantAdminEntry(
        join(repo, '.qwen', 'tmp', '.evil-git'),
        adminEntryOf(worktree),
        worktree,
        join(repo, '.git'),
      );

      const r = run();
      expect(r.available).toBe(false);
      expect(JSON.stringify(r)).toContain('review temp dir');
      // The tree was never created, which is what says the spawn never ran —
      // the note alone reads the same whichever side of it the gate fires on.
      expect(existsSync(baseWorktreePath(worktree))).toBe(false);
    },
  );

  it('creates a sibling worktree holding the BASE commit, not the head', () => {
    const r = run();
    expect(r.available).toBe(true);
    expect(r.path).toBe(baseWorktreePath(worktree));
    expect(r.baseSha).toBe(baseSha);
    // The whole point: this tree is the code as it stood before the PR.
    expect(git(r.path!, 'rev-parse', 'HEAD')).toBe(baseSha);
    expect(existsSync(join(r.path!, 'a.txt'))).toBe(true);
  });

  it('places the base tree BESIDE the review worktree, never inside it', () => {
    // Nested, it would land in the PR's own diff and be swept with it.
    const r = run();
    expect(r.path!.startsWith(`${worktree}/`)).toBe(false);
    expect(r.path).toBe(`${worktree}-base`);
  });

  it('builds in the base tree, and only there', () => {
    const seen: string[] = [];
    const r = run({}, (w) => {
      seen.push(w);
      return okBuild;
    });
    expect(seen).toEqual([baseWorktreePath(worktree)]);
    expect(r.build).toBe(okBuild);
  });

  it('REUSES an already-built base tree instead of sweeping it (concurrent shards)', () => {
    // Reviewed live on this PR: N verifier shards run in parallel and all
    // resolve the same path; without the fast path, shard B's opening sweep
    // destroys the tree shard A is mid-A/B in, and A's base side reads as
    // empty output — a fabricated difference with a deterministic source tag.
    const builds: string[] = [];
    const build = (w: string) => {
      builds.push(w);
      return okBuild;
    };
    const first = run({}, build);
    expect(first.available).toBe(true);
    const second = run({}, build);
    expect(second.available).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.note).toContain('reusing');
    expect(builds).toHaveLength(1); // one install+build, not two
    // A marker for a DIFFERENT sha (rebase between runs) does not shortcut —
    // stamped with this run's secret, so the sha arm is what answers and not
    // the run fence standing in front of it.
    writeFileSync(
      join(first.path!, '.qwen-review-base-ok'),
      `${'f'.repeat(40)}\n${runNonce(baseTreeTrustPath(worktree, planPath))}\n`,
    );
    expect(run({}, build).note).not.toContain('reusing');
  });

  it('returns BUSY instead of sweeping while another probe holds the build lock', () => {
    // Reviewed live: shard B's opening sweep deleted the tree shard A was
    // mid-`npm ci` in, and whichever finished stamped the marker for a tree
    // the other was still mutating.
    mkdirSync(`${baseWorktreePath(worktree)}.lock`, { recursive: true });
    const builds: string[] = [];
    const r = run({}, (w) => {
      builds.push(w);
      return okBuild;
    });
    expect(r.available).toBe(false);
    expect(r.note).toContain('another probe is building');
    expect(builds).toEqual([]); // no sweep, no build under the lock holder
    rmSync(`${baseWorktreePath(worktree)}.lock`, {
      recursive: true,
      force: true,
    });
  });

  it('sweeps a STALE lock instead of reporting busy for the whole review', () => {
    // A builder killed without its finally leaves the lock forever; 30+ min
    // old is a corpse, not a live install+build.
    const lock = `${baseWorktreePath(worktree)}.lock`;
    mkdirSync(lock, { recursive: true });
    const old = Date.now() / 1000 - 45 * 60;
    utimesSync(lock, old, old);
    const r = run();
    expect(r.available).toBe(true); // built through the corpse
  });

  it('a budget-TRUNCATED build is unavailable but NOT settled — no marker either way', () => {
    // A rerun against packages the budget left unbuilt manufactures
    // "fails on base too" — but truncation says nothing about the SHA, so
    // neither marker is written and a later shard may repay and succeed.
    const truncatedBuild = {
      ...okBuild,
      notBuilt: ['packages/a', 'packages/b'],
    } as unknown as BuildTestReport;
    const builds: string[] = [];
    const build = (w: string) => {
      builds.push(w);
      return truncatedBuild;
    };
    const first = run({}, build);
    expect(first.available).toBe(false);
    expect(first.note).toContain('not built');
    expect(first.note).toContain('packages/a');
    // No success marker and no failed marker: the next shard repays the build.
    expect(existsSync(join(first.path!, '.qwen-review-base-ok'))).toBe(false);
    expect(existsSync(join(first.path!, '.qwen-review-base-failed'))).toBe(
      false,
    );
    const second = run({}, build);
    expect(second.available).toBe(false);
    expect(second.note).not.toContain('already failed');
    expect(builds).toHaveLength(2);
  });

  it('a FAILED build is a settled answer — later shards do not re-pay it', () => {
    const builds: string[] = [];
    const build = (w: string) => {
      builds.push(w);
      return failedBuild;
    };
    expect(run({}, build).available).toBe(false);
    const second = run({}, build);
    expect(second.available).toBe(false);
    expect(second.note).toContain('already failed');
    expect(builds).toHaveLength(1);
  });

  it('recovers from a stale base tree left by a crashed run', () => {
    const stale = baseWorktreePath(worktree);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'junk'), 'x');
    // A non-empty directory makes `git worktree add` fail `already exists`.
    expect(run().available).toBe(true);
  });

  it('is NOT available when the base tree does not build', () => {
    const r = run({}, () => failedBuild);
    expect(r.available).toBe(false);
    // The tree is kept: a base that will not compile is worth looking at, and
    // the note must not read as a defect in the PR.
    expect(existsSync(r.path!)).toBe(true);
    expect(r.build).toBe(failedBuild);
    expect(r.note).toMatch(/did not build/);
    expect(r.note).toMatch(/never a finding against the PR/);
  });

  it('is NOT available when the build handed off without building anything', () => {
    // A PR that adds a workspace package maps to no package at the merge base,
    // so runBuildTest hands off `unsupported` (ok: true, build: []). Stamping that
    // tree available would let an A/B read the missing build as a behavioural diff.
    const handoff = {
      ok: true,
      toolchain: 'unsupported',
      build: [],
      note: 'handoff',
    } as unknown as BuildTestReport;
    const r = run({}, () => handoff);
    expect(r.available).toBe(false);
    expect(
      existsSync(join(baseWorktreePath(worktree), '.qwen-review-base-ok')),
    ).toBe(false);
  });

  it('is NOT available when npm scoped nothing to compile', () => {
    // A docs-only diff (or a package with no build script) runs zero build commands
    // and returns ok: true with an empty build[]; that is not a built tree.
    const empty = {
      ok: true,
      toolchain: 'npm',
      build: [],
      note: 'nothing to build',
    } as unknown as BuildTestReport;
    expect(run({}, () => empty).available).toBe(false);
  });

  it('refuses when the plan carries no mergeBaseSha', () => {
    const r = run({ plan: { mergeBaseSha: undefined } });
    expect(r.available).toBe(false);
    expect(r.build).toBeNull();
    expect(r.note).toMatch(/no mergeBaseSha/);
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('refuses when the base branch could not be fetched — the SHA may be stale', () => {
    // An A/B against a stale base attributes the base branch's own commits to
    // this PR: the two-dot-diff error, in another shape.
    const r = run({ plan: { baseFetchFailed: true } });
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/stale/);
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('refuses an unreadable plan and a missing worktree without throwing', () => {
    expect(
      runBaseTree({
        plan: join(repo, 'nope.json'),
        worktree,
        timeout: 60,
        install: false,
        build: () => okBuild,
      }).note,
    ).toMatch(/cannot read the plan/);
    expect(run({ worktree: join(repo, 'no-such-tree') }).note).toMatch(
      /does not exist/,
    );
  });

  it('refuses a mergeBaseSha that is not a commit in this repo', () => {
    const r = run({ plan: { mergeBaseSha: '0'.repeat(40) } });
    expect(r.available).toBe(false);
    expect(r.note).toMatch(/base worktree could not be created/);
  });

  it('ignores an exported GIT_DIR redirect when adding the base tree', () => {
    // An exported GIT_DIR overrides repository discovery for every git call
    // that inherits it: the add would land in the redirected repository and
    // the A/B measure the wrong program while every check against the given
    // tree passes. The sha below IS a commit — just not of this repo.
    const foreign = mkdtempSync(join(tmpdir(), 'qwen-base-tree-foreign-'));
    try {
      git(foreign, 'init', '-q', '-b', 'main');
      git(foreign, 'config', 'user.email', 't@t.t');
      git(foreign, 'config', 'user.name', 't');
      writeFileSync(join(foreign, 'b.txt'), 'x\n');
      git(foreign, 'add', '-A');
      git(foreign, 'commit', '-qm', 'foreign');
      const foreignSha = git(foreign, 'rev-parse', 'HEAD');

      process.env['GIT_DIR'] = join(foreign, '.git');
      let r: BaseTreeReport;
      try {
        r = run({ plan: { mergeBaseSha: foreignSha } });
      } finally {
        delete process.env['GIT_DIR'];
      }

      expect(r.available).toBe(false);
      expect(r.note).toMatch(/base worktree could not be created/);
      // The foreign repository gained no worktree from this call — its list
      // still holds only its own main checkout.
      expect(git(foreign, 'worktree', 'list').split('\n')).toHaveLength(1);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});
