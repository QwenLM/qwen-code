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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  runScriptLint,
  buildToolInvocation,
  type ToolRun,
  type ToolRunner,
  type LintTool,
} from './script-lint.js';

// A per-test temp dir, set up and torn down by hooks — NOT inline `fresh()`/`clean()`
// calls. A failing `expect` throws before any inline cleanup would run and leaks the
// dir; `afterEach` runs regardless, so the teardown is leak-proof.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'script-lint-mock-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

/** One actionlint diagnostic in the measured 1.7.12 `-format '{{json .}}'`
 *  shape: a JSON ARRAY of `{message, filepath, line, column, kind, snippet,
 *  end_column}` objects — `kind`, not `error_kind`, is the class field. */
function actionlintRunner(
  entries: Array<{ line: number; kind: string; message?: string }>,
): ToolRunner {
  return (tool: LintTool): ToolRun =>
    tool === 'actionlint'
      ? {
          kind: 'ok',
          stdout: JSON.stringify(
            entries.map((e) => ({
              message: e.message ?? 'msg',
              filepath: '.github/workflows/ci.yml',
              line: e.line,
              column: 1,
              kind: e.kind,
              snippet: '',
              end_column: 2,
            })),
          ),
        }
      : { kind: 'missing' };
}

describe('runScriptLint — tool JSON normalisation (injected runner)', () => {
  it('runs actionlint and gates its workflow-level diagnostics; the shell portion stays deferred', () => {
    // The #15974 shape: an `expression` diagnostic (runner context in
    // jobs.env) is a workflow-level check — it gates like any lint finding.
    // The old whole-file deferral never ran the tool at all.
    const runner = vi.fn(
      actionlintRunner([
        {
          line: 8,
          kind: 'expression',
          message: 'context "runner" is not allowed here',
        },
      ]),
    );
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      { hunks: [{ newStart: 8, newEnd: 8 }] },
    );
    const r = runScriptLint({ plan, worktree }, runner);
    expect(runner).toHaveBeenCalledWith('actionlint', expect.any(String));
    expect(r.checked).toHaveLength(1);
    expect(r.checked[0].tool).toBe('actionlint');
    expect(r.checked[0].findings[0]).toMatchObject({
      line: 8,
      code: 'expression',
      level: 'error',
      inDiff: true,
    });
    expect(r.ok).toBe(false);
    // The file is in BOTH channels: checked (workflow-level) and deferred
    // (the embedded shell, which the invocation disables).
    expect(r.deferred).toHaveLength(1);
    expect(r.deferred[0].tool).toBe('actionlint');
    expect(r.deferred[0].reason).toContain('ran workflow-level checks');
    expect(r.deferred[0].reason).not.toContain('not linted');
    expect(r.deferred[0].reasonZh).toBe(
      'actionlint 已运行 workflow 级检查；内嵌 run: shell 延迟处理（源映射尚未支持）',
    );
    expect(r.skipped).toEqual([]);
  });

  it('a clean actionlint array still discloses the shell deferral', () => {
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      { hunks: [{ newStart: 1, newEnd: 3 }] },
    );
    const r = runScriptLint({ plan, worktree }, actionlintRunner([]));
    expect(r.checked).toHaveLength(1);
    expect(r.checked[0].findings).toEqual([]);
    expect(r.deferred).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  it('routes embedded-language kinds to the deferral, never to a finding (version-skew backstop)', () => {
    // The integrations are disabled at invocation, so these kinds should not
    // appear — but if a version emits them anyway, they are the deferred
    // portion (run:-key anchors, flattened severity), not gate findings.
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      { hunks: [{ newStart: 8, newEnd: 8 }] },
    );
    const r = runScriptLint(
      { plan, worktree },
      actionlintRunner([
        { line: 8, kind: 'shellcheck' },
        { line: 9, kind: 'pyflakes' },
      ]),
    );
    expect(r.checked).toHaveLength(1);
    expect(r.checked[0].findings).toEqual([]);
    expect(r.deferred).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['a non-array root', '{"message":"oops"}'],
    ['an entry without a line', '[{"kind":"expression","message":"m"}]'],
    ['an entry without a kind', '[{"line":3,"message":"m"}]'],
    ['a null entry', '[null]'],
  ])('fails closed on %s in actionlint output', (_label, stdout) => {
    // Dropping one malformed diagnostic could drop the blocker that makes a
    // workflow unloadable — the whole file errors instead.
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      { hunks: [{ newStart: 1, newEnd: 3 }] },
    );
    const r = runScriptLint(
      { plan, worktree },
      fixedRunner({ kind: 'ok', stdout }),
    );
    expect(r.checked).toEqual([]);
    expect(r.errored).toHaveLength(1);
    expect(r.errored[0].tool).toBe('actionlint');
    expect(r.errored[0].reason).toContain('unparseable');
    expect(r.ok).toBe(false);
  });

  it('an uninstalled actionlint is skipped (unreviewed), not deferred', () => {
    // The deferral is the SHELL PORTION of a run that happened. A tool that
    // never ran checked nothing — the same fail-closed state shellcheck gets,
    // which the gate caps an Approve on.
    const { plan, worktree } = setup(
      '.github/workflows/ci.yml',
      'name: CI\non: push\njobs: {}\n',
      { hunks: [{ newStart: 1, newEnd: 3 }] },
    );
    const r = runScriptLint(
      { plan, worktree },
      fixedRunner({ kind: 'missing' }),
    );
    expect(r.checked).toEqual([]);
    expect(r.deferred).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].tool).toBe('actionlint');
    expect(r.skipped[0].reason).toContain('not installed');
  });

  it('normalises hadolint output (code + level preserved)', () => {
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
  });

  it('normalises shellcheck json1 (SC-prefixed code, info blocks)', () => {
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
      const { plan, worktree } = setup('x.sh', '#!/bin/bash\nrm $X\n', {
        hunks: [{ newStart: 2, newEnd: 2 }],
      });
      const r = runScriptLint({ plan, worktree }, fixedRunner(res));
      expect(r.checked).toEqual([]);
      expect(r.errored).toHaveLength(1);
      expect(r.errored[0].tool).toBe('shellcheck');
      expect(r.ok).toBe(false);
      expect(r.note).toContain('failed to lint');
    },
  );

  it('treats non-empty UNPARSEABLE output as errored, not a clean file', () => {
    // A runner that "succeeded" but printed junk before/instead of JSON — a
    // version skew, a deprecation notice. Fail closed, do not record `checked`.
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
  });
});

