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
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Argv } from 'yargs';
import {
  baseTreeCommand,
  runBaseTree,
  type BaseTreeReport,
} from './base-tree.js';
import { baseWorktreePath } from './lib/paths.js';
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
    // "Not buildable" is a SETTLED answer too: the failed marker is what
    // keeps later shards from re-paying the same cold checkout.
    expect(
      existsSync(join(baseWorktreePath(worktree), '.qwen-review-base-failed')),
    ).toBe(true);
  });

  it('does NOT run a Maven merge-base build nothing could consume', () => {
    // A/B attribution reruns npm test commands (test-delta); Agent 7's brief
    // says the same for Maven in this release. Commit the pom so the base
    // tree selects the Maven adapter, and pin that the build never runs.
    writeFileSync(join(repo, 'pom.xml'), '<project/>');
    git(repo, 'add', 'pom.xml');
    git(repo, 'commit', '-qam', 'maven base');
    const mavenSha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: mavenSha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
    expect(r.note).toContain('not run');
    // The attribution guard is what stops a downstream agent from reading an
    // unavailable A/B as something attributable to the PR — pin it like the
    // sibling failed-build note does.
    expect(r.note).toMatch(/never a finding against the PR/);
    // The gate answers from the object store (git cat-file) BEFORE the
    // checkout: a large Java reactor never materialises a tree just to
    // learn it will not be built.
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('does NOT check out a nested-pom base the Maven gate exists to skip', () => {
    // Standalone module poms with no root aggregator miss the root `pom.xml`
    // probe, but the base is Maven just the same and cannot be consumed.
    mkdirSync(join(repo, 'app'), { recursive: true });
    writeFileSync(join(repo, 'app', 'pom.xml'), '<project/>');
    git(repo, 'add', 'app');
    git(repo, 'commit', '-qam', 'nested maven base');
    const nestedSha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: nestedSha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('does NOT treat a deep fixture pom as a Maven base', () => {
    // Vendored samples, archetype fixtures, and maven-invoker ITs live deeper
    // than `<dir>/pom.xml`; counting one would permanently — and silently —
    // disable A/B attribution for a repo that merely ships one.
    const fixture = join(repo, 'src', 'test', 'resources', 'projects', 'it');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, 'pom.xml'), '<project/>');
    git(repo, 'add', 'src');
    git(repo, 'commit', '-qam', 'fixture pom');
    const fixtureSha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: fixtureSha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
  });

  it('still detects a nested pom under a git-quoted directory name', () => {
    // Non-ASCII names (and names with quotes, tabs, or backslashes) come
    // back C-quoted from `ls-tree` under core.quotePath; the probe must
    // resolve the raw name anyway, or the base slips past the gate.
    mkdirSync(join(repo, 'm\u00f3dulo'), { recursive: true });
    writeFileSync(join(repo, 'm\u00f3dulo', 'pom.xml'), '<project/>');
    git(repo, 'add', 'm\u00f3dulo');
    git(repo, 'commit', '-qam', 'non-ascii nested maven base');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('does NOT let a husky-only package.json suppress the nested-pom probe', () => {
    // A script-less, workspace-less manifest is not an npm project under
    // the adapter's applies rule, so a standalone Maven module beside it
    // must still be caught before checkout.
    mkdirSync(join(repo, 'app'), { recursive: true });
    writeFileSync(join(repo, 'app', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { prepare: 'husky' } }),
    );
    git(repo, 'add', 'app', 'package.json');
    git(repo, 'commit', '-qam', 'husky + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
  });

  it('suppresses the nested-pom probe for an npm-applicable package.json', () => {
    // A build/test script (or workspaces) makes the base npm's to consume;
    // the probe stays home and the build decides.
    mkdirSync(join(repo, 'app'), { recursive: true });
    writeFileSync(join(repo, 'app', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    git(repo, 'add', 'app', 'package.json');
    git(repo, 'commit', '-qam', 'npm + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
  });

  it('does NOT treat an unmodeled workspace glob as npm-applicable', () => {
    // `packages/**` scopes nothing the npm adapter can model (applies()
    // declines it); suppressing the nested-pom probe for the blob would make
    // a standalone-module Maven base pay the cold checkout this gate exists
    // to prevent. The fixture pairs the unmodeled glob with a modeled one
    // resolving a real package: dropping the conjunct then makes the blob
    // npm-applicable and this test red.
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    mkdirSync(join(repo, 'app'), { recursive: true });
    writeFileSync(
      join(repo, 'app', 'package.json'),
      JSON.stringify({
        name: 'app',
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    );
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/**', 'app'] }),
    );
    git(repo, 'add', 'java', 'app', 'package.json');
    git(repo, 'commit', '-qam', 'unmodeled glob + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
    expect(existsSync(baseWorktreePath(worktree))).toBe(false);
  });

  it('does NOT treat a zero-package workspace glob as npm-applicable', () => {
    // A modeled glob resolving to NO package at the base scopes nothing
    // either — the nested-pom probe must still run.
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    git(repo, 'add', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'empty glob + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
  });

  it('suppresses the nested-pom probe when a modeled glob resolves to a base package', () => {
    // The positive control for the two tests above: a modeled glob with at
    // least one member package at the base IS npm-applicable, so the probe
    // stays home even beside a nested pom, and the build decides.
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@x/app', scripts: { build: 'tsc' } }),
    );
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    git(repo, 'add', 'packages', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'workspace + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
  });

  it('suppresses the nested-pom probe for OBJECT-form workspaces too', () => {
    // npm accepts `{ workspaces: { packages: [...] } }` as well as the
    // array form; the gate's blobIsNpmProject must too, or a base declaring
    // the object form reads npm-inapplicable beside a nested pom — a false
    // Maven handoff that permanently disables A/B attribution there while
    // the on-disk twin accepts the same repo.
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@x/app', scripts: { build: 'tsc' } }),
    );
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['packages/*'] } }),
    );
    git(repo, 'add', 'packages', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'object workspaces + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
  });

  it('models ./-prefixed workspace globs like their bare form', () => {
    // The on-disk twin strips a leading `./` from each glob; without it
    // here, `workspaceDirFor` never matched the expanded dirs and an npm
    // base was misclassified as Maven, losing A/B attribution.
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@x/app', scripts: { build: 'tsc' } }),
    );
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['./packages/*'] }),
    );
    git(repo, 'add', 'packages', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'dot-slash workspace + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
  });

  it('models the empty-string workspace glob as the root package, like the disk twin', () => {
    // `"workspaces": [""]` names the root itself as a member: on disk the
    // manifest probe joins `<root>//package.json` and applies() accepts it.
    // The blob twin probed the unresolvable `<sha>:/package.json` instead
    // and misread the base as Maven-only, permanently disabling A/B there.
    mkdirSync(join(repo, 'app'), { recursive: true });
    writeFileSync(join(repo, 'app', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: '@x/root', workspaces: [''] }),
    );
    git(repo, 'add', 'app', 'package.json');
    git(repo, 'commit', '-qam', 'root-as-member glob + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
  });

  it('suppresses the nested-pom probe for literal workspace members too', () => {
    // Every twin-parity branch has a dedicated test except the LITERAL
    // member (`workspaces: ["packages/app"]`, no `*`): a future edit
    // breaking it would make blobIsNpmProject refuse a literal-workspaces
    // merge base, and beside a standalone nested Maven module the probe
    // would permanently disable A/B attribution for that repo shape while
    // every other base-tree test stayed green.
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@x/app', scripts: { build: 'tsc' } }),
    );
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/app'] }),
    );
    git(repo, 'add', 'packages', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'literal workspace member + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
  });

  it('does NOT count an unreadable member manifest as an npm package', () => {
    // applies() requires at least one readable package: a manifest that
    // does not parse lands in `skipped` on disk, so counting it on blob
    // EXISTENCE alone suppressed the nested-pom probe for a standalone-
    // module Maven base.
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'app', 'package.json'), '{oops');
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    git(repo, 'add', 'packages', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'broken member manifest + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
  });

  it('does NOT count a member whose manifest parses to no usable name', () => {
    // hasUsableManifestAt mirrors readWorkspacePackages' skip rule: a
    // manifest without a non-empty string `name` is not a package. A base
    // whose only members lack names must stay npm-inapplicable, or the
    // nested-pom probe is suppressed for a base the disk side rejects.
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'app', 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    );
    git(repo, 'add', 'packages', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'nameless member + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
  });

  it('does NOT count a negation-excluded workspace member as npm-applicable', () => {
    // The on-disk twin puts a negated member in `skipped`, not `packages`;
    // excluding the ONLY member leaves nothing npm-applicable, so the
    // nested-pom probe must still run.
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@x/app', scripts: { build: 'tsc' } }),
    );
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*', '!packages/app'] }),
    );
    git(repo, 'add', 'packages', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'negated member + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
  });

  it('still counts a workspace when its negation excludes nothing', () => {
    // The positive twin: a negation matching no member leaves the real
    // member npm-applicable, so the probe stays home and the build decides.
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@x/app', scripts: { build: 'tsc' } }),
    );
    mkdirSync(join(repo, 'java'), { recursive: true });
    writeFileSync(join(repo, 'java', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*', '!packages/ghost'] }),
    );
    git(repo, 'add', 'packages', 'java', 'package.json');
    git(repo, 'commit', '-qam', 'harmless negation + nested maven');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
  });

  it('does NOT treat a DIRECTORY named pom.xml as a Maven base', () => {
    // `git cat-file -e` exits 0 for trees too; the probe must require a
    // BLOB, or a directory named pom.xml beside an npm-buildable layout
    // misfires the gate and permanently disables A/B for that base.
    mkdirSync(join(repo, 'pom.xml'), { recursive: true });
    writeFileSync(join(repo, 'pom.xml', 'inner.txt'), 'not a pom');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    git(repo, 'add', 'pom.xml', 'package.json');
    git(repo, 'commit', '-qam', 'pom.xml dir + npm base');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
    expect(r.note).not.toContain('Maven');
  });

  it('does NOT treat a nested DIRECTORY named pom.xml as a Maven base', () => {
    // The nested variant of the same misfire: `app/pom.xml` as a tree
    // entry must not fire the nested-pom probe.
    mkdirSync(join(repo, 'app', 'pom.xml'), { recursive: true });
    writeFileSync(join(repo, 'app', 'pom.xml', 'inner.txt'), 'not a pom');
    git(repo, 'add', 'app');
    git(repo, 'commit', '-qam', 'nested pom.xml dir base');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(builds).toHaveLength(1);
    expect(r.available).toBe(true);
    expect(r.note).not.toContain('Maven');
  });

  it('treats a base carrying BOTH a root pom.xml and an npm package.json as Maven', () => {
    // The root-pom branch of the gate is unconditional: the npm half does
    // not rescue a Maven root. Symmetrizing the gate to condition the root
    // branch on !npmAtBase would let this polyglot base pay the cold
    // checkout, and multi-toolchain aggregation (a declared future phase)
    // would leave that symmetrized gate as the only defense.
    writeFileSync(join(repo, 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    git(repo, 'add', 'pom.xml', 'package.json');
    git(repo, 'commit', '-qam', 'polyglot base');
    const sha = git(repo, 'rev-parse', 'HEAD');

    const builds: string[] = [];
    const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
      builds.push(w);
      return okBuild;
    });

    expect(r.available).toBe(false);
    expect(builds).toEqual([]);
    expect(r.note).toContain('Maven');
    expect(r.note).toMatch(/never a finding against the PR/);
  });

  it.skipIf(process.platform === 'win32')(
    'still detects a nested pom under a directory named with a line terminator',
    () => {
      // A regex `.` cannot span `\n`, and a `\n` in a name is a standard
      // core.quotePath escape — the probe parses the NUL-delimited entries
      // structurally, or this base slips past the gate.
      mkdirSync(join(repo, 'bad\ndir'), { recursive: true });
      writeFileSync(join(repo, 'bad\ndir', 'pom.xml'), '<project/>');
      git(repo, 'add', 'bad\ndir');
      git(repo, 'commit', '-qam', 'newline-dir nested maven base');
      const sha = git(repo, 'rev-parse', 'HEAD');

      const builds: string[] = [];
      const r = run({ plan: { mergeBaseSha: sha } }, (w) => {
        builds.push(w);
        return okBuild;
      });

      expect(r.available).toBe(false);
      expect(builds).toEqual([]);
      expect(r.note).toContain('Maven');
    },
  );

  it('is NOT available for a Maven build report the delta machinery cannot consume', () => {
    const mavenBuild = {
      ok: true,
      toolchain: 'maven',
      build: [{ command: './mvnw test-compile', exitCode: 0 }],
      note: 'built',
    } as unknown as BuildTestReport;

    const r = run({}, () => mavenBuild);

    expect(r.available).toBe(false);
    expect(
      existsSync(join(baseWorktreePath(worktree), '.qwen-review-base-ok')),
    ).toBe(false);
    // The sibling handoff pin's twin: a later verifier shard must not repay
    // the cold checkout plus a full Maven build to relearn the same
    // "unavailable".
    expect(
      existsSync(join(baseWorktreePath(worktree), '.qwen-review-base-failed')),
    ).toBe(true);
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

describe('the base-tree CLI option contract', () => {
  it("says the --install step is the npm toolchain's alone", () => {
    // The help text is the reviewer's only window into the flag; without the
    // caveat it implies an npm-ci-style install runs for every toolchain,
    // and Maven never runs one (it resolves inside the lifecycle command).
    const options: Record<string, { describe?: string }> = {};
    const recorder = {
      option: (name: string, spec: { describe?: string }) => {
        options[name] = spec;
        return recorder;
      },
    } as unknown as Argv;
    (baseTreeCommand.builder as (y: Argv) => Argv)(recorder);
    expect(options['install']?.describe).toContain('npm toolchain only');
  });
});
