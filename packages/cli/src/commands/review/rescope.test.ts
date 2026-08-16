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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
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
    ...buildPlanReport(buildDiffPlan(diffText, 400), null, {
      operatorRoundCap: undefined,
      hasDeadline: false,
    }),
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
    // ABSOLUTE: a later step reaching for the superseded diff need not
    // share this command's cwd.
    expect(plan.incremental.fullDiffPath).toBe(
      join(repo, '.qwen/tmp/qwen-review-pr-7-diff.txt'),
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
    expect(readFileSync(plan.incremental.fullDiffPath!, 'utf8')).toContain(
      'bystander',
    );

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
    const before = readFileSync(planPath, 'utf8');
    run(planPath, 'HEAD');
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
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
    // deep.ts is two hops out: context, not interaction — and the count is
    // EXACT (bystander + deep), so a flood-fill or a dropped exclusion
    // cannot hide inside a `> 0`.
    expect(plan.incremental.contextFileCount).toBe(2);
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
    // rewrite-ratio branch (it must EXIST at the merge base — a creation is
    // not a rewrite). The fix touches it again so it is delta, and the PR
    // also touches the bystander so the delta stays a strict subset of the
    // plan (an all-changed plan is refused as a mislabeled full review).
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
    write(BYSTANDER, 'export const b = 99;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'round 1 rewrites big');
    const anchor2 = git('rev-parse', 'HEAD');
    write('packages/app/src/big.ts', bigV2 + 'export const extra = 1;\n');
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
    expect(big.fileLines).toBe(601); // the HEAD count, not the base or anchor
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

  it('a plan that parses to JSON null exits 2, not a TypeError', () => {
    seedHistory();
    const nullPlan = join(repo, 'null-plan.json');
    writeFileSync(nullPlan, 'null');
    run(nullPlan, 'HEAD');
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
  });
});

