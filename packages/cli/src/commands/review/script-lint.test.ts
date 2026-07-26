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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'script-lint-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
  it('skips a file whose linter is not installed, and says so (not clean)', () => {
    // actionlint / hadolint are not installed in CI here; a workflow file must be
    // reported as skipped, never as a clean pass.
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      [{ newStart: 1, newEnd: 3 }],
    );
    const r = runScriptLint({ plan, worktree });
    if (r.checked.some((c) => c.tool === 'actionlint')) {
      // actionlint IS installed on this machine — then it was checked, fine.
      expect(r.skipped).toEqual([]);
    } else {
      expect(r.skipped).toHaveLength(1);
      expect(r.skipped[0].tool).toBe('actionlint');
      expect(r.skipped[0].reason).toContain('not installed');
      expect(r.note).toContain('not installed');
    }
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
