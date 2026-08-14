/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The local review-fix loop, end to end against real git: round 1 captures
// full and writes a content-anchor candidate; the candidate promoted to a
// cache scopes round 2 to what changed since — same model, same HEAD — with
// one import hop of dependents; and every gate (model, HEAD, malformed cache)
// degrades to the FULL capture with the reason said out loud, never to a skip.

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
import { captureLocalCommand } from './capture-local.js';
import { isolateHostGitConfig } from './lib/test-utils.js';
import type { IncrementalScope } from './lib/incremental.js';

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
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-loc-inc-')));
  cwd = process.cwd();
  process.chdir(repo);
  gitIsolation = isolateHostGitConfig();
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'a@b');
  git('config', 'user.name', 'a');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

const CHANGED = 'src/changed.ts';
const CALLER = 'src/caller.ts';
const BYSTANDER = 'src/bystander.ts';

/** Commit a baseline, then dirty all three files — round 1's working state. */
function seedDirtyTree(): void {
  // Real repos gitignore `.qwen/` (Step 8 checks exactly that); the fixture
  // must too, or the cache file and the plan output masquerade as untracked
  // review scope.
  write('.gitignore', '.qwen/\nplan.json\n');
  write(CHANGED, 'export const v = 0;\n');
  write(CALLER, "import { v } from './changed.js';\nexport const c = v;\n");
  write(BYSTANDER, 'export const b = 0;\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'base');
  write(CHANGED, 'export const v = 1;\n');
  write(CALLER, "import { v } from './changed.js';\nexport const c = v + 1;\n");
  write(BYSTANDER, 'export const b = 1;\n');
}

type Plan = Record<string, unknown> & {
  chunks: Array<{ id: number }>;
  files: Array<{ path: string }>;
  incremental?: IncrementalScope;
  cacheCandidatePath: string;
  diffPath: string;
};

function capture(extra: Record<string, unknown> = {}): Plan {
  const out = join(repo, 'plan.json');
  (captureLocalCommand.handler as (argv: unknown) => void)({
    out,
    target: 'local',
    untracked: true,
    ...extra,
  });
  return JSON.parse(readFileSync(out, 'utf8')) as Plan;
}

/** What Step 8 does on a clean high-effort end: candidate + ledger → cache. */
function promoteCandidate(plan: Plan, model: string): string {
  const candidate = JSON.parse(
    readFileSync(plan.cacheCandidatePath, 'utf8'),
  ) as Record<string, unknown>;
  const cachePath = join(repo, '.qwen/review-cache/local.json');
  mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
  writeFileSync(
    cachePath,
    JSON.stringify({ ...candidate, lastModelId: model }),
  );
  return cachePath;
}

describe('capture-local — incremental local rounds', () => {
  it('round 1 writes a candidate covering every captured file', () => {
    seedDirtyTree();
    const plan = capture();
    expect(plan.incremental).toBeUndefined();
    const candidate = JSON.parse(
      readFileSync(plan.cacheCandidatePath, 'utf8'),
    ) as { files: Record<string, string>; headSha: string | null };
    expect(Object.keys(candidate.files).sort()).toEqual([
      BYSTANDER,
      CALLER,
      CHANGED,
    ]);
    expect(candidate.headSha).toBe(git('rev-parse', 'HEAD'));
  });

  it('round 2 scopes to the changed file plus its importer; the bystander is out', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');

    write(CHANGED, 'export const v = 2;\n'); // the fix
    const plan = capture({ cache: cachePath, model: 'model-a' });

    expect(plan.incremental).toBeDefined();
    expect(plan.incremental!.deltaFiles).toEqual([CHANGED]);
    expect(plan.incremental!.interaction).toEqual([
      { path: CALLER, importsChanged: [CHANGED] },
    ]);
    expect(plan.incremental!.contextFileCount).toBe(1);
    expect(plan.files.map((f) => f.path).sort()).toEqual([CALLER, CHANGED]);

    const diff = readFileSync(join(repo, plan.diffPath), 'utf8');
    expect(diff).toContain('+export const v = 2;');
    expect(diff).toContain('caller.ts');
    expect(diff).not.toContain('bystander');
    // The full capture is preserved beside the scoped one.
    expect(readFileSync(plan.incremental!.fullDiffPath!, 'utf8')).toContain(
      'bystander',
    );
  });

  it('an identical state under the same model and HEAD yields 0 chunks and says so', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental!.deltaFiles).toEqual([]);
    expect(plan.chunks).toEqual([]);
  });

  it('a different model degrades to the full capture', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    write(CHANGED, 'export const v = 2;\n');
    const plan = capture({ cache: cachePath, model: 'model-b' });
    expect(plan.incremental).toBeUndefined();
    expect(plan.files.map((f) => f.path).sort()).toEqual([
      BYSTANDER,
      CALLER,
      CHANGED,
    ]);
  });

  it('a moved HEAD degrades to the full capture', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'user committed the changes');
    write(CHANGED, 'export const v = 2;\n');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental).toBeUndefined();
  });

  it('a malformed cache and a missing --model both degrade to the full capture', () => {
    seedDirtyTree();
    const cachePath = join(repo, '.qwen/review-cache/local.json');
    mkdirSync(join(repo, '.qwen/review-cache'), { recursive: true });
    writeFileSync(cachePath, 'not json');
    expect(
      capture({ cache: cachePath, model: 'm' }).incremental,
    ).toBeUndefined();

    const good = promoteCandidate(capture(), 'model-a');
    expect(capture({ cache: good }).incremental).toBeUndefined();
  });

  it('a brand-new untracked file since the last round is delta, not skipped', () => {
    seedDirtyTree();
    const cachePath = promoteCandidate(capture(), 'model-a');
    write('src/new-untracked.ts', 'export const n = 1;\n');
    const plan = capture({ cache: cachePath, model: 'model-a' });
    expect(plan.incremental!.deltaFiles).toEqual(['src/new-untracked.ts']);
    const diff = readFileSync(join(repo, plan.diffPath), 'utf8');
    expect(diff).toContain('new-untracked');
    expect(diff).not.toContain('bystander');
  });
});