describe('rescope — verdict transfer after a rebase', () => {
  // The commit anchor dies with its history; the content verdicts must not.
  // History A: base1 → anchor (the PR touches all three files) is reviewed
  // clean, and its (base, head) blob pairs are promoted into the cache.
  // History B rewrites everything — new base (upstream moved the bystander's
  // baseline), the PR re-applied, plus a fix to changed.ts — so every commit
  // sha is new and the anchor gate refuses. The pairs then decide: the caller
  // keeps its verdict (pair unchanged, pulled back only as an interaction
  // file), the fixed file and the base-shifted file re-enter as delta.
  function seedRebase(): {
    planPath: string;
    anchor: string;
    cachePath: string;
  } {
    const { base, anchor, head } = seedHistory();
    // Round 1 (pre-rebase) promoted its verdicts: pairs of base..anchor.
    const pairs: Record<string, { base: string; head: string }> = {};
    for (const p of [CHANGED, CALLER, BYSTANDER, 'packages/app/package.json']) {
      const at = (ref: string): string => {
        try {
          return `100644 ${git('rev-parse', `${ref}:${p}`)}`;
        } catch {
          return 'absent';
        }
      };
      pairs[p] = { base: at(base), head: at(anchor) };
    }
    const cachePath = join(repo, 'cache.json');
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastModelId: 'model-a',
        lastCommitSha: anchor,
        fileVerdicts: pairs,
      }),
    );
    void head;

    // History B: a new root whose bystander baseline moved, then the PR's
    // changes re-applied, then the fix. All shas are new.
    git('checkout', '-q', '--orphan', 'rebased');
    write(BYSTANDER, 'export const b = 0; // upstream moved this\n');
    write(CHANGED, 'export const v = 0;\n');
    write(CALLER, "import { v } from './changed.js';\nexport const c = v;\n");
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base2');
    const base2 = git('rev-parse', 'HEAD');
    write(CHANGED, 'export const v = 2;\n'); // PR change + fix, squashed
    write(
      CALLER,
      "import { v } from './changed.js';\nexport const c = v + 1;\n",
    );
    write(BYSTANDER, 'export const b = 1; // upstream moved this\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'pr + fix, rebased');
    const head2 = git('rev-parse', 'HEAD');
    return { planPath: writeFetchedPlan(base2, head2), anchor, cachePath };
  }

  it('transfers unchanged pairs and re-reviews moved ones', () => {
    const { planPath, anchor, cachePath } = seedRebase();
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      model: 'model-a',
      maxChunkLines: 400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    // changed.ts: its BASE blob moved (base2 differs from base1) while its
    // head blob equals the recorded head. bystander.ts: both sides moved
    // (upstream shifted the baseline AND the head content differs).
    // caller.ts: identical pair — the clean verdict transfers, and it is
    // back in scope only as the changed file's importer.
    expect(plan.incremental.deltaFiles.sort()).toEqual([BYSTANDER, CHANGED]);
    expect(plan.incremental.interaction).toEqual([
      { path: CALLER, importsChanged: [CHANGED] },
    ]);
    expect(plan.incremental.anchor).toBe(anchor);
    const diff = readFileSync(join(repo, plan.diffPath), 'utf8');
    expect(diff).toContain('changed.ts');
    expect(diff).toContain('bystander.ts');
    expect(diff).toContain('caller.ts');
    // The hunks must be the CURRENT range's — a wrong-range regression
    // (e.g. mergeBase..old-anchor) resolves cleanly in this fixture and
    // shows dead-history content instead of the PR's head.
    expect(diff).toContain('+export const b = 1; // upstream moved this');
  });

  it('refusal branches: null cache, missing verdicts, missing file — all exit 2, no throw', () => {
    const { planPath, anchor } = seedRebase();
    const runWith = (cachePath: string) => {
      process.exitCode = undefined;
      (rescopeCommand.handler as (argv: unknown) => void)({
        plan: planPath,
        anchor,
        cache: cachePath,
        model: 'model-a',
        maxChunkLines: 400,
      });
      expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    };
    const nullCache = join(repo, 'null-cache.json');
    writeFileSync(nullCache, 'null'); // JSON.parse succeeds; deref must not
    runWith(nullCache);
    const noVerdicts = join(repo, 'no-verdicts.json');
    writeFileSync(noVerdicts, JSON.stringify({ lastModelId: 'model-a' }));
    runWith(noVerdicts);
    runWith(join(repo, 'no-such-cache.json'));
  });

  it('a live anchor still unions in pair-moved files — an upstream-moved base is not "nothing new"', () => {
    // R1-5: the anchor survives (ancestor), anchor..head is EMPTY, but the
    // merge base slid under a file — its diff-under-review changed with no
    // new commit past the anchor. The pair sees it; the interdiff cannot.
    const { base, anchor } = seedHistory();
    // Round 1's verdicts at (base, anchor).
    const pairs: Record<string, { base: string; head: string }> = {};
    for (const p of [CHANGED, CALLER, BYSTANDER, 'packages/app/package.json']) {
      const at = (ref: string): string => {
        try {
          return `100644 ${git('rev-parse', `${ref}:${p}`)}`;
        } catch {
          return 'absent';
        }
      };
      pairs[p] = { base: at(base), head: at(anchor) };
    }
    // Merge-base movement, honestly constructed: base2 derives from base1
    // and moves ONLY the bystander's baseline, so every other file's
    // (base, head) pair stays byte-identical to the recorded one. The
    // fetched head stays the anchor itself — an empty interdiff over a
    // non-empty shift in the diff-under-review.
    git('checkout', '-q', base);
    write(BYSTANDER, 'export const b = 0; // upstream moved this\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'moved base');
    const base2 = git('rev-parse', 'HEAD');
    git('checkout', '-q', anchor);
    // Written AFTER the `git add -A` above: earlier, the cache file was
    // swept into the base2 commit and the checkout removed it.
    const cachePath = join(repo, 'cache.json');
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastModelId: 'model-a',
        lastCommitSha: anchor,
        fileVerdicts: pairs,
      }),
    );
    const planPath = writeFetchedPlan(base2, anchor);
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      model: 'model-a',
      maxChunkLines: 400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    // anchor == fetchedSha (empty interdiff), yet the bystander's base blob
    // moved: it must be the delta instead of an exit-3 "nothing new".
    expect(plan.incremental.deltaFiles).toEqual([BYSTANDER]);
  });

  it('refuses the transfer across models — full range instead', () => {
    const { planPath, anchor, cachePath } = seedRebase();
    const before = readFileSync(planPath, 'utf8');
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      model: 'model-b',
      maxChunkLines: 400,
    });
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('exit 3 when every pair is identical — the rebase changed nothing under review', () => {
    const { base, anchor } = seedHistory();
    const pairs: Record<string, { base: string; head: string }> = {};
    for (const p of [CHANGED, CALLER, BYSTANDER, 'packages/app/package.json']) {
      const at = (ref: string): string => {
        try {
          return `100644 ${git('rev-parse', `${ref}:${p}`)}`;
        } catch {
          return 'absent';
        }
      };
      pairs[p] = { base: at(base), head: at(anchor) };
    }
    const cachePath = join(repo, 'cache.json');
    writeFileSync(
      cachePath,
      JSON.stringify({ lastModelId: 'model-a', fileVerdicts: pairs }),
    );
    // Amend the anchor commit: same tree, new sha — the pure-rebase case.
    git('checkout', '-q', anchor);
    git('commit', '--amend', '-q', '--no-verify', '-m', 'anchor, amended');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head2);
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      model: 'model-a',
      maxChunkLines: 400,
    });
    expect(process.exitCode).toBe(RESCOPE_EXIT_NOTHING_NEW);
  });

  it('--cache without --model refuses the transfer on a dead anchor', () => {
    const { planPath, anchor, cachePath } = seedRebase();
    const before = readFileSync(planPath, 'utf8');
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      maxChunkLines: 400,
    });
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('renders a non-sha anchor label WHOLE in the summary — never content-verd', () => {
    const { planPath, anchor, cachePath } = seedRebase();
    // Strip lastCommitSha so the transfer label falls back to the literal.
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<
      string,
      unknown
    >;
    delete cache['lastCommitSha'];
    writeFileSync(cachePath, JSON.stringify(cache));
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      model: 'model-a',
      maxChunkLines: 400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    expect(plan.incremental.anchor).toBe('content-verdicts');
  });
});

