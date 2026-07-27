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

import { describe, it, expect, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  runScriptLint,
  buildToolInvocation,
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
  it('defers a workflow to its own `deferred` state without ever running actionlint', () => {
    fresh();
    // The runner would report findings, but a workflow is deferred BEFORE it runs
    // (actionlint's source-mapping is not yet parsed), so it lands in skipped, not
    // checked — and the runner is never even called for it.
    const runner = vi.fn(() => {
      throw new Error('runner must not be called for a deferred workflow');
    });
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      { hunks: [{ newStart: 8, newEnd: 8 }] },
    );
    const r = runScriptLint({ plan, worktree }, runner);
    expect(r.checked).toEqual([]);
    // deferred (a tool limitation), not skipped — and the runner was never called.
    expect(r.deferred[0].tool).toBe('actionlint');
    expect(r.deferred[0].reason).toContain('not yet supported');
    expect(r.skipped).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
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

  it('treats non-empty UNPARSEABLE output as errored, not a clean file', () => {
    // A runner that "succeeded" but printed junk before/instead of JSON — a
    // version skew, a deprecation notice. Fail closed, do not record `checked`.
    fresh();
    const { plan, worktree } = setup('x.sh', '#!/bin/bash\nrm $X\n', {
      hunks: [{ newStart: 2, newEnd: 2 }],
    });
    const r = runScriptLint(
      { plan, worktree },
      fixedRunner({ kind: 'ok', stdout: 'Warning: deprecated\nnot json' }),
    );
    expect(r.checked).toEqual([]);
    expect(r.errored).toHaveLength(1);
    expect(r.errored[0].reason).toContain('unparseable');
    expect(r.ok).toBe(false);
    clean();
  });
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

describe('runScriptLint — the report is bound to the diff it ran against', () => {
  it('stamps the report with a sha256 of the plan diff (the freshness key)', () => {
    fresh();
    // This is the headline of the staleness guard: the report carries a hash of the
    // diff it reviewed, so `compose-review` can re-hash the plan's current diff and
    // reject a stale report. Content, not HEAD — correct for a PR and for local
    // uncommitted work alike. Drop the stamp and this fails; a stale report would
    // then certify new code.
    const diff = 'diff --git a/x.sh b/x.sh\n@@ -0,0 +1 @@\n+rm $X\n';
    const diffPath = join(dir, 'pr.diff');
    writeFileSync(diffPath, diff);
    const { plan, worktree } = setup('x.sh', '#!/bin/bash\nrm $X\n', {
      hunks: [{ newStart: 1, newEnd: 1 }],
    });
    const planObj = JSON.parse(readFileSync(plan, 'utf8'));
    planObj.diffPathAbsolute = diffPath;
    writeFileSync(plan, JSON.stringify(planObj));

    const r = runScriptLint(
      { plan, worktree },
      shellcheckRunner([{ line: 1, code: 2086, level: 'info' }]),
    );
    const expected = createHash('sha256')
      .update(readFileSync(diffPath))
      .digest('hex');
    expect(r.diffHash).toBe(expected);
    clean();
  });

  it('leaves diffHash undefined when the plan carries no readable diff', () => {
    fresh();
    // No `diffPathAbsolute` on the plan → nothing to hash. `compose-review` treats an
    // absent hash as unverifiable and fails closed, so undefined is the honest value.
    const { plan, worktree } = setup('x.sh', '#!/bin/bash\nrm $X\n', {
      hunks: [{ newStart: 1, newEnd: 1 }],
    });
    const r = runScriptLint(
      { plan, worktree },
      shellcheckRunner([{ line: 1, code: 2086, level: 'info' }]),
    );
    expect(r.diffHash).toBeUndefined();
    clean();
  });
});

describe('buildToolInvocation — config isolation (a PR config cannot suppress its own findings)', () => {
  // Each defence is load-bearing security: without it a PR can add a linter config
  // that silences the exact finding the gate blocks on. Asserted on the invocation
  // itself, so it holds with no binary installed and cannot regress silently.
  it('shellcheck runs with --norc, ignoring a PR-added .shellcheckrc', () => {
    const { argv } = buildToolInvocation('shellcheck', '/w/x.sh');
    expect(argv).toContain('--norc');
  });

  it('drops SHELLCHECK_OPTS from the env even when the process has a hostile one set', () => {
    const prev = process.env['SHELLCHECK_OPTS'];
    process.env['SHELLCHECK_OPTS'] = '--severity=error'; // would hide info-level SC2086
    try {
      const { env } = buildToolInvocation('shellcheck', '/w/x.sh');
      expect(env['SHELLCHECK_OPTS']).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['SHELLCHECK_OPTS'];
      else process.env['SHELLCHECK_OPTS'] = prev;
    }
  });

  it('points HADOLINT_CONFIG at an EMPTY config, neutralising a PR-added .hadolint.yaml', () => {
    const { env } = buildToolInvocation('hadolint', '/w/Dockerfile');
    expect(env['HADOLINT_CONFIG']).toBeTruthy();
    // the file it points at has no `ignored:` rules — it is empty
    expect(readFileSync(env['HADOLINT_CONFIG'] as string, 'utf8')).toBe('');
  });
});
