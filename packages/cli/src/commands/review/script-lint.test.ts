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

const hasActionlint = (() => {
  try {
    execFileSync('actionlint', ['-version'], { stdio: 'ignore' });
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

describe.skipIf(!hasActionlint)(
  'runScriptLint — actionlint workflow-level checks (real binary)',
  () => {
    // The #15974 regression: `runner` context in `jobs.<id>.env` makes GitHub
    // refuse to load the workflow AT ALL (zero jobs ever run). actionlint
    // catches this at the YAML/expression level — no embedded-shell source
    // mapping involved — so the old whole-file deferral let a workflow that
    // cannot execute sail through as "disclosed, not blocking". The check now
    // runs and gates; only the embedded `run:` shell stays deferred.
    const UNLOADABLE = [
      'name: CI',
      'on: pull_request',
      'jobs:',
      '  lint:',
      '    runs-on: ubuntu-latest',
      '    env:',
      '      HOME: ${{ runner.temp }}/home',
      '    steps:',
      '      - run: echo hi',
      '',
    ].join('\n');

    it('blocks on a workflow GitHub cannot load (runner context in jobs.env)', () => {
      const { plan, worktree } = setup('.github/workflows/ci.yml', UNLOADABLE, [
        { newStart: 7, newEnd: 7 }, // the `HOME: ${{ runner.temp }}` line
      ]);
      const r = runScriptLint({ plan, worktree });
      expect(r.checked).toHaveLength(1);
      expect(r.checked[0].tool).toBe('actionlint');
      const expr = r.checked[0].findings.find((f) => f.code === 'expression');
      expect(expr).toBeDefined();
      expect(expr!.line).toBe(7);
      expect(expr!.level).toBe('error');
      expect(expr!.message).toContain('runner');
      expect(expr!.inDiff).toBe(true);
      expect(r.ok).toBe(false);
      // The embedded shell portion is STILL deferred — the file appears in
      // both channels: checked (workflow-level) and deferred (shell portion).
      expect(r.deferred).toHaveLength(1);
      expect(r.deferred[0].tool).toBe('actionlint');
      expect(r.deferred[0].reason).toContain('ran workflow-level checks');
      expect(r.deferred[0].reason).not.toContain('not linted');
      expect(r.deferred[0].reasonZh).toBe(
        'actionlint 已运行 workflow 级检查；内嵌 run: shell 延迟处理（源映射尚未支持）',
      );
    });

    it('a clean workflow passes, with the shell deferral still disclosed', () => {
      const clean = [
        'name: CI',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo ok',
        '',
      ].join('\n');
      const { plan, worktree } = setup('.github/workflows/ci.yml', clean, [
        { newStart: 1, newEnd: 7 },
      ]);
      const r = runScriptLint({ plan, worktree });
      expect(r.checked).toHaveLength(1);
      expect(r.checked[0].findings).toEqual([]);
      expect(r.ok).toBe(true);
      // The disclosure survives a clean run: the shell portion was never
      // linted (integrations disabled), findings or not.
      expect(r.deferred).toHaveLength(1);
    });
  },
);

describe('runScriptLint — graceful degradation and scoping', () => {
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
