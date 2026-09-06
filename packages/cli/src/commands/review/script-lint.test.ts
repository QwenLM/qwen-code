/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The point of this command is that a shell bug in a diff is caught by *running*
// the checker, not by asking a model to read the YAML — measured, a model told
// in prose to "run the workflow scripts" reads instead (0/4 executed). So the
// engine is deterministic, and these tests pin it: shellcheck's finding on a
// changed line is reported and blocks; the same finding on an unchanged line is
// disclosed but does not; a linter that is not installed is skipped, not clean.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScriptLint, toolFor } from './script-lint.js';

const hasShellcheck = (() => {
  try {
    execFileSync('shellcheck', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
// Extra temp dirs a test makes for itself (a symlink worktree, say). Tracked and
// torn down in `afterEach` so a failing `expect` — which throws before an inline
// `rmSync` — cannot leak one; the hook runs regardless.
let extraDirs: string[];
/** mkdtemp a dir that `afterEach` will always clean, even if the test throws. */
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  extraDirs.push(d);
  return d;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'script-lint-'));
  extraDirs = [];
});
afterEach(() => {
  for (const d of [dir, ...extraDirs]) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** Write the worktree file and a plan pointing at it with the given hunk ranges. */
function setup(
  path: string,
  content: string,
  hunks: Array<{ newStart: number; newEnd: number }>,
): { plan: string; worktree: string } {
  const abs = join(dir, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  const planPath = join(dir, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({ files: [{ path, kind: 'source', hunks }] }),
  );
  return { plan: planPath, worktree: dir };
}

describe('toolFor — dispatch by file type, not by GitHub', () => {
  it.each([
    ['.github/workflows/ci.yml', '', 'actionlint'],
    // The long `.yaml` workflow spelling — GitHub accepts both.
    ['.github/workflows/ci.yaml', '', 'actionlint'],
    // The directory alone must not route: a non-YAML file under
    // .github/workflows/ is not a workflow (pins the suffix conjunct).
    ['.github/workflows/README.md', '', null],
    // A stemless `.yml` dotfile in a NESTED workflows/ directory is
    // deliberately unrouted — the pathTool comment names the divergence.
    ['.github/workflows/nested/.yml', '', null],
    ['deploy.sh', '', 'shellcheck'],
    ['scripts/build.bash', '', 'shellcheck'],
    ['Dockerfile', '', 'hadolint'],
    ['docker/api.Dockerfile', '', 'hadolint'],
    // Extensionless script, decided by its shebang — a git hook, a CI helper.
    ['.husky/pre-commit', '#!/usr/bin/env bash', 'shellcheck'],
    ['hooks/prepush', '#!/bin/sh', 'shellcheck'],
  ] as const)('%s -> %s', (path, firstLine, tool) => {
    expect(toolFor(path, firstLine)).toBe(tool);
  });

  it('leaves non-executable files alone', () => {
    expect(toolFor('src/index.ts', 'export const x = 1;')).toBeNull();
    expect(toolFor('README.md', '# Title')).toBeNull();
    expect(toolFor('config.yml', 'key: value')).toBeNull(); // yaml, but not a workflow
  });
});

describe.skipIf(!hasShellcheck)(
  'runScriptLint — shellcheck on a changed line',
  () => {
    // A shell script with an SC2086 (unquoted `$X` word-splits) on line 3.
    const SCRIPT = [
      '#!/usr/bin/env bash',
      'set -e',
      'rm $TARGET',
      'echo finished',
      '',
    ].join('\n');

    it('reports the finding on a changed line and blocks (ok=false)', () => {
      const { plan, worktree } = setup('clean.sh', SCRIPT, [
        { newStart: 3, newEnd: 3 }, // the `rm $TARGET` line is in the diff
      ]);
      const r = runScriptLint({ plan, worktree });
      expect(r.checked).toHaveLength(1);
      expect(r.checked[0].tool).toBe('shellcheck');
      const sc2086 = r.checked[0].findings.find((f) => f.code === 'SC2086');
      expect(sc2086).toBeDefined();
      expect(sc2086!.line).toBe(3);
      expect(sc2086!.inDiff).toBe(true);
      expect(r.ok).toBe(false);
    });

    it('discloses the same finding on an unchanged line but does NOT block', () => {
      // The buggy line is line 3, but the diff only touched line 4.
      const { plan, worktree } = setup('clean.sh', SCRIPT, [
        { newStart: 4, newEnd: 4 },
      ]);
      const r = runScriptLint({ plan, worktree });
      const sc2086 = r.checked[0].findings.find((f) => f.code === 'SC2086');
      expect(sc2086).toBeDefined();
      expect(sc2086!.inDiff).toBe(false); // pre-existing — not this PR's fault
      expect(r.ok).toBe(true);
    });

    it('is clean on a well-quoted script', () => {
      const good = ['#!/usr/bin/env bash', 'set -e', 'rm "$TARGET"', ''].join(
        '\n',
      );
      const { plan, worktree } = setup('ok.sh', good, [
        { newStart: 3, newEnd: 3 },
      ]);
      const r = runScriptLint({ plan, worktree });
      expect(r.checked[0].findings.filter((f) => f.inDiff)).toEqual([]);
      expect(r.ok).toBe(true);
    });
  },
);

describe('runScriptLint — graceful degradation and scoping', () => {
  it('defers a workflow to skipped — actionlint source-mapping is not yet supported', () => {
    // A workflow is never certified from actionlint findings: its JSON anchors at
    // the `run:` key line and flattens ShellCheck severity, so a wrong line/level
    // would create false blockers. Until that is parsed and verified, the file is
    // reported as skipped (unreviewed), never as a clean pass — and never run.
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      [{ newStart: 1, newEnd: 3 }],
    );
    const r = runScriptLint({ plan, worktree });
    expect(r.checked).toEqual([]);
    // actionlint is DEFERRED (a tool limitation), not skipped — the distinction
    // matters: deferred is disclosed but does NOT cap the verdict, so a
    // workflow-only PR is not made un-Approvable.
    expect(r.skipped).toEqual([]);
    expect(r.deferred).toHaveLength(1);
    expect(r.deferred[0].tool).toBe('actionlint');
    expect(r.deferred[0].reason).toContain('not yet supported');
    // The reason must not restate "not linted" — the body renders it under a
    // wrapper that already opens with "Not linted:", and a tail here posted
    // the phrase twice in one sentence (#10567's posted body).
    expect(r.deferred[0].reason).not.toContain('not linted');
    // The Chinese half of that wrapper sentence renders `reasonZh` — without
    // it the 中文说明 block carried the English reason verbatim. Pinned to the
    // literal: a `toContain('actionlint')` fragment was satisfied by the
    // ENGLISH reason too, so the exact defect this field exists to fix — an
    // English string posing as the Chinese half — shipped green under it.
    expect(r.deferred[0].reasonZh).toBe(
      'actionlint 对 workflow 内嵌 shell 的源映射尚未支持',
    );
    expect(r.ok).toBe(true);
  });

  it('records a symlinked script as skipped, never dropped (empty ≠ clean)', () => {
    // A `hook.sh` that is a symlink is lint-owed by name but not a regular file;
    // it must not vanish from the report, or an empty report reads as a clean pass.
    const dirLocal = tmpDir('script-lint-sym-'); // cleaned in afterEach, leak-proof
    writeFileSync(join(dirLocal, 'real.txt'), 'data\n');
    symlinkSync(join(dirLocal, 'real.txt'), join(dirLocal, 'hook.sh'));
    const planPath = join(dirLocal, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({ files: [{ path: 'hook.sh', kind: 'source' }] }),
    );
    const r = runScriptLint({ plan: planPath, worktree: dirLocal });
    expect(r.checked).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].tool).toBe('shellcheck');
    expect(r.skipped[0].reason).toContain('not a regular file');
    // The body renders this under "Not reviewed:" — a "not linted" tail here
    // posted the phrase twice in one sentence (the deferred reason's pin
    // above guards its own copy; this guards the skipped one).
    expect(r.skipped[0].reason).not.toContain('not linted');
  });

  it('checks nothing when no executable file changed', () => {
    const { plan, worktree } = setup('src/a.ts', 'const x = 1;\n', [
      { newStart: 1, newEnd: 1 },
    ]);
    const r = runScriptLint({ plan, worktree });
    expect(r.checked).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.note).toContain('No executable scripts');
  });
});