describe('runScriptLint — inDiff uses added lines, not hunk context', () => {
  it('does NOT block on a finding that lands on a context line', () => {
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
  });

  it('a path the PARSED diff does not mention is inDiff:false, not context-hunk true', () => {
    // The diff adds line 2 of a.sh only. b.sh is in the plan (a finding on it) but
    // absent from the diff — so its finding must be inDiff:false (nothing added for
    // it), NOT promoted via b.sh's context-inclusive plan hunks. Regression guard for
    // the false-positive-blocker the `?? hunksOf` fallback could produce.
    const diff = [
      'diff --git a/a.sh b/a.sh',
      '--- a/a.sh',
      '+++ b/a.sh',
      '@@ -1,1 +1,2 @@',
      ' #!/bin/bash',
      '+rm $X',
      '',
    ].join('\n');
    const diffPath = join(dir, 'pr.diff');
    writeFileSync(diffPath, diff);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.sh'), '#!/bin/bash\nrm $X\n');
    writeFileSync(join(dir, 'b.sh'), '#!/bin/bash\nrm $Y\n');
    const planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        diffPathAbsolute: diffPath,
        files: [
          { path: 'a.sh', kind: 'source', hunks: [{ newStart: 2, newEnd: 2 }] },
          // b.sh is NOT in the diff; its plan hunks would (wrongly) cover line 2.
          { path: 'b.sh', kind: 'source', hunks: [{ newStart: 2, newEnd: 2 }] },
        ],
      }),
    );
    const r = runScriptLint(
      { plan: planPath, worktree: dir },
      shellcheckRunner([{ line: 2, code: 2086, level: 'info' }]),
    );
    const a = r.checked.find((c) => c.path === 'a.sh')!;
    const b = r.checked.find((c) => c.path === 'b.sh')!;
    expect(a.findings[0].inDiff).toBe(true); // added line — blocks
    expect(b.findings[0].inDiff).toBe(false); // not in the parsed diff — must not block
  });
});

