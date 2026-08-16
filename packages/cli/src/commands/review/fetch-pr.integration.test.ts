/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Drives the containment oracle against captures REAL git produced, on a real
// three-commit history, under the flags `fetch-pr` actually pins.
//
// The oracle's unit fixtures are hand-written diffs, and a hand-written diff
// encodes what its author believed git emits. The defect this file exists for
// was invisible to every one of them: under `--unified=3` a deletion arrives
// wrapped in context, so the hunk is not `newCount === 0` and its surviving
// new-side range is just that context — which the covering hunk contains for
// free. Only a capture git chose the hunk boundaries for shows that shape.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containmentRuling } from './fetch-pr.js';
import { PINNED_DIFF_CONFIG, PINNED_DIFF_FLAGS } from './lib/diff-flags.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

let repo: string;
let env: NodeJS.ProcessEnv;
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', env });

/** Capture exactly as `fetch-pr` does. */
const capture = (from: string, to: string) =>
  execFileSync(
    'git',
    [...PINNED_DIFF_CONFIG, 'diff', ...PINNED_DIFF_FLAGS, from, to],
    { cwd: repo, maxBuffer: 1 << 28, env },
  ).toString('utf8');

const baseLines = Array.from(
  { length: 30 },
  (_, i) => `L${String(i + 1).padStart(2, '0')}`,
);

const commit = (file: string, lines: string[], msg: string) => {
  writeFileSync(join(repo, file), lines.join('\n') + '\n');
  git('add', '-A');
  git('commit', '-qm', msg, '--no-verify');
  return git('rev-parse', 'HEAD').trim();
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'fetch-pr-it-'));
  gitIsolation = isolateHostGitConfig();
  env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  git('init', '-q', '--template=', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  gitIsolation.dispose();
});

describe('containmentRuling on real-git captures', () => {
  it('refuses a delta that deletes lines the PR diff never displays', () => {
    // The "undo per feedback" round. Round 1 landed two edits and three extra
    // lines; the next round takes the three lines back out. Those lines stood
    // at neither the merge base nor the head, so the PR's own diff mentions
    // them on neither side — yet the delta's only content is their removal.
    const base = commit('undo.ts', baseLines, 'base');

    const anchor = [...baseLines];
    anchor[4] = 'L05-MOD';
    anchor[11] = 'L12-MOD';
    anchor.splice(8, 0, 'X1', 'X2', 'X3');
    const round1 = commit('undo.ts', anchor, 'round 1');

    const head = [...baseLines];
    head[4] = 'L05-MOD';
    head[11] = 'L12-MOD';
    const headSha = commit('undo.ts', head, 'undo per feedback');

    const delta = capture(round1, headSha);
    const full = capture(base, headSha);

    // The shape that defeats a range-only rule: git wrapped the deletion in
    // context, so the delta hunk's new-side range sits INSIDE the full
    // capture's — while the deleted text appears nowhere in the full capture.
    expect(delta).toContain('-X1');
    expect(full).not.toContain('X1');
    expect(delta).toContain('@@ -6,9 +6,6 @@'); // new side [6, 11]
    expect(full).toContain('@@ -2,14 +2,14 @@'); // new side [2, 15] — covers it

    expect(containmentRuling(delta, full)).toEqual({
      ok: false,
      unverified: false,
    });
  });

  it('accepts a delta whose deletion the PR diff performs too', () => {
    // The control that keeps the rule from being "refuse every deletion":
    // these lines stood at the merge base, so the PR deletes them as well and
    // GitHub displays them.
    const base = commit('shared.ts', baseLines, 'shared base');

    const anchor = [...baseLines];
    anchor[4] = 'L05-MOD';
    const round1 = commit('shared.ts', anchor, 'shared round 1');

    const head = [...anchor];
    head.splice(19, 3); // L20..L22, all present at the base
    const headSha = commit('shared.ts', head, 'shared head');

    const delta = capture(round1, headSha);
    const full = capture(base, headSha);

    expect(delta).toContain('-L20');
    expect(full).toContain('-L20');

    expect(containmentRuling(delta, full)).toEqual({
      ok: true,
      unverified: false,
    });
  });
});
