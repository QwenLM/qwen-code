/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Real `git` and a real `git worktree`. The property under test — that the
// probe runs in its OWN disposable worktree and never mutates the shared one
// (#6832) — lives entirely in git's bookkeeping, so a mocked child_process
// would prove nothing. `vitest` itself is stubbed by a fake bin (below): the
// verdict logic is unit-tested in `classifyProbeRun`; what these lock down is
// where the probe runs and what it leaves behind.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOneMutant, testEfficacyCommand } from './test-efficacy.js';

type Handler = (args: {
  report: string;
  worktree: string;
  base: string;
  out: string;
  now?: () => number;
}) => Promise<void>;
const runHandler = testEfficacyCommand.handler as unknown as Handler;

let repo: string;
let outside: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function commitAll(msg: string): string {
  git(repo, 'add', '-A');
  git(
    repo,
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    '-m',
    msg,
  );
  return git(repo, 'rev-parse', 'HEAD').trim();
}
function write(rel: string, body: string) {
  const abs = join(repo, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}
/** The staged tree of a worktree — changes iff the working tree was mutated. */
function treeState(wt: string): string {
  return (
    git(wt, 'status', '--porcelain', '-z') + '|' + git(wt, 'rev-parse', 'HEAD')
  );
}

/**
 * A minimal same-repo PR: source `f` changes 1→2, with a reachable test that
 * passes regardless (so a revert probe reads it as inert). Returns the shared
 * worktree and base SHA, with the report already written to `report.json`.
 */
function scaffoldModifiedPr(): { wt: string; base: string } {
  write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
  write('packages/lib/src/f.ts', 'export const f = () => 1;\n');
  const base = commitAll('base');
  write('packages/lib/src/f.ts', 'export const f = () => 2;\n');
  write(
    'packages/lib/src/f.test.ts',
    'import { f } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof f).toBe("function"));\n',
  );
  commitAll('pr');
  const wt = join(repo, 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  writeFileSync(
    join(repo, 'report.json'),
    JSON.stringify({
      files: [
        { path: 'packages/lib/src/f.ts', kind: 'source' },
        { path: 'packages/lib/src/f.test.ts', kind: 'test' },
      ],
    }),
  );
  return { wt, base };
}

/**
 * Swap the fake runner for one that reports every test file as FAILED. Used to
 * drive the unmutated baseline red, so the mutant phase must skip wholesale.
 */
function installFailingVitest(): void {
  const bin = join(repo, 'node_modules', '.bin', 'vitest');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const path = require('path');
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
process.stdout.write(JSON.stringify({
  numPassedTests: 0,
  numFailedTests: files.length,
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: 'failed' }],
  })),
}));
`,
  );
  chmodSync(bin, 0o755);
}

/**
 * Swap the fake runner for one that reports a file whose path contains "skip"
 * as all-skipped (collected, but no assertion executed) and every other file as
 * PASSED. Drives the per-file baseline gate: an unrelated all-skip file is
 * `inconclusive`, not red, and must not disable the mutant phase.
 */
function installMixedVitest(): void {
  const bin = join(repo, 'node_modules', '.bin', 'vitest');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const path = require('path');
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
process.stdout.write(JSON.stringify({
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: f.includes('skip') ? 'skipped' : 'passed' }],
  })),
}));
`,
  );
  chmodSync(bin, 0o755);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'efficacy-iso-'));
  outside = mkdtempSync(join(tmpdir(), 'efficacy-outside-'));
  git(repo, 'init', '-q', '-b', 'main', '.');
  // Keep the fake vitest out of git: `commitAll` runs `git add -A`, and a
  // committed bin would be checked out into the probe worktree — the stale
  // passing copy, not the file `installFailingVitest` overwrites.
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');

  // A fake `vitest` on the up-tree bin path so `npx vitest` in the probe tree
  // resolves locally — fast, deterministic, no network. It echoes each test
  // file it is handed back as PASSED, so a probe over reverted source reads as
  // `inert` without a real runner. `npx` walks node_modules upward, and the
  // probe tree is a direct child of `repo`, so this bin is what it finds.
  mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
  const bin = join(repo, 'node_modules', '.bin', 'vitest');
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const path = require('path');
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
process.stdout.write(JSON.stringify({
  numPassedTests: files.length,
  numFailedTests: 0,
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: 'passed' }],
  })),
}));
`,
  );
  chmodSync(bin, 0o755);
});

afterEach(() => {
  // The handler removes its own probe tree; force-remove any a failed test left.
  try {
    git(repo, 'worktree', 'remove', '--force', join(repo, 'wt-probe'));
  } catch {
    // not there — the normal case
  }
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('test-efficacy probe isolation (#6832)', () => {
  it('probes in a disposable worktree and never mutates the shared one', async () => {
    const { wt, base } = scaffoldModifiedPr();

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    // The shared worktree the other review agents read is byte-identical: no
    // in-place revert was ever visible in it.
    expect(treeState(wt)).toBe(before);
    expect(readFileSync(join(wt, 'packages/lib/src/f.ts'), 'utf8')).toBe(
      'export const f = () => 2;\n',
    );
    // The probe tree was created and discarded.
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
    // And the probe still produced its verdict from the isolated tree: the test
    // passed with the source reverted, so it is inert.
    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.findings.map((f: { file: string }) => f.file)).toContain(
      'packages/lib/src/f.test.ts',
    );
    expect(out.cleanupFailure).toBeUndefined();
  });

  it('a PR-controlled symlink cannot delete outside the tree — by isolation, not the guard', async () => {
    writeFileSync(join(outside, 'victim'), 'must survive');

    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write('packages/lib/src/dir/victim', 'base\n');
    write('packages/lib/src/f.ts', 'export const f = () => 1;\n');
    write(
      'packages/lib/src/f.test.ts',
      'import { f } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof f).toBe("function"));\n',
    );
    const base = commitAll('base');

    // The P0 shape: `dir` becomes a symlink to an outside directory and
    // `dir/victim` is deleted.
    git(repo, 'rm', '-q', '-r', 'packages/lib/src/dir');
    symlinkSync(outside, join(repo, 'packages/lib/src/dir'));
    write('packages/lib/src/f.ts', 'export const f = () => 2;\n');
    commitAll('pr: dir -> outside symlink, delete dir/victim');

    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/dir', kind: 'source' },
          { path: 'packages/lib/src/dir/victim', kind: 'source' },
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    // The outside file is untouched.
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('must survive');
    // And it survived because the probe never restored/deleted in a tree holding
    // the symlink — not because `safeRmWithin` refused. If the guard had been the
    // thing that fired, it would have surfaced as an inconclusive probe.
    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    const details = (out.probed as Array<{ detail: string }>).map(
      (p) => p.detail,
    );
    expect(details.join('\n')).not.toMatch(
      /refusing to delete through a symlink/,
    );
    // Shared tree untouched, probe tree discarded.
    expect(treeState(wt)).toBe(before);
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('runs a deletion mutant end-to-end and reports the survivor', async () => {
    // The dogfood shape at full scale: the PR adds a reset function whose one
    // safety statement (`state.clear()`) nothing gates. The fake vitest is
    // green no matter what, so the baseline run passes, the mutant run passes
    // — a SURVIVOR — and the revert probe still reads the test as inert. Both
    // trees end clean: the mutation happened only in the disposable worktree.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function use(k: string) {\n' +
        '  return state.get(k);\n' +
        '}\n',
    );
    const base = commitAll('base');
    const prSource =
      'export const state = new Map<string, string>();\n' +
      'export function use(k: string) {\n' +
      '  return state.get(k);\n' +
      '}\n' +
      'export function reset() {\n' +
      '  state.clear();\n' +
      '}\n';
    write('packages/lib/src/f.ts', prSource);
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([
      {
        file: 'packages/lib/src/f.ts',
        line: 6,
        statement: 'state.clear();',
        verdict: 'survived',
        detail: expect.stringContaining('still PASSED'),
      },
    ]);
    expect(out.mutants.survived).toBe(1);
    expect(out.mutants.skippedForBudget).toBe(0);
    // The survivor is a finding the orchestrator files; the register matches
    // the unreachable/inert messages Agent 7's brief already knows how to read.
    const survivor = (
      out.findings as Array<{ kind: string; file: string; message: string }>
    ).find((f) => f.kind === 'mutant-survived');
    expect(survivor?.file).toBe('packages/lib/src/f.ts');
    expect(survivor?.message).toContain('state.clear();');
    // The mutation never touched the shared tree, and the probe tree is gone.
    expect(treeState(wt)).toBe(before);
    expect(readFileSync(join(wt, 'packages/lib/src/f.ts'), 'utf8')).toBe(
      prSource,
    );
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('kills a mutant the suite catches — the A/B control for the survivor test', async () => {
    // Same source, same statement, same line as the survivor test above. The
    // ONLY variable is the fake runner: here it reads the source and fails when
    // `state.clear()` is gone — a genuinely gating test. The mutant must be
    // KILLED (no finding), proving the verdict tracks the test, not the harness.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function use(k: string) {\n' +
        '  return state.get(k);\n' +
        '}\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function use(k: string) {\n' +
        '  return state.get(k);\n' +
        '}\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );
    // The fake runner reads the source: green when `state.clear()` is present,
    // red when it is gone. The baseline passes; the mutant (statement deleted)
    // fails — KILLED.
    const bin = join(repo, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
const src = fs.readFileSync(path.join(process.cwd(), 'packages/lib/src/f.ts'), 'utf8');
const failed = src.includes('state.clear()') ? 0 : 1;
process.stdout.write(JSON.stringify({
  numPassedTests: failed ? 0 : files.length,
  numFailedTests: failed ? files.length : 0,
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: failed ? 'failed' : 'passed' }],
  })),
}));
`,
    );
    chmodSync(bin, 0o755);

    const before = treeState(wt);
    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([
      {
        file: 'packages/lib/src/f.ts',
        line: 6,
        statement: 'state.clear();',
        verdict: 'killed',
        detail: expect.stringContaining('suite went red'),
      },
    ]);
    expect(out.mutants.killed).toBe(1);
    expect(out.mutants.survived).toBe(0);
    // A killed mutant is the GOOD outcome — no finding.
    expect(
      (out.findings as Array<{ kind: string }>).some(
        (f) => f.kind === 'mutant-survived',
      ),
    ).toBe(false);
    expect(treeState(wt)).toBe(before);
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('skips the mutants wholesale when the unmutated baseline is not green', async () => {
    // A mutant is only evidence against a suite that is green WITHOUT it: against
    // a baseline that already fails, every mutant would be "killed" by failures
    // it did not cause. So when no probe file is green in the unmutated run, the whole
    // mutant phase is skipped and the report says so — no probed mutants and no
    // survivor finding, even though the diff adds an ungated safety statement.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    // The test FAILS, so the suite is not cleanly green under a real runner
    // too — not only under the fake one installed below. Whichever runner the
    // probe resolves to, the baseline is red and the mutants must be skipped.
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => { reset(); expect(1).toBe(2); });\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );
    // The unmutated suite is NOT green: the fake runner reports a failure.
    installFailingVitest();

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([]);
    expect(out.mutants.skippedForBaseline).toBe(1);
    expect(out.mutants.note).toContain('no probe file was green');
    expect(
      (out.findings as Array<{ kind: string }>).some(
        (f) => f.kind === 'mutant-survived',
      ),
    ).toBe(false);
    const stdout = stdoutChunks.join('');
    expect(stdout).toContain(
      '1 mutant(s) skipped: no probe file was green in the unmutated baseline',
    );
    expect(stdout).toContain('mutants not run: no probe file was green');
  });

  it('still probes when an UNRELATED probe file is all-skipped (per-file gate)', async () => {
    // Finding 2's shape: a quarantined suite that is entirely `it.skip`
    // classifies `inconclusive` — not red, not a failure. The old whole-suite
    // gate read that as "not cleanly green" and took the ENTIRE mutant phase
    // down with it, losing the survivor finding below. The gate is per file:
    // the mutant runs against the probe files that ARE green in the baseline,
    // so an unrelated all-skip file no longer disables it.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
    );
    // An unrelated suite that collects but runs nothing (all skipped).
    write(
      'packages/lib/src/skipped.test.ts',
      'import { it } from "vitest"; it.skip("quarantined", () => {});\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
          { path: 'packages/lib/src/skipped.test.ts', kind: 'test' },
        ],
      }),
    );
    // Baseline: f.test.ts passes (inert), skipped.test.ts collects but runs
    // nothing (inconclusive). The mutant must still run against the green file.
    installMixedVitest();

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.note).toBeUndefined();
    expect(out.mutants.survived).toBe(1);
    expect(out.mutants.probed).toEqual([
      {
        file: 'packages/lib/src/f.ts',
        line: 3,
        statement: 'state.clear();',
        verdict: 'survived',
        detail: expect.stringContaining('still PASSED'),
      },
    ]);
  });

  it('reports mutants skipped for budget when time runs out mid-loop', async () => {
    // Three safety-verb candidates, but the budget expires after one: the
    // counter, the `skippedForBudget` report field, and the stdout line are
    // exercised end-to-end. The injected clock advances 100 s per SUITE RUN
    // (the fake runner logs each run; the real budget is 540 s and a real run
    // cannot reach it in a test) — a simulated duration, not a count of
    // `Date.now()` calls, so the implementation is free to consult the clock
    // as often as it likes. The mutant deadline is 240 s (540 − 300 revert
    // reservation), the baseline measures 100 s, so `estimatedRunMs` is
    // 115 s; after the baseline and one mutant the clock reads 200 s and the
    // remaining 40 s cannot fit another run.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export let items: string[] = ["a"];\n' +
        'export const state = new Map<string, string>();\n' +
        'export const cache = new Set<string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export let items: string[] = ["a"];\n' +
        'export const state = new Map<string, string>();\n' +
        'export const cache = new Set<string>();\n' +
        'export function reset() {\n' +
        '  items = [];\n' +
        '  state.clear();\n' +
        '  cache.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );

    // The fake runner appends one line per invocation; the injected clock
    // reads the log, so it moves only when a suite actually runs.
    const runsLog = join(repo, 'runs.log');
    const bin = join(repo, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.appendFileSync(${JSON.stringify(runsLog)}, 'run\\n');
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
process.stdout.write(JSON.stringify({
  numPassedTests: files.length,
  numFailedTests: 0,
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: 'passed' }],
  })),
}));
`,
    );
    chmodSync(bin, 0o755);
    const suiteRuns = () =>
      existsSync(runsLog)
        ? readFileSync(runsLog, 'utf8').split('\n').filter(Boolean).length
        : 0;
    // The skip must also be DISCLOSED on stdout — a capped run that stays
    // silent lets `survived: 0` read as "every safety statement is covered".
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
        now: () => suiteRuns() * 100_000,
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed.length).toBe(1);
    expect(out.mutants.skippedForBudget).toBe(2);
    expect(out.mutants.skippedForBaseline).toBe(0);
    expect(out.mutants.probed.length + out.mutants.skippedForBudget).toBe(3);
    for (const m of out.mutants.probed) {
      expect(m.verdict).toBe('survived');
    }
    expect(stdoutChunks.join('')).toContain(
      '2 mutant(s) skipped: the remaining budget cannot fit another suite run',
    );
  });

  it('reports mutants skipped for cap when candidates exceed MAX_MUTANTS', async () => {
    // Nine safety-verb candidates but MAX_MUTANTS is 8: the counter, the
    // `skippedForCap` report field, and the stdout line are exercised
    // end-to-end, mirroring the budget-skip test above.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    const stmts = Array.from({ length: 9 }, (_, i) => `  state${i}.clear();`);
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        stmts.join('\n') +
        '\n}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { it, expect } from "vitest"; it("t", () => expect(1).toBe(1));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed.length).toBe(8);
    expect(out.mutants.skippedForCap).toBe(1);
    expect(out.mutants.skippedForBaseline).toBe(0);
    expect(out.mutants.probed.length + out.mutants.skippedForCap).toBe(9);
    expect(stdoutChunks.join('')).toContain(
      '1 mutant(s) skipped: more candidates than the cap of 8',
    );
  });

  it('marks every candidate inconclusive when the runner dies mid-mutation, and still runs the revert probe', async () => {
    // The mutation-phase catch: a runner killed (or failing to spawn) during a
    // mutant run is not evidence about any statement. Every candidate that
    // never got a verdict — the one being run AND the ones never attempted —
    // must come back `inconclusive` with the reason, the revert probe must
    // still run, and the report must still be written. The fake runner passes
    // the baseline (run 1), floods stdout past spawnSync's 64 MiB maxBuffer on
    // run 2 (the first mutant) so the runner spawn itself errors (ENOBUFS),
    // and passes the revert probe (run 3).
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export const cache = new Set<string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export const cache = new Set<string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '  cache.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );
    const callsFile = join(repo, 'calls.txt');
    const bin = join(repo, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
let n = 0;
try { n = parseInt(fs.readFileSync(${JSON.stringify(callsFile)}, 'utf8'), 10) || 0; } catch {}
n += 1;
fs.writeFileSync(${JSON.stringify(callsFile)}, String(n));
if (n === 2) {
  const big = Buffer.alloc(8 * 1024 * 1024, 97);
  try { for (let i = 0; i < 10; i++) fs.writeSync(1, big); } catch {}
  process.exit(0);
}
const files = process.argv.slice(2).filter((a) => a.includes('.test.'));
process.stdout.write(JSON.stringify({
  numPassedTests: files.length,
  numFailedTests: 0,
  testResults: files.map((f) => ({
    name: path.resolve(f),
    assertionResults: [{ status: 'passed' }],
  })),
}));
`,
    );
    chmodSync(bin, 0o755);

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toHaveLength(2);
    for (const m of out.mutants.probed as Array<{
      verdict: string;
      detail: string;
    }>) {
      expect(m.verdict).toBe('inconclusive');
      expect(m.detail).toContain('mutation probe could not run');
    }
    expect(out.mutants.probed[0].detail).toContain('ENOBUFS');
    expect(out.mutants.inconclusive).toBe(2);
    expect(out.mutants.killed).toBe(0);
    expect(out.mutants.survived).toBe(0);
    expect(
      (out.findings as Array<{ kind: string }>).some(
        (f) => f.kind === 'mutant-survived',
      ),
    ).toBe(false);
    // The revert probe still ran: a real verdict from run 3, not a propagated
    // mutation failure.
    expect(out.probed).toEqual([
      expect.objectContaining({
        file: 'packages/lib/src/f.test.ts',
        verdict: 'inert',
      }),
    ]);
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('still finds the survivor under hostile user git diff config', async () => {
    // A developer's diff.srcPrefix/dstPrefix reshapes the `+++ b/…` headers
    // parseAddedLines anchors on, diff.external replaces the unified diff with
    // an external command's output (here one that dies outright), and
    // core.quotePath octal-escapes every non-ASCII path — each one alone
    // would turn selection into a silent zero or a selection failure. The
    // invocation pins its own prefixes and disables ext-diff/textconv/quoting,
    // so the survivor must still be found, in a non-ASCII path too.
    git(repo, 'config', 'diff.srcPrefix', 'left/');
    git(repo, 'config', 'diff.dstPrefix', 'right/');
    git(repo, 'config', 'diff.external', 'false');
    git(repo, 'config', 'core.quotePath', 'true');
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/fø.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/fø.ts',
      'export const state = new Map<string, string>();\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { it, expect } from "vitest"; it("t", () => expect(1).toBe(1));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/fø.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.note).toBeUndefined();
    expect(out.mutants.survived).toBe(1);
    expect(out.mutants.probed).toEqual([
      {
        file: 'packages/lib/src/fø.ts',
        line: 3,
        statement: 'state.clear();',
        verdict: 'survived',
        detail: expect.stringContaining('still PASSED'),
      },
    ]);
  });

  it('discloses the dropped candidates when a file derails the literal scan', async () => {
    // A regex literal holding a backtick flips the whole-file scan into
    // template state through to EOF, so every candidate in the file — here a
    // genuinely ungated `state.clear()` — is dropped as untrustworthy. That
    // zero must be DISCLOSED in `mutants.note`, never silent: a report that
    // says `survived: 0` without it reads as "every safety statement is
    // covered". The revert probe does not depend on selection and still runs.
    write('package.json', '{"private":true,"workspaces":["packages/*"]}\n');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n',
    );
    const base = commitAll('base');
    write(
      'packages/lib/src/f.ts',
      'export const state = new Map<string, string>();\n' +
        'export const TICK_RE = /`/;\n' +
        'export function reset() {\n' +
        '  state.clear();\n' +
        '}\n',
    );
    write(
      'packages/lib/src/f.test.ts',
      'import { reset } from "./f.js"; import { it, expect } from "vitest"; it("t", () => expect(typeof reset).toBe("function"));\n',
    );
    commitAll('pr');
    const wt = join(repo, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    writeFileSync(
      join(repo, 'report.json'),
      JSON.stringify({
        files: [
          { path: 'packages/lib/src/f.ts', kind: 'source' },
          { path: 'packages/lib/src/f.test.ts', kind: 'test' },
        ],
      }),
    );

    const stdoutChunks: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
    try {
      await runHandler({
        report: join(repo, 'report.json'),
        worktree: wt,
        base,
        out: join(repo, 'out.json'),
      });
    } finally {
      stdoutSpy.mockRestore();
    }

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.probed).toEqual([]);
    expect(out.mutants.note).toContain('literal scan derailed');
    expect(out.mutants.note).toContain('packages/lib/src/f.ts');
    expect(stdoutChunks.join('')).toContain('literal scan derailed');
    // The revert probe still produced a real verdict.
    expect(out.probed).toEqual([
      expect.objectContaining({
        file: 'packages/lib/src/f.test.ts',
        verdict: 'inert',
      }),
    ]);
  });

  it('discloses a selection failure and still runs the revert probe', async () => {
    // Mutant selection captures the diff with `git diff <base>`, and a base
    // this repository cannot resolve (a shallow clone's truncated history has
    // exactly this shape) makes that capture throw. The catch is load-bearing:
    // without it the whole command crashes and the revert probe — which does
    // not depend on selection — is lost with it. The failure must be disclosed
    // as the mutants note, never as a crash and never as silent zero mutants.
    const { wt } = scaffoldModifiedPr();

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base: 'no-such-base-rev',
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.mutants.note).toContain('mutant selection failed');
    expect(out.mutants.probed).toEqual([]);
    // The revert probe still produced a real verdict from the fake runner.
    expect(out.probed).toEqual([
      expect.objectContaining({
        file: 'packages/lib/src/f.test.ts',
        verdict: 'inert',
      }),
    ]);
  });

  it('never deletes a line that does not hold the selected statement', () => {
    // `runOneMutant`'s mismatch guard, pinned directly: selection and the
    // probe tree both derive from the same commit, so the command cannot reach
    // this branch — but if the guard were dropped, a stale line number would
    // delete the WRONG statement and attribute the run's verdict (here the
    // fake runner's green — `survived`) to a statement that was never removed.
    write('src/x.ts', 'alpha();\nbeta();\n');
    const before = readFileSync(join(repo, 'src/x.ts'), 'utf8');

    const got = runOneMutant(
      repo,
      { file: 'src/x.ts', line: 1, statement: 'gone.clear();' },
      ['src/x.test.ts'],
    );

    expect(got.verdict).toBe('inconclusive');
    expect(got.detail).toContain('does not match the selected statement');
    expect(readFileSync(join(repo, 'src/x.ts'), 'utf8')).toBe(before);
  });

  it('sweeps a stale REGISTERED probe worktree left by a crashed run', async () => {
    const { wt, base } = scaffoldModifiedPr();
    // A prior probe crashed after `worktree add` but before its cleanup, leaving
    // the probe tree registered. The pre-sweep must unregister and replace it,
    // not fail `add` on the collision.
    git(
      repo,
      'worktree',
      'add',
      '-q',
      '--detach',
      join(repo, 'wt-probe'),
      'HEAD',
    );
    expect(existsSync(join(repo, 'wt-probe'))).toBe(true);

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    // The probe ran (a real verdict, not a "could not be created" inconclusive)
    // and left the tree cleaned up.
    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    expect(out.findings.map((f: { file: string }) => f.file)).toContain(
      'packages/lib/src/f.test.ts',
    );
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });

  it('clears an UNREGISTERED non-empty leftover so the probe is not wedged', async () => {
    const { wt, base } = scaffoldModifiedPr();
    // A partial cleanup left a directory at the probe path that git no longer
    // tracks as a worktree, and it is non-empty. `git worktree remove` cannot
    // clear it ("not a working tree"), and without the rmSync fallback the next
    // `git worktree add` fails "already exists" — wedging every probe as
    // inconclusive until someone clears it by hand.
    mkdirSync(join(repo, 'wt-probe', 'junk'), { recursive: true });
    writeFileSync(join(repo, 'wt-probe', 'junk', 'f'), 'x');

    await runHandler({
      report: join(repo, 'report.json'),
      worktree: wt,
      base,
      out: join(repo, 'out.json'),
    });

    const out = JSON.parse(readFileSync(join(repo, 'out.json'), 'utf8'));
    const details = (out.probed as Array<{ detail?: string }>).map(
      (p) => p.detail ?? '',
    );
    expect(details.join('\n')).not.toMatch(/could not be created/);
    expect(out.findings.map((f: { file: string }) => f.file)).toContain(
      'packages/lib/src/f.test.ts',
    );
    expect(existsSync(join(repo, 'wt-probe'))).toBe(false);
  });
});