describe('runScriptLint — refuses a path that escapes the worktree', () => {
  it('records an outside-worktree path as skipped, never stats or lints it', () => {
    const planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        // `..` escape: resolves to the parent of the worktree.
        files: [{ path: '../escape.sh', kind: 'source' }],
      }),
    );
    const runner = () => {
      throw new Error('runner must not be called for an out-of-worktree path');
    };
    const r = runScriptLint({ plan: planPath, worktree: dir }, runner);
    expect(r.checked).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain('outside the worktree');
    // The body's "Not reviewed:" wrapper already says the file went
    // unchecked — a "not linted" tail here posted the phrase twice.
    expect(r.skipped[0].reason).not.toContain('not linted');
  });

  it('refuses a path whose ANCESTOR is a symlink out of the worktree (lexical is not enough)', () => {
    // `evil/` is a symlink to a directory outside the worktree that holds a real
    // `x.sh`. `evil/x.sh` passes the lexical `startsWith` check but its canonical
    // path is outside — `realpathSync` must catch it, or the linter reads external
    // content and the trusted report certifies it.
    const outside = mkdtempSync(join(tmpdir(), 'sl-outside-'));
    writeFileSync(join(outside, 'x.sh'), '#!/bin/bash\nrm $X\n');
    symlinkSync(outside, join(dir, 'evil')); // dir/evil -> outside
    const planPath = join(dir, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({ files: [{ path: 'evil/x.sh', kind: 'source' }] }),
    );
    const runner = () => {
      throw new Error('runner must not be called for a symlink-escaped path');
    };
    const r = runScriptLint({ plan: planPath, worktree: dir }, runner);
    rmSync(outside, { recursive: true, force: true });
    expect(r.checked).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain('outside the worktree');
    expect(r.skipped[0].reason).not.toContain('not linted');
  });
});