describe('rescope — round-2 findings', () => {
  it('a rename in the fix round keeps its RENAME section — hunks stay a subset of the PR diff', () => {
    const { base, anchor } = seedHistory();
    // The fix round renames caller.ts (routine `git mv` on review feedback).
    git('mv', CALLER, 'packages/app/src/renamed-caller.ts');
    git('commit', '-q', '--no-verify', '-m', 'rename in fix round');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head2);
    run(planPath, anchor);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    const diff = readFileSync(join(repo, plan.diffPath), 'utf8');
    // A pathspec-scoped re-capture cannot see the rename source and renders
    // a whole-file ADD ('new file mode'); the byte-slice keeps the pairing.
    expect(diff).toContain('rename to packages/app/src/renamed-caller.ts');
    expect(diff).not.toContain('new file mode');
  });

  it('empty and zero-usable files[] both refuse with the plan untouched', () => {
    const { base, anchor, head } = seedHistory();
    for (const files of [[], [{}, { path: 42 }]]) {
      process.exitCode = undefined;
      const planPath = writeFetchedPlan(base, head);
      const mangled = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
        string,
        unknown
      >;
      mangled['files'] = files;
      writeFileSync(planPath, JSON.stringify(mangled));
      const before = readFileSync(planPath, 'utf8');
      run(planPath, anchor);
      expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
      expect(readFileSync(planPath, 'utf8')).toBe(before);
    }
  });

  it('a delta file restored to its merge-base state is reconciled out of deltaFiles', () => {
    const { base, anchor } = seedHistory();
    // The fix round restores changed.ts to its merge-base content: it is in
    // the interdiff, but the PR's own diff has no section for it.
    write(CHANGED, 'export const v = 1;\n');
    write(BYSTANDER, 'export const b = 9;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'restore + touch bystander');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head2);
    run(planPath, anchor);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    // bystander changed for real; the restored file names no phantom scope —
    // but its importer still re-enters through the widening.
    expect(plan.incremental.deltaFiles).toEqual([BYSTANDER]);
    expect(plan.incremental.interaction.map((e) => e.path)).toContain(CALLER);
    const diff = readFileSync(join(repo, plan.diffPath), 'utf8');
    expect(diff).not.toContain('changed.ts');
  });

  it('runs correctly from a cwd OUTSIDE the worktree — the documented production shape', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    // Rewrite the plan's diff path to absolute (fetch-pr always records it).
    const plan0 = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    plan0['diffPathAbsolute'] = join(repo, plan0['diffPath'] as string);
    writeFileSync(planPath, JSON.stringify(plan0));
    const checkout = realpathSync(
      mkdtempSync(join(tmpdir(), 'main-checkout-')),
    );
    const prev = process.cwd();
    process.chdir(checkout);
    try {
      run(planPath, anchor);
      expect(process.exitCode ?? 0).toBe(0);
      const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
      expect(plan.incremental.deltaFiles).toEqual([CHANGED]);
      // The interaction hunks are present — the -C pin, not the cwd, decides.
      const diff = readFileSync(join(checkout, plan.diffPath), 'utf8');
      expect(diff).toContain('caller.ts');
    } finally {
      process.chdir(prev);
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('an unwritable --out exits 2 instead of throwing', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const blocked = join(repo, 'blocked');
    writeFileSync(blocked, 'a plain file where a directory must go');
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      out: join(blocked, 'nested', 'plan.json'),
      maxChunkLines: 400,
    });
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
  });
});

