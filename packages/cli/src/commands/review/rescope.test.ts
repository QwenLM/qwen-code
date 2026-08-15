/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git`, real repo. The command's whole job is to turn shas into a
// correctly-scoped diff, and the failure this feature must never have is a
// range that reviews the wrong code — a property of git's behaviour, not of a
// mock's. The exit-code contract is pinned hard because the skill branches on
// it: 2 falls back to the FULL diff, 3 stops as "nothing new", and only 0 may
// touch the plan.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rescopeCommand,
  RESCOPE_EXIT_FULL_RANGE,
  RESCOPE_EXIT_NOTHING_NEW,
  type IncrementalScope,
} from './rescope.js';
import { buildDiffPlan } from './lib/diff-plan.js';
import { buildPlanReport } from './lib/report.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

let repo: string;
let cwd: string;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-rescope-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

const CHANGED = 'packages/app/src/changed.ts';
const CALLER = 'packages/app/src/caller.ts';
const BYSTANDER = 'packages/app/src/bystander.ts';

/**
 * base — the PR's merge base;
 * anchor — round 1's head (PR touches all three files);
 * head — round 2's head (the fix touches only `changed.ts`).
 */
function seedHistory(): { base: string; anchor: string; head: string } {
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));
  write('packages/app/package.json', JSON.stringify({ name: '@t/app' }));
  write(CHANGED, 'export const v = 1;\n');
  write(CALLER, "import { v } from './changed.js';\nexport const c = v;\n");
  write(BYSTANDER, 'export const b = 1;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  write(CHANGED, 'export const v = 2;\n');
  write(CALLER, "import { v } from './changed.js';\nexport const c = v + 1;\n");
  write(BYSTANDER, 'export const b = 2;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'round 1 (the PR)');
  const anchor = git('rev-parse', 'HEAD');

  write(CHANGED, 'export const v = 3;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'round 2 (the fix)');
  const head = git('rev-parse', 'HEAD');
  return { base, anchor, head };
}

/** The plan `fetch-pr` would have written for base..head, plus identity. */
function writeFetchedPlan(base: string, head: string): string {
  const diffText = execFileSync(
    'git',
    ['diff', '--no-color', `${base}..${head}`],
    { cwd: repo, encoding: 'utf8' },
  );
  mkdirSync(join(repo, '.qwen/tmp'), { recursive: true });
  const diffPath = '.qwen/tmp/qwen-review-pr-7-diff.txt';
  writeFileSync(join(repo, diffPath), diffText);
  const plan = {
    prNumber: '7',
    ownerRepo: 'o/r',
    worktreePath: repo,
    fetchedSha: head,
    mergeBaseSha: base,
    diffPath,
    diffPathAbsolute: join(repo, diffPath),
    effort: 'high',
    carriedThrough: 'untouched',
    ...buildPlanReport(buildDiffPlan(diffText, 400), null),
  };
  const planPath = join(repo, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  return planPath;
}

function run(planPath: string, anchor: string): void {
  (rescopeCommand.handler as (argv: unknown) => void)({
    plan: planPath,
    anchor,
    maxChunkLines: 400,
  });
}

type RescopedPlan = Record<string, unknown> & {
  incremental: IncrementalScope;
  diffPath: string;
  chunks: Array<{ id: number }>;
  files: Array<{ path: string }>;
};

describe('rescope', () => {
  it('scopes to the interdiff, widens one import hop, and preserves plan identity', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    run(planPath, anchor);
    expect(process.exitCode ?? 0).toBe(0);

    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    // Identity and provenance ride through untouched.
    expect(plan['prNumber']).toBe('7');
    expect(plan['worktreePath']).toBe(repo);
    expect(plan['fetchedSha']).toBe(head);
    expect(plan['mergeBaseSha']).toBe(base);
    expect(plan['carriedThrough']).toBe('untouched');

    // The scope: the fix's file on its incremental hunks, its importer pulled
    // back in by the widening, the bystander left out.
    expect(plan.incremental.anchor).toBe(anchor);
    expect(plan.incremental.deltaFiles).toEqual([CHANGED]);
    expect(plan.incremental.interaction).toEqual([
      { path: CALLER, importsChanged: [CHANGED] },
    ]);
    expect(plan.incremental.contextFileCount).toBe(1);
    expect(plan.incremental.fullDiffPath).toBe(
      '.qwen/tmp/qwen-review-pr-7-diff.txt',
    );
    expect(plan['diffPathAbsolute']).toBe(
      join(repo, '.qwen/tmp/qwen-review-pr-7-diff-incremental.txt'),
    );

    // The composite diff: BOTH scoped files carry their full-range hunks —
    // the interdiff only chose the delta file NAMES. changed.ts therefore
    // shows v1 -> v3 (not the round-2 v2 -> v3 slice: an interdiff hunk that
    // restores earlier lines exists in no hunk of the PR diff and 422s
    // comment anchoring), and the bystander appears nowhere.
    const diff = readFileSync(join(repo, plan.diffPath), 'utf8');
    expect(diff).toContain('+export const v = 3;');
    expect(diff).toContain('-export const v = 1;');
    expect(diff).not.toContain('const v = 2;');
    expect(diff).toContain('+export const c = v + 1;');
    expect(diff).not.toContain('bystander');
    // The superseded full-range diff file stays intact for `fullDiffPath`
    // readers — a successful rescope must not consume what it supersedes.
    expect(
      readFileSync(join(repo, plan.incremental.fullDiffPath!), 'utf8'),
    ).toContain('bystander');

    // The plan's chunks/files were rebuilt from the composite by the shared
    // builders — the same shapes every downstream reader already parses.
    expect(plan.files.map((f) => f.path).sort()).toEqual([CALLER, CHANGED]);
    expect(plan.chunks.length).toBeGreaterThan(0);
  });

  it('exit 2 on an unknown or non-ancestor anchor, plan untouched', () => {
    const { base, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const before = readFileSync(planPath, 'utf8');

    run(planPath, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(before);

    // A commit from a DIFFERENT history: real, resolvable, not an ancestor.
    process.exitCode = undefined;
    git('checkout', '-q', '--orphan', 'stray');
    write('stray.ts', 'export {};\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'stray');
    const stray = git('rev-parse', 'HEAD');
    run(planPath, stray);
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('exit 3 when the anchor IS the head, and when the interdiff is empty', () => {
    const { base, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);

    run(planPath, head);
    expect(process.exitCode).toBe(RESCOPE_EXIT_NOTHING_NEW);

    // An empty commit on top: new sha, identical tree — nothing to review.
    process.exitCode = undefined;
    git('commit', '-q', '--no-verify', '--allow-empty', '-m', 'empty');
    const emptyHead = git('rev-parse', 'HEAD');
    const planPath2 = writeFetchedPlan(base, emptyHead);
    const before = readFileSync(planPath2, 'utf8');
    run(planPath2, head);
    expect(process.exitCode).toBe(RESCOPE_EXIT_NOTHING_NEW);
    expect(readFileSync(planPath2, 'utf8')).toBe(before);
  });

  it('exit 2 on a plan with no worktree flow — local and lightweight plans', () => {
    seedHistory();
    const planPath = join(repo, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ prNumber: '7' }));
    run(planPath, 'HEAD');
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
  });

  it('a delta file nobody imports widens nothing', () => {
    const { base, head } = seedHistory();
    // Round 3 touches only the bystander, which nobody imports.
    write(BYSTANDER, 'export const b = 3;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'round 3');
    const head3 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head3);
    run(planPath, head);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    expect(plan.incremental.deltaFiles).toEqual([BYSTANDER]);
    expect(plan.incremental.interaction).toEqual([]);
    expect(plan.files.map((f) => f.path)).toEqual([BYSTANDER]);
  });
});

describe('rescope — contract pins from review findings', () => {
  it('pins the exit-code LITERALS the skill prose branches on', () => {
    // The skill hardcodes 3 = "nothing new, stop" and any-other = "full
    // range". A swap of the two constants keeps every symbolic assertion
    // green while refusals start STOPPING the round — the skip-instead-of-
    // fallback failure the module header forbids.
    expect(RESCOPE_EXIT_FULL_RANGE).toBe(2);
    expect(RESCOPE_EXIT_NOTHING_NEW).toBe(3);
  });

  it('honours --out: the rescoped plan lands there, the input stays byte-identical', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const before = readFileSync(planPath, 'utf8');
    const outPath = join(repo, 'rescoped.json');
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      out: outPath,
      maxChunkLines: 400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
    const out = JSON.parse(readFileSync(outPath, 'utf8')) as RescopedPlan;
    expect(out.incremental.deltaFiles).toEqual([CHANGED]);
  });

  it('same-sha exit 3 leaves the plan byte-identical', () => {
    const { base, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const before = readFileSync(planPath, 'utf8');
    run(planPath, head);
    expect(process.exitCode).toBe(RESCOPE_EXIT_NOTHING_NEW);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('widens exactly ONE hop — a two-link chain does not flood-fill', () => {
    const { base } = seedHistory();
    // deep.ts imports caller.ts (which imports changed.ts). Both links are in
    // the PR (touched in a follow-up commit) so both are plan candidates.
    write(
      'packages/app/src/deep.ts',
      "import { c } from './caller.js';\nexport const d = c;\n",
    );
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'add deep');
    const anchor2 = git('rev-parse', 'HEAD');
    write(CHANGED, 'export const v = 9;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'fix again');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head2);
    run(planPath, anchor2);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    expect(plan.incremental.deltaFiles).toEqual([CHANGED]);
    expect(plan.incremental.interaction.map((e) => e.path)).toEqual([CALLER]);
    // deep.ts is two hops out: context, not interaction.
    expect(plan.incremental.contextFileCount).toBeGreaterThan(0);
  });

  it('a test-file dependent stays OUT of the interaction set', () => {
    const { base } = seedHistory();
    write(
      'packages/app/src/caller.test.ts',
      "import { v } from './changed.js';\nexport const t = v;\n",
    );
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'add test dependent');
    const anchor2 = git('rev-parse', 'HEAD');
    write(CHANGED, 'export const v = 9;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'fix');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head2);
    run(planPath, anchor2);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    expect(plan.incremental.interaction.map((e) => e.path)).toEqual([CALLER]);
  });

  it('widens across workspace packages through a bare package specifier', () => {
    const { base } = seedHistory();
    write('packages/app/src/index.ts', 'export const entry = 1;\n');
    write('packages/lib/package.json', JSON.stringify({ name: '@t/lib' }));
    write(
      'packages/lib/src/user.ts',
      "import { entry } from '@t/app';\nexport const u = entry;\n",
    );
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'add cross-package user');
    const anchor2 = git('rev-parse', 'HEAD');
    write('packages/app/src/index.ts', 'export const entry = 2;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'change entry');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head2);
    run(planPath, anchor2);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    expect(plan.incremental.interaction).toEqual([
      {
        path: 'packages/lib/src/user.ts',
        importsChanged: ['packages/app/src/index.ts'],
      },
    ]);
  });

  it('preserves post-image line counts and heaviness in the rescoped plan', () => {
    seedHistory();
    // A large file whose round-1 change rewrites most of it: heavy by the
    // rewrite-ratio branch. The fix touches it again so it is delta.
    const bigV1 =
      Array.from({ length: 600 }, (_, i) => `export const a${i} = 1;`).join(
        '\n',
      ) + '\n';
    write('packages/app/src/big.ts', bigV1);
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'seed big');
    const base2 = git('rev-parse', 'HEAD');
    const bigV2 =
      Array.from({ length: 600 }, (_, i) => `export const a${i} = 2;`).join(
        '\n',
      ) + '\n';
    write('packages/app/src/big.ts', bigV2);
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'round 1 rewrites big');
    const anchor2 = git('rev-parse', 'HEAD');
    write('packages/app/src/big.ts', bigV2.replace('a0 = 2', 'a0 = 3'));
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'fix big');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base2, head2);
    run(planPath, anchor2);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    const big = (
      plan.files as Array<{
        path: string;
        fileLines?: number;
        heavy?: boolean;
        addedRanges?: unknown;
      }>
    ).find((f) => f.path === 'packages/app/src/big.ts')!;
    // The degradation rescope exists to prevent: a null post-image resolver
    // zeroes fileLines and heavy never fires — invariant agents vanish.
    expect(big.fileLines).toBe(600);
    expect(big.heavy).toBe(true);
    expect(big.addedRanges).toBeDefined();
  });

  it('refuses an already-rescoped plan and a plan with unusable files[]', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    run(planPath, anchor);
    expect(process.exitCode ?? 0).toBe(0);
    const after = readFileSync(planPath, 'utf8');
    process.exitCode = undefined;
    run(planPath, anchor);
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(after);

    process.exitCode = undefined;
    const planPath2 = writeFetchedPlan(base, head);
    const mangled = JSON.parse(readFileSync(planPath2, 'utf8')) as Record<
      string,
      unknown
    >;
    mangled['files'] = 'nope';
    writeFileSync(planPath2, JSON.stringify(mangled));
    const before = readFileSync(planPath2, 'utf8');
    run(planPath2, anchor);
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath2, 'utf8')).toBe(before);
  });

  it('an unreadable plan path exits 2, not a throw', () => {
    seedHistory();
    run(join(repo, 'no-such-plan.json'), 'HEAD');
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
  });
});
