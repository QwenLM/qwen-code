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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  utimesSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBaseTree, type BaseTreeReport } from './base-tree.js';
import { baseWorktreePath } from './lib/paths.js';
import { gitConfigPath } from './lib/test-utils.js';
import type { BuildTestReport } from './build-test.js';

// The race witness needs a writer landing BETWEEN the opening screen and the
// creation add; the sweep is the code that runs between them, so it is the
// seam. Defaults to the real implementation — every other test runs it.
const seam = vi.hoisted(() => ({
  realDiscard: undefined as ((...args: unknown[]) => unknown) | undefined,
  beforeDiscard: undefined as (() => void) | undefined,
}));
vi.mock('./lib/worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/worktree.js')>();
  seam.realDiscard = actual.discardWorktree as (...a: unknown[]) => unknown;
  return {
    ...actual,
    discardWorktree: (...args: unknown[]) => {
      seam.beforeDiscard?.();
      return seam.realDiscard!(...args);
    },
  };
});

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

  const run = (
    over: { plan?: Record<string, unknown>; worktree?: string } = {},
    build: (w: string) => BuildTestReport = () => okBuild,
  ): BaseTreeReport => {
    const { plan: planOver, ...rest } = over;
    return runBaseTree({
      plan: writePlan(planOver),
      worktree,
      timeout: 60,
      install: false,
      build,
      ...rest,
    });
  };

  beforeEach(() => {
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

  afterEach(() => {
    seam.beforeDiscard = undefined;
    rmSync(repo, { recursive: true, force: true });
  });

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

  it('REFUSES the creation checkout when the common config plants a content filter', () => {
    // The creation checkout rewrites every file the base commit carries,
    // which EXECUTES a planted filter, and nothing in the pipeline wipes the
    // common dir the plant persists in. The screen must refuse the build the
    // way the probe-creation screen refuses its checkout — an unavailable A/B
    // (infrastructure), never an executed filter.
    const pwned = join(repo, 'PWNED-base-create');
    appendFileSync(
      join(repo, '.git', 'config'),
      `[filter "evil"]\n\tsmudge = touch ${gitConfigPath(pwned)}\n`,
    );
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=evil\n');

    const builds: string[] = [];
    const r = run({}, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(r.note).toContain('content filter');
    expect(builds).toHaveLength(0);
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('the creation checkout is INERT — a planted post-checkout hook never fires', () => {
    // The screen certifies FILTERS only; `worktree add` still fires
    // `post-checkout` from the shared common hooks dir (measured live, git
    // 2.39 and 2.43, on this exact `--detach` shape). A probe writes the
    // hook with the same facility as the filter plant — one write + chmod —
    // so the creation spawn must carry the inert overrides too.
    const pwned = join(repo, 'PWNED-base-hook');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\ntouch ${pwned}\n`,
    );
    chmodSync(join(repo, '.git', 'hooks', 'post-checkout'), 0o755);

    const r = run();

    // Inert is not "the build failed": the tree came up and the build ran.
    expect(r.available).toBe(true);
    expect(existsSync(pwned)).toBe(false);
  });

  it('the creation checkout empties core.fsmonitor — a planted command never fires', () => {
    // The screen's regex matches filter keys only, so a fsmonitor-only plant
    // passes it clean — and `worktree add --detach` runs a repo-local
    // `core.fsmonitor` (measured live). The override empties the key at the
    // spawn, the way the probe tree's creation always has.
    const pwned = join(repo, 'PWNED-base-fsmonitor');
    appendFileSync(
      join(repo, '.git', 'config'),
      `[core]\n\tfsmonitor = touch ${gitConfigPath(pwned)}\n`,
    );

    const r = run();

    expect(r.available).toBe(true);
    expect(existsSync(pwned)).toBe(false);
  });

  it('re-screens after the sweep — a plant between the screen and the add is refused', () => {
    // The lock excludes other base-tree builders, not shards running attacker
    // code: a concurrent probe can land the two-write plant the instant the
    // stale tree's sweep finishes — after the opening screen read, before
    // the creation add re-parses the config (measured live: 6/6 race
    // iterations executed the plant). The seam stands in for that writer.
    const pwned = join(repo, 'PWNED-base-race');
    seam.beforeDiscard = () => {
      appendFileSync(
        join(repo, '.git', 'config'),
        `[filter "evil"]\n\tsmudge = touch ${gitConfigPath(pwned)}\n`,
      );
      mkdirSync(join(repo, '.git', 'info'), { recursive: true });
      writeFileSync(
        join(repo, '.git', 'info', 'attributes'),
        '* filter=evil\n',
      );
    };

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('content filter');
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
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
    // A marker for a DIFFERENT sha (rebase between runs) does not shortcut.
    writeFileSync(join(first.path!, '.qwen-review-base-ok'), 'f'.repeat(40));
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