describe('rescope — candidate narrowing and remaining round-2 gates', () => {
  /** A candidate as fetch-pr writes it, covering the full plan. */
  function writeCandidate(base: string, head: string, paths: string[]): string {
    const fv: Record<string, { base: string; head: string }> = {};
    for (const p of paths) {
      const at = (ref: string): string => {
        try {
          return `100644 ${git('rev-parse', `${ref}:${p}`)}`;
        } catch {
          return 'absent';
        }
      };
      fv[p] = { base: at(base), head: at(head) };
    }
    const candidatePath = join(
      repo,
      '.qwen/tmp/qwen-review-pr-7-cache-candidate.json',
    );
    mkdirSync(join(repo, '.qwen/tmp'), { recursive: true });
    writeFileSync(
      candidatePath,
      JSON.stringify({
        v: 1,
        target: 'pr-7',
        lastCommitSha: head,
        mergeBaseSha: base,
        fileVerdicts: fv,
      }),
    );
    return candidatePath;
  }

  it('narrows the candidate to reviewed pairs; unreviewed context pairs drop without a cache', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const candidatePath = writeCandidate(base, head, [
      CHANGED,
      CALLER,
      BYSTANDER,
    ]);
    const plan0 = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    plan0['cacheCandidatePath'] = candidatePath;
    writeFileSync(planPath, JSON.stringify(plan0));
    run(planPath, anchor);
    expect(process.exitCode ?? 0).toBe(0);
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as {
      fileVerdicts: Record<string, unknown>;
      lastCommitSha: string;
    };
    // ONLY the delta file is certified: it was reviewed in full. The
    // interaction file's brief is seam-only, so no round read the rest of
    // its diff, and the context file was reviewed by no round this rescope
    // can vouch for (no --cache) — both pairs drop, and absence re-reviews
    // them next time.
    expect(Object.keys(candidate.fileVerdicts)).toEqual([CHANGED]);
    // Anchor fields survive untouched.
    expect(candidate.lastCommitSha).toBeDefined();
  });

  it('carries a context pair forward when the previous cache certified that exact pair', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const candidatePath = writeCandidate(base, head, [
      CHANGED,
      CALLER,
      BYSTANDER,
    ]);
    const plan0 = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    plan0['cacheCandidatePath'] = candidatePath;
    writeFileSync(planPath, JSON.stringify(plan0));
    // The previous clean round certified pairs at (base, anchor); the
    // bystander is untouched by the fix, so its pair is identical at head.
    const fv: Record<string, { base: string; head: string }> = {};
    for (const p of [CHANGED, CALLER, BYSTANDER]) {
      const at = (ref: string): string =>
        `100644 ${git('rev-parse', `${ref}:${p}`)}`;
      fv[p] = { base: at(base), head: at(anchor) };
    }
    const cachePath = join(repo, 'prev-cache.json');
    writeFileSync(
      cachePath,
      JSON.stringify({ lastModelId: 'model-a', fileVerdicts: fv }),
    );
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      model: 'model-a',
      maxChunkLines: 400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as {
      fileVerdicts: Record<string, unknown>;
    };
    expect(Object.keys(candidate.fileVerdicts).sort()).toEqual([
      BYSTANDER,
      CALLER,
      CHANGED,
    ]);
  });

  it('an all-delta plan refuses as a mislabeled full review', () => {
    // A one-file PR whose fix touches that same file: delta == plan.
    git('init', '-q', '--template=', '.');
    git('config', 'user.email', 'a@b');
    git('config', 'user.name', 'a');
    git('config', 'commit.gpgsign', 'false');
    write('only.ts', 'export const o = 1;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    write('only.ts', 'export const o = 2;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'pr');
    const anchor = git('rev-parse', 'HEAD');
    write('only.ts', 'export const o = 3;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'fix');
    const head = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head);
    run(planPath, anchor);
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
  });
});

