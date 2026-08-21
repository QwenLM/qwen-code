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
import { isolateHostGitConfig } from './lib/test-utils.js';
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

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

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

  it('refuses while repo-local config defines a content filter — the add would execute it', () => {
    // The base tree's `worktree add` checks every file out, and a checkout
    // EXECUTES `filter.<name>.smudge` — the same surface `scratch-tree`
    // refuses to reset through. The attributes line and a matching file make
    // the execution real: without the screen, the add below fired the smudge.
    const pwned = join(repo, 'PWNED-base');
    git(worktree, 'config', 'filter.evil.smudge', `touch ${pwned}`);
    const attrs = git(worktree, 'rev-parse', '--git-path', 'info/attributes');
    appendFileSync(attrs, '*.txt filter=evil\n');

    const r = run();

    expect(r.available).toBe(false);
    expect(r.note).toContain('filter.evil.smudge');
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('reports the add breached — never available — when a plant appears during the checkout', () => {
    // The screen is a point-in-time read; the deterministic shape for its
    // window with the add uses the screen's own disclosed limit — a filter
    // in the GLOBAL config is the user's contract and never screened. Here
    // its smudge arms a repo-LOCAL filter when the add's initial checkout
    // executes it (attributes selecting it are committed at the base):
    // absent at the pre-read, standing at every read after — so the report
    // is breached and the just-added tree rolled back, never
    // `available: true` over an executed plant.
    const isolation = isolateHostGitConfig();
    try {
      writeFileSync(join(repo, '.gitattributes'), '*.txt filter=armer\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qam', 'base-with-attributes');
      const armedBase = git(repo, 'rev-parse', 'HEAD');
      execFileSync(
        'git',
        [
          'config',
          '--global',
          'filter.armer.smudge',
          "git config filter.evil.smudge 'touch /tmp/qwen-never'",
        ],
        { cwd: repo },
      );

      const r = run({ plan: { mergeBaseSha: armedBase } });

      expect(r.available).toBe(false);
      expect(r.note).toContain('may have EXECUTED');
      expect(r.note).toContain('filter.evil.smudge');
      // The breached tree is rolled back, not left planted for the next
      // shard.
      expect(existsSync(baseWorktreePath(worktree))).toBe(false);
    } finally {
      isolation.dispose();
    }
  });

  it('reports the add breached when the plant ERASES ITSELF during the checkout', () => {
    // The self-erasing shape the key re-read cannot see: the armer's
    // smudge arms a repo-LOCAL filter AND unsets it again, per file, so
    // the key is gone by the time the post-add re-read runs (probe, git
    // 2.39: the re-read answered clean and the command certified a tree
    // whose initial checkout had fired the plant). What the plant cannot
    // erase is the change to the config file itself — the baseline the
    // screen captured beside its clean read names it.
    const isolation = isolateHostGitConfig();
    try {
      writeFileSync(join(repo, '.gitattributes'), '*.txt filter=armer\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qam', 'base-with-attributes');
      const armedBase = git(repo, 'rev-parse', 'HEAD');
      execFileSync(
        'git',
        [
          'config',
          '--global',
          'filter.armer.smudge',
          "git config filter.evil.smudge 'touch /tmp/qwen-never'; " +
            'git config --unset filter.evil.smudge',
        ],
        { cwd: repo },
      );

      const r = run({ plan: { mergeBaseSha: armedBase } });

      expect(r.available).toBe(false);
      expect(r.note).toContain('may have EXECUTED');
      // No key survived the erase — the refusal must name the changed
      // file instead of reading as a clean point-in-time re-read.
      expect(r.note).toContain('changed');
      expect(existsSync(baseWorktreePath(worktree))).toBe(false);
    } finally {
      isolation.dispose();
    }
  });

  it('attributes a plant the add EXECUTED even when the checkout threw after it', () => {
    // A checkout can throw AFTER executing a plant: the smudge fires,
    // leaves its self-erasing trace in the common config, and kills git —
    // the spawn dies on the signal and `git` throws. The catch used to
    // report the add failure alone, burying the execution under it, and
    // the next call screened clean over the run (the plant had erased
    // itself). The baseline the screen captured still stands at the
    // catch, so the paired re-read attributes it there.
    const isolation = isolateHostGitConfig();
    try {
      const pwned = join(repo, 'PWNED-base-kill');
      writeFileSync(join(repo, '.gitattributes'), '*.txt filter=killer\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qam', 'base-with-attributes');
      const armedBase = git(repo, 'rev-parse', 'HEAD');
      execFileSync(
        'git',
        [
          'config',
          '--global',
          'filter.killer.smudge',
          `git config qwen.plant.x 1; git config --unset qwen.plant.x; touch ${pwned}; kill -9 $PPID`,
        ],
        { cwd: repo },
      );

      const r = run({ plan: { mergeBaseSha: armedBase } });

      // The plant EXECUTED — and the report says so, instead of reading
      // as an add failure.
      expect(existsSync(pwned)).toBe(true);
      expect(r.available).toBe(false);
      expect(r.note).toContain('may have EXECUTED');
      expect(r.note).toContain('changed');
    } finally {
      isolation.dispose();
    }
  });

  it('sweeps a stale tree whose own admin config holds a plant, instead of wedging on it', () => {
    // The screen's candidate set reads every `<common>/worktrees/*/
    // config.worktree`, and it used to run ABOVE the stale sweep: a plant
    // parked in the stale base tree's OWN admin dir refused every retry —
    // each attempt re-screened state the sweep's next statement would have
    // destroyed, and the refusal never moved (measured live: every retry
    // refused identically until manual cleanup). The screen now runs below
    // the sweep: the discard removes the plant with the tree, the add never
    // reads it, and the base tree is built.
    const stale = baseWorktreePath(worktree);
    git(repo, 'worktree', 'add', '--detach', '-q', stale, baseSha);
    const admin = git(
      stale,
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
    );
    writeFileSync(
      join(admin, 'config.worktree'),
      '[filter "evil"]\n\tsmudge = touch /tmp/qwen-never\n',
    );

    const r = run();

    expect(r.available).toBe(true);
    expect(existsSync(join(admin, 'config.worktree'))).toBe(false);
  });

  it('adds the base tree with a planted hook and fsmonitor inert', () => {
    // The add's initial checkout fires `post-checkout` and refreshes the
    // index — running `core.fsmonitor` — from the COMMON dir: one executable
    // file and one config write a probe can make. The screen refuses content
    // filters (above); these two surfaces are neutralised at the spawn
    // instead, and this pins the prefix on THIS command's git — removing it
    // creates both markers.
    const hooksDir = join(repo, '.git', 'hooks');
    git(repo, 'config', 'core.hooksPath', hooksDir);
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ntouch ${repo}/PWNED-hook\n`);
    chmodSync(hook, 0o755);
    git(worktree, 'config', 'core.fsmonitor', `touch ${repo}/PWNED-fsm`);

    const r = run();

    expect(r.available).toBe(true);
    expect(existsSync(join(repo, 'PWNED-hook'))).toBe(false);
    expect(existsSync(join(repo, 'PWNED-fsm'))).toBe(false);
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
