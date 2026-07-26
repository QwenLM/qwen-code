/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The gated tests in script-lint.test.ts need a real `shellcheck` and never run
// actionlint/hadolint (not installed in CI). These inject a fake tool runner so
// all three linters' JSON normalisation, the fail-closed paths (a checker that
// errors is not a clean file), and the context-line classification are pinned
// with no binary present.

import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runScriptLint,
  type ToolRun,
  type ToolRunner,
  type LintTool,
} from './script-lint.js';

let dir: string;
function fresh() {
  dir = mkdtempSync(join(tmpdir(), 'script-lint-mock-'));
}
function clean() {
  rmSync(dir, { recursive: true, force: true });
}

/** A runner that returns the same canned result for whichever tool is asked. */
function fixedRunner(res: ToolRun): ToolRunner {
  return () => res;
}
/** A runner that returns shellcheck-style json1 findings on the given lines. */
function shellcheckRunner(
  comments: Array<{ line: number; code: number; level: string }>,
): ToolRunner {
  return (tool: LintTool): ToolRun =>
    tool === 'shellcheck'
      ? {
          kind: 'ok',
          stdout: JSON.stringify({
            comments: comments.map((c) => ({ ...c, message: 'msg' })),
          }),
        }
      : { kind: 'missing' };
}

/** Write a worktree file + a plan pointing at it with the given plan fields. */
function setup(
  path: string,
  content: string,
  extra: Record<string, unknown> = {},
): { plan: string; worktree: string } {
  const abs = join(dir, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  const planPath = join(dir, 'plan.json');
  writeFileSync(
    planPath,
    JSON.stringify({ files: [{ path, kind: 'source', ...extra }] }),
  );
  return { plan: planPath, worktree: dir };
}

describe('runScriptLint — tool JSON normalisation (injected runner)', () => {
  it('normalises actionlint output and blocks on a changed-line finding', () => {
    fresh();
    const runner = fixedRunner({
      kind: 'ok',
      stdout: JSON.stringify([
        {
          message: 'shellcheck SC2086',
          line: 8,
          column: 9,
          kind: 'shellcheck',
        },
      ]),
    });
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      { hunks: [{ newStart: 8, newEnd: 8 }] },
    );
    const r = runScriptLint({ plan, worktree }, runner);
    expect(r.checked[0].tool).toBe('actionlint');
    expect(r.checked[0].findings[0]).toMatchObject({ line: 8, inDiff: true });
    expect(r.ok).toBe(false);
    clean();
  });

  it('normalises hadolint output (code + level preserved)', () => {
    fresh();
    const runner = fixedRunner({
      kind: 'ok',
      stdout: JSON.stringify([
        { line: 3, code: 'DL3006', level: 'warning', message: 'tag the image' },
      ]),
    });
    const { plan, worktree } = setup(
      'Dockerfile',
      'FROM alpine\nRUN echo hi\n',
      {
        hunks: [{ newStart: 3, newEnd: 3 }],
      },
    );
    const r = runScriptLint({ plan, worktree }, runner);
    expect(r.checked[0].tool).toBe('hadolint');
    expect(r.checked[0].findings[0]).toMatchObject({
      code: 'DL3006',
      level: 'warning',
      line: 3,
      inDiff: true,
    });
    expect(r.ok).toBe(false);
    clean();
  });

  it('normalises shellcheck json1 (SC-prefixed code, info blocks)', () => {
    fresh();
    const { plan, worktree } = setup('x.sh', '#!/bin/bash\nrm $X\n', {
      hunks: [{ newStart: 2, newEnd: 2 }],
    });
    const r = runScriptLint(
      { plan, worktree },
      shellcheckRunner([{ line: 2, code: 2086, level: 'info' }]),
    );
    expect(r.checked[0].findings[0]).toMatchObject({
      code: 'SC2086',
      level: 'info',
      inDiff: true,
    });
    expect(r.ok).toBe(false);
    clean();
  });
});

describe('runScriptLint — fail closed (a crashed checker is not clean)', () => {
  it.each([
    [
      'a spawn error (EACCES)',
      { kind: 'error', reason: 'shellcheck failed to run: EACCES' },
    ],
    ['a signal', { kind: 'error', reason: 'shellcheck was killed by SIGKILL' }],
    [
      'an unexpected status',
      { kind: 'error', reason: 'shellcheck exited 2: boom' },
    ],
  ] as Array<[string, ToolRun]>)(
    'reports %s as errored, not ok',
    (_label, res) => {
      fresh();
      const { plan, worktree } = setup('x.sh', '#!/bin/bash\nrm $X\n', {
        hunks: [{ newStart: 2, newEnd: 2 }],
      });
      const r = runScriptLint({ plan, worktree }, fixedRunner(res));
      expect(r.checked).toEqual([]);
      expect(r.errored).toHaveLength(1);
      expect(r.errored[0].tool).toBe('shellcheck');
      expect(r.ok).toBe(false);
      expect(r.note).toContain('failed to lint');
      clean();
    },
  );
});

describe('runScriptLint — inDiff uses added lines, not hunk context', () => {
  it('does NOT block on a finding that lands on a context line', () => {
    fresh();
    // The diff ADDS line 4 (`echo new`); line 3 (`rm $X`) is unchanged context
    // inside the same hunk. A pre-existing SC2086 on line 3 must not be this PR's.
    const diff = [
      'diff --git a/x.sh b/x.sh',
      'index 1111111..2222222 100644',
      '--- a/x.sh',
      '+++ b/x.sh',
      '@@ -1,4 +1,5 @@',
      ' #!/bin/bash',
      ' set -e',
      ' rm $X',
      '+echo new',
      ' echo done',
      '',
    ].join('\n');
    const diffPath = join(dir, 'pr.diff');
    writeFileSync(diffPath, diff);
    const { plan, worktree } = setup(
      'x.sh',
      '#!/bin/bash\nset -e\nrm $X\necho new\necho done\n',
      { hunks: [{ newStart: 1, newEnd: 5 }] }, // context-inclusive hunk
    );
    const planObj = JSON.parse(readFileSync(plan, 'utf8'));
    planObj.diffPathAbsolute = diffPath;
    writeFileSync(plan, JSON.stringify(planObj));

    const r = runScriptLint(
      { plan, worktree },
      shellcheckRunner([{ line: 3, code: 2086, level: 'info' }]),
    );
    const sc = r.checked[0].findings.find((f) => f.code === 'SC2086');
    expect(sc).toBeDefined();
    expect(sc!.line).toBe(3);
    expect(sc!.inDiff).toBe(false); // line 3 is context, not an added line
    expect(r.ok).toBe(true);
    clean();
  });
});