describe('rescope — round-3 findings', () => {
  it('a rename-before-anchor then delete refuses rather than losing the lineage', () => {
    // parseDiff labels a deletion with its LEFT-side path, so the PR diff
    // calls this file `old.ts` while the interdiff calls it `new.ts`; the
    // section carrying its unreviewed hunks matches no scoped name. Dropping
    // it would narrow BELOW the un-widened interdiff floor.
    seedHistory();
    write('packages/app/src/old.ts', 'export const o = 1;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'seed old.ts');
    const base2 = git('rev-parse', 'HEAD');
    git('mv', 'packages/app/src/old.ts', 'packages/app/src/new.ts');
    git('commit', '-q', '--no-verify', '-m', 'round 1 renames it');
    const anchor2 = git('rev-parse', 'HEAD');
    git('rm', '-q', 'packages/app/src/new.ts');
    git('commit', '-q', '--no-verify', '-m', 'fix round deletes it');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base2, head2);
    const before = readFileSync(planPath, 'utf8');
    run(planPath, anchor2);
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('exit 3 when every delta file was restored to its merge-base state', () => {
    const { base, head } = seedHistory();
    // Anchor at the LAST reviewed head, then restore the ONE file this round
    // touches (the bystander, which nobody imports, so the widening adds
    // nothing): the interdiff is non-empty, yet no scoped file carries a
    // section of the PR's own diff. The rest of the PR still does — this is
    // not the empty-diff case.
    const anchor = head;
    write(BYSTANDER, 'export const b = 1;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'restore the bystander');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head2);
    const before = readFileSync(planPath, 'utf8');
    run(planPath, anchor);
    expect(process.exitCode).toBe(RESCOPE_EXIT_NOTHING_NEW);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('the unwritable --out refusal leaves the input plan byte-identical', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const before = readFileSync(planPath, 'utf8');
    const blocked = join(repo, 'blocked-2');
    writeFileSync(blocked, 'a plain file where a directory must go');
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      out: join(blocked, 'nested', 'plan.json'),
      maxChunkLines: 400,
    });
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });
});

describe('rescope — round-3 verdict-layer findings', () => {
  it('interaction files are NOT certified, and the carry-forward needs the same model', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const fv: Record<string, { base: string; head: string }> = {};
    for (const p of [CHANGED, CALLER, BYSTANDER]) {
      const at = (ref: string): string =>
        `100644 ${git('rev-parse', `${ref}:${p}`)}`;
      fv[p] = { base: at(base), head: at(anchor) };
    }
    const candidatePath = join(
      repo,
      '.qwen/tmp/qwen-review-pr-7-cache-candidate.json',
    );
    const writeCandidate = () => {
      const cur: Record<string, { base: string; head: string }> = {};
      for (const p of [CHANGED, CALLER, BYSTANDER]) {
        const at = (ref: string): string =>
          `100644 ${git('rev-parse', `${ref}:${p}`)}`;
        cur[p] = { base: at(base), head: at(head) };
      }
      writeFileSync(
        candidatePath,
        JSON.stringify({ v: 1, target: 'pr-7', fileVerdicts: cur }),
      );
    };
    const plan0 = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    plan0['cacheCandidatePath'] = candidatePath;
    writeFileSync(planPath, JSON.stringify(plan0));
    const cachePath = join(repo, 'prev.json');

    // WRONG model: nothing carries — only the delta file is certified.
    writeCandidate();
    writeFileSync(
      cachePath,
      JSON.stringify({ lastModelId: 'model-b', fileVerdicts: fv }),
    );
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      model: 'model-a',
      maxChunkLines: 400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    let out = JSON.parse(readFileSync(candidatePath, 'utf8')) as {
      fileVerdicts: Record<string, unknown>;
    };
    // CALLER is interaction (seam-only), BYSTANDER is context: neither is
    // certified by this round, and the cross-model cache carries nothing.
    expect(Object.keys(out.fileVerdicts)).toEqual([CHANGED]);

    // RIGHT model, with the bystander's recorded pair MOVED: the union puts
    // it in delta (that is the live-anchor union's whole job), so it is
    // certified as reviewed rather than carried. The carry branch therefore
    // only ever sees pairs that already match — any mismatch reaches it as
    // delta first; the inequality check stays as the belt to that braces.
    process.exitCode = undefined;
    const planPath2 = writeFetchedPlan(base, head);
    const plan1 = JSON.parse(readFileSync(planPath2, 'utf8')) as Record<
      string,
      unknown
    >;
    plan1['cacheCandidatePath'] = candidatePath;
    writeFileSync(planPath2, JSON.stringify(plan1));
    writeCandidate();
    const moved = { ...fv, [BYSTANDER]: { base: 'x', head: 'y' } };
    writeFileSync(
      cachePath,
      JSON.stringify({ lastModelId: 'model-a', fileVerdicts: moved }),
    );
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath2,
      anchor,
      cache: cachePath,
      model: 'model-a',
      maxChunkLines: 400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    out = JSON.parse(readFileSync(candidatePath, 'utf8')) as {
      fileVerdicts: Record<string, unknown>;
    };
    // changed.ts + the pair-moved bystander are delta (certified); caller
    // carries on its unchanged recorded pair.
    expect(Object.keys(out.fileVerdicts).sort()).toEqual([
      BYSTANDER,
      CALLER,
      CHANGED,
    ]);
  });

  it('an unreadable candidate is removed AND unannounced in the plan', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const candidatePath = join(repo, 'broken-candidate.json');
    writeFileSync(candidatePath, 'not json at all');
    const plan0 = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    plan0['cacheCandidatePath'] = candidatePath;
    writeFileSync(planPath, JSON.stringify(plan0));
    run(planPath, anchor);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    // Fail-closed both ways: nothing left on disk, nothing named in the plan.
    expect('cacheCandidatePath' in plan).toBe(false);
    expect(existsSync(candidatePath)).toBe(false);
  });

  it('unions verdicts into a NON-empty interdiff, not just an empty one', () => {
    const { base, anchor } = seedHistory();
    // Round 2 changes changed.ts (interdiff non-empty) while the merge base
    // slides under the bystander — only the pairs can see the second one.
    const fv: Record<string, { base: string; head: string }> = {};
    for (const p of [CHANGED, CALLER, BYSTANDER]) {
      const at = (ref: string): string =>
        `100644 ${git('rev-parse', `${ref}:${p}`)}`;
      fv[p] = { base: at(base), head: at(anchor) };
    }
    git('checkout', '-q', base);
    write(BYSTANDER, 'export const b = 0; // upstream moved this\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'moved base');
    const base2 = git('rev-parse', 'HEAD');
    git('checkout', '-q', anchor);
    write(CHANGED, 'export const v = 9;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'round 2 fix');
    const head2 = git('rev-parse', 'HEAD');
    const cachePath = join(repo, 'cache.json');
    writeFileSync(
      cachePath,
      JSON.stringify({
        lastModelId: 'model-a',
        lastCommitSha: anchor,
        fileVerdicts: fv,
      }),
    );
    const planPath = writeFetchedPlan(base2, head2);
    (rescopeCommand.handler as (argv: unknown) => void)({
      plan: planPath,
      anchor,
      cache: cachePath,
      model: 'model-a',
      maxChunkLines: 400,
    });
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    // The interdiff contributes changed.ts; the pairs contribute the
    // base-shifted bystander. A fallback-only design would miss the second.
    expect(plan.incremental.deltaFiles.sort()).toEqual([BYSTANDER, CHANGED]);
  });
});

describe('rescope — round-5/6 findings', () => {
  it('a RESTORED importer still gets a reader when what it imports keeps changing', () => {
    // R6-10: the restored file has no PR-diff section (nothing left to
    // review in it) but its imports of a still-changing file are live seams
    // — judged after the fact it fell between both reader classes and got
    // zero readers.
    const { base } = seedHistory();
    // Round 1 (anchor) changed both; the fix round REVERTS caller.ts to its
    // merge-base content and changes changed.ts again.
    const anchor = git('rev-parse', 'HEAD');
    write(CALLER, "import { v } from './changed.js';\nexport const c = v;\n");
    write(CHANGED, 'export const v = 9;\n');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'revert caller, change callee');
    const head2 = git('rev-parse', 'HEAD');
    const planPath = writeFetchedPlan(base, head2);
    run(planPath, anchor);
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    expect(plan.incremental.deltaFiles).toEqual([CHANGED]);
    expect(plan.incremental.interaction.map((e) => e.path)).toContain(CALLER);
  });

  it('a plan naming a symbolic ref instead of a sha refuses', () => {
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const plan0 = JSON.parse(readFileSync(planPath, 'utf8')) as Record<
      string,
      unknown
    >;
    plan0['fetchedSha'] = 'HEAD';
    writeFileSync(planPath, JSON.stringify(plan0));
    const before = readFileSync(planPath, 'utf8');
    run(planPath, anchor);
    expect(process.exitCode).toBe(RESCOPE_EXIT_FULL_RANGE);
    expect(readFileSync(planPath, 'utf8')).toBe(before);
  });

  it('a dead stdout after the plan write does not turn exit 0 into exit 1', () => {
    // "Only exit 0 rewrites the plan" needs its contrapositive: a non-zero
    // exit must mean the plan is untouched, so nothing past the write may
    // throw (EPIPE from `qwen … | head`).
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    try {
      expect(() => run(planPath, anchor)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(process.exitCode ?? 0).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    expect(plan.incremental.deltaFiles).toEqual([CHANGED]);
  });
});

describe('rescope — round-6/7 Criticals', () => {
  it.skipIf(process.platform === 'win32')(
    'a content-revert that KEEPS chmod +x is not "restored" — the mode change is scope',
    () => {
      // `rev-parse <ref>:<path>` yields the blob alone, so a revert that
      // keeps the exec bit compared equal and was dropped — yet its
      // mode-only section IS in the PR's own diff, so the incremental scope
      // narrowed below the full-range floor and exited 3 over a real change.
      const { base } = seedHistory();
      const anchor = git('rev-parse', 'HEAD');
      write(CHANGED, 'export const v = 1;\n'); // content back to base
      // A REAL exec bit on disk: `update-index --chmod` alone is undone by a
      // later `commit -a`, which re-stages from the worktree.
      execFileSync('chmod', ['+x', join(repo, CHANGED)]);
      git('add', '-A');
      git('commit', '-q', '--no-verify', '-m', 'revert content, keep +x');
      const head2 = git('rev-parse', 'HEAD');
      const planPath = writeFetchedPlan(base, head2);
      run(planPath, anchor);
      expect(process.exitCode ?? 0).toBe(0);
      const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
      expect(plan.incremental.deltaFiles).toContain(CHANGED);
      expect(readFileSync(join(repo, plan.diffPath), 'utf8')).toContain(
        'new mode 100755',
      );
    },
  );

  it('an ASYNC stdout error after the plan write still exits 0', () => {
    // EPIPE reaches the process as an unhandled 'error' EVENT, which no
    // try/catch around the write can intercept; unhandled, it exits 1 over
    // an already-rewritten plan.
    const { base, anchor, head } = seedHistory();
    const planPath = writeFetchedPlan(base, head);
    run(planPath, anchor);
    expect(process.exitCode ?? 0).toBe(0);
    // The listener the command installs is what makes the async shape inert.
    expect(process.stdout.listenerCount('error')).toBeGreaterThan(0);
    expect(process.stderr.listenerCount('error')).toBeGreaterThan(0);
    expect(() =>
      process.stdout.emit('error', new Error('EPIPE')),
    ).not.toThrow();
    expect(() =>
      process.stderr.emit('error', new Error('EPIPE')),
    ).not.toThrow();
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as RescopedPlan;
    expect(plan.incremental.deltaFiles).toEqual([CHANGED]);
  });
});