describe('runScriptLint — the report is bound to the diff it ran against', () => {
  it('stamps the report with a sha256 of the plan diff (the freshness key)', () => {
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
  });

  it('leaves diffHash undefined when the plan carries no readable diff', () => {
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
  });

  it('--diff overrides the plan diff for BOTH the hash and the added-line ranges', () => {
    // The re-anchor refresh channel (PR #16001 review): the plan stays fenced
    // at the old head while the lint recomputes against the new head's diff.
    // The old diff adds line 1 (the buggy line); the new diff adds line 2
    // instead — a finding on line 1 must read as pre-existing against the NEW
    // diff, and the report must hash the NEW diff, not the plan's.
    const oldDiff = 'diff --git a/x.sh b/x.sh\n@@ -0,0 +1 @@\n+rm $X\n';
    const newDiff =
      'diff --git a/x.sh b/x.sh\n@@ -1,1 +1,2 @@\n #!/bin/bash\n+echo added\n';
    const oldPath = join(dir, 'old.diff');
    const newPath = join(dir, 'new.diff');
    writeFileSync(oldPath, oldDiff);
    writeFileSync(newPath, newDiff);
    const { plan, worktree } = setup('x.sh', '#!/bin/bash\nrm $X\n', {
      hunks: [{ newStart: 1, newEnd: 1 }],
    });
    const planObj = JSON.parse(readFileSync(plan, 'utf8'));
    planObj.diffPathAbsolute = oldPath;
    writeFileSync(plan, JSON.stringify(planObj));

    const r = runScriptLint(
      { plan, worktree, diff: newPath },
      shellcheckRunner([{ line: 1, code: 2086, level: 'info' }]),
    );
    const expected = createHash('sha256')
      .update(readFileSync(newPath))
      .digest('hex');
    expect(r.diffHash).toBe(expected);
    // Line 1 is NOT an added line of the new diff — the range override took.
    expect(r.checked[0].findings[0].inDiff).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('--diff with an unreadable path leaves no hash (the gate fails closed)', () => {
    const { plan, worktree } = setup('x.sh', '#!/bin/bash\nrm $X\n', {
      hunks: [{ newStart: 1, newEnd: 1 }],
    });
    const r = runScriptLint(
      { plan, worktree, diff: join(dir, 'does-not-exist.diff') },
      shellcheckRunner([{ line: 1, code: 2086, level: 'info' }]),
    );
    expect(r.diffHash).toBeUndefined();
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

  it('actionlint disables the embedded integrations (the deferred portion must not depend on PATH)', () => {
    // `-shellcheck=` / `-pyflakes=` — the same form scripts/lint.js runs. With
    // them, the workflow-level checks give the same answer whether or not the
    // reviewer's machine happens to have shellcheck/pyflakes installed; the
    // shell portion is deferred uniformly. Drop them and a machine WITH
    // shellcheck starts emitting the run:-key-anchored diagnostics the split
    // exists to keep out of the gate.
    const { argv } = buildToolInvocation('actionlint', '/w/ci.yml');
    expect(argv).toContain('-shellcheck=');
    expect(argv).toContain('-pyflakes=');
  });

  it('actionlint runs against a private neutral config, not the PR-added .github/actionlint.yaml', () => {
    // The PR #16001 review's Critical: without -config-file, actionlint
    // auto-loads the reviewed repo's config, and a PR-added ignore-all rule
    // suppresses every diagnostic. The argv must carry a private mkdtemp
    // config whose content is the explicit empty config — never a path inside
    // the reviewed tree, never a predictable tmpdir name.
    const { argv } = buildToolInvocation('actionlint', '/w/ci.yml');
    const ci = argv.indexOf('-config-file');
    expect(ci).toBeGreaterThanOrEqual(0);
    const cfg = argv[ci + 1];
    expect(readFileSync(cfg, 'utf8')).toBe('{}\n');
    expect(cfg).not.toBe(join(tmpdir(), 'actionlint.yaml'));
    if (process.platform !== 'win32') {
      expect(statSync(dirname(cfg)).mode & 0o777).toBe(0o700);
    }
  });

  it('actionlint carries exactly the two trusted compatibility exceptions scripts/lint.js runs', () => {
    // Custom self-hosted runner labels (the ECS fleets this repo routes to)
    // and the environment.deployment schema lag (this repo's own workflows
    // use the key). Reviewer-controlled constants — the PR cannot add a third.
    const { argv } = buildToolInvocation('actionlint', '/w/ci.yml');
    const ignores = argv
      .map((a, i) => (a === '-ignore' ? argv[i + 1] : null))
      .filter((a): a is string => a !== null);
    expect(ignores).toEqual([
      'label ".+" is unknown',
      'unexpected key "deployment" for "environment" section',
    ]);
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

  it('isolates hadolint via --config pointing at a neutral (ignored: []) config', () => {
    // hadolint 2.14.0 reads `--config` (and a cwd `.hadolint.yaml`), NOT any env var,
    // so isolation must be on the CLI: a private config with no `ignored:` rules, so a
    // PR-added `.hadolint.yaml` cannot suppress findings. The content is a valid
    // `ignored: []` — an empty file would be rejected by `--config`.
    const { argv, env } = buildToolInvocation('hadolint', '/w/Dockerfile');
    const ci = argv.indexOf('--config');
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(readFileSync(argv[ci + 1], 'utf8')).toBe('ignored: []\n');
    // and NOT via HADOLINT_CONFIG — the env channel the binary ignores
    expect(env['HADOLINT_CONFIG']).toBeUndefined();
  });

  it('scrubs inherited HADOLINT_* vars so a reviewer env cannot suppress findings', () => {
    // hadolint 2.14 merges HADOLINT_IGNORE / HADOLINT_OVERRIDE_* / HADOLINT_CONFIG
    // from the env WITH --config. An inherited one must not reach the child (and this
    // is also what keeps the HADOLINT_CONFIG assertion above hermetic under CI).
    const saved: Record<string, string | undefined> = {};
    for (const k of ['HADOLINT_IGNORE', 'HADOLINT_CONFIG', 'HADOLINT_NOFAIL']) {
      saved[k] = process.env[k];
      process.env[k] = 'hostile';
    }
    try {
      const { env } = buildToolInvocation('hadolint', '/w/Dockerfile');
      expect(Object.keys(env).filter((k) => k.startsWith('HADOLINT_'))).toEqual(
        [],
      );
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('the --config path is a fresh 0700 mkdtemp path, not a predictable name', () => {
    // The config is a file hadolint READS, so a predictable path is a suppression
    // vector (plant an `ignored:` config there). It must live in a private 0700
    // mkdtemp dir, never a fixed `tmpdir()` name. Revert to a fixed name and the
    // 0700-parent assertion fails.
    const { argv } = buildToolInvocation('hadolint', '/w/Dockerfile');
    const cfg = argv[argv.indexOf('--config') + 1];
    expect(cfg).not.toBe(join(tmpdir(), 'qwen-review-hadolint-empty.yaml'));
    // POSIX mode bits only — Windows has no owner/group/other distinction.
    if (process.platform !== 'win32') {
      expect(statSync(dirname(cfg)).mode & 0o777).toBe(0o700);
    }
  });

  it('carries the spawn timeout as an asserted bound (not a buried literal)', () => {
    // The wall-clock bound `runTool` puts on the spawn. Drop it and a crafted script
    // that hangs a linter blocks the review until the outer CI job timeout.
    expect(buildToolInvocation('shellcheck', '/w/x.sh').timeoutMs).toBe(
      120_000,
    );
  });
});
