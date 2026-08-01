/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The parser and the attribution are the two halves that matter: a wrong
// failing-file parse invents or drops evidence, and a wrong delta turns a
// pre-existing flake into a public Critical (or the reverse). The base rerun
// itself is a seam — one command in one cwd — so the exec is injected.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  failingFilesOf,
  runTestDelta,
  type TestDeltaReport,
} from './test-delta.js';
import type { BuildTestReport, CommandResult } from './build-test.js';

const cmd = (over: Partial<CommandResult>): CommandResult => ({
  command: 'npm test --workspace="packages/core"',
  exitCode: 1,
  seconds: 10,
  timedOut: false,
  output: '',
  ...over,
});

describe('failingFilesOf', () => {
  it('reads FAIL lines (vitest and jest shape) once per file', () => {
    const out = [
      ' FAIL  src/a.test.ts > suite > first case',
      ' FAIL  src/a.test.ts > suite > second case',
      'FAIL src/b.spec.tsx',
    ].join('\n');
    expect(failingFilesOf(out)).toEqual(['src/a.test.ts', 'src/b.spec.tsx']);
  });

  it('reads a vitest ❯ progress line only when it says failed', () => {
    const out = [
      ' ❯ src/red.test.ts (12 tests | 3 failed) 220ms',
      ' ❯ src/green.test.ts (12 tests) 90ms',
    ].join('\n');
    expect(failingFilesOf(out)).toEqual(['src/red.test.ts']);
  });

  it('sees through ANSI color codes', () => {
    const out = '\x1b[31m FAIL \x1b[39m src/x.test.ts > case';
    expect(failingFilesOf(out)).toEqual(['src/x.test.ts']);
  });

  it('reads the workspace-prefixed FAIL shape', () => {
    // vitest workspace runs prefix the project name: `FAIL  |@scope/pkg| src/…`.
    const out = ' FAIL  |@qwen-code/qwen-code| src/commands/x.test.ts > case';
    expect(failingFilesOf(out)).toEqual(['src/commands/x.test.ts']);
  });

  it('reads a Windows path shape', () => {
    // A missed parse is an unattributed failure, not a loud error.
    expect(failingFilesOf(' FAIL  C:\\repo\\src\\x.test.ts > case')).toEqual([
      'C:\\repo\\src\\x.test.ts',
    ]);
  });

  it('names no file from output with no failure lines', () => {
    expect(failingFilesOf('Tests  12 passed (12)')).toEqual([]);
  });
});

describe('runTestDelta', () => {
  let dir: string;
  let baseline: string;

  const writeReport = (test: CommandResult[]): string => {
    const p = join(dir, 'bt.json');
    writeFileSync(p, JSON.stringify({ test } as Partial<BuildTestReport>));
    return p;
  };

  const runWith = (
    test: CommandResult[],
    baseOutput: string | ((command: string, cwd: string) => CommandResult),
  ): TestDeltaReport =>
    runTestDelta({
      report: writeReport(test),
      baseline,
      timeout: 60,
      exec:
        typeof baseOutput === 'function'
          ? // Pass cwd through: swallowing it made the baseline-dir assertion
            // impossible to write, which is why the test that promised it
            // never made it.
            (command, cwd) => baseOutput(command, cwd)
          : (command) => cmd({ command, output: baseOutput }),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-test-delta-'));
    baseline = join(dir, 'base');
    mkdirSync(baseline);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('attributes a PR-only failure as netNew and a both-sides failure as shared', () => {
    const r = runWith(
      [
        cmd({
          output:
            ' FAIL  src/new.test.ts > broken by pr\n FAIL  src/flaky.test.ts > env',
        }),
      ],
      ' FAIL  src/flaky.test.ts > env',
    );
    expect(r.netNew).toEqual(['src/new.test.ts']);
    expect(r.shared).toEqual(['src/flaky.test.ts']);
    expect(r.note).toContain('do NOT fail on base');
    expect(r.note).toContain('pre-existing');
  });

  it('reruns ONLY the failed commands, in the baseline dir', () => {
    const calls: string[] = [];
    const cwds: string[] = [];
    runWith(
      [
        cmd({ command: 'npm test --workspace="a"', exitCode: 0 }),
        cmd({
          command: 'npm test --workspace="b"',
          output: 'FAIL src/x.test.ts',
        }),
        cmd({
          command: 'npm test --workspace="c"',
          timedOut: true,
          exitCode: null,
        }),
      ],
      (command, cwd) => {
        calls.push(command);
        cwds.push(cwd);
        return cmd({ command, output: '' });
      },
    );
    // Green suites have nothing to attribute; a timeout is infrastructure.
    expect(calls).toEqual(['npm test --workspace="b"']);
    // …and the rerun happens in the BASE tree, which the name promises and
    // nothing asserted: running it in the PR worktree would compare a tree
    // with itself and report every failure pre-existing.
    expect(cwds).toEqual([baseline]);
  });

  it('an empty netNew with everything shared is the pre-existing verdict', () => {
    // The live-run case this exists for: 3 env-sensitive failures that the
    // model previously had to JUDGE as pre-existing become a measurement.
    const failing =
      ' FAIL  src/extensionManager.test.ts > a\n FAIL  src/session-writer-lease.test.ts > b';
    const r = runWith([cmd({ output: failing })], failing);
    expect(r.netNew).toEqual([]);
    expect(r.shared).toEqual([
      'src/extensionManager.test.ts',
      'src/session-writer-lease.test.ts',
    ]);
  });

  it('discloses a failed command whose failing files could not be parsed', () => {
    const r = runWith(
      [cmd({ output: 'npm error code 1 — no FAIL lines here' })],
      '',
    );
    expect(r.entries[0].unparsed).toBe(true);
    expect(r.netNew).toEqual([]);
    expect(r.note).toContain('no parseable failing file');
    expect(r.note).toContain('judge them by the diff as before');
  });

  it('treats a timed-out base rerun as infrastructure, not as "nothing fails on base"', () => {
    const r = runWith([cmd({ output: 'FAIL src/x.test.ts' })], () =>
      cmd({ timedOut: true, exitCode: null, output: '' }),
    );
    // The PR-side failure is NOT promoted to netNew off a run that never
    // finished — an unknowable base failing set attributes nothing. (First
    // written asserting only the note, this test passed over an implementation
    // that promoted everything; the two lines below are the actual claim.)
    expect(r.entries[0].base.timedOut).toBe(true);
    expect(r.netNew).toEqual([]);
    expect(r.entries[0].shared).toEqual([]);
    expect(r.note).toContain('timed out');
  });

  it('does NOT read a base rerun that failed without failing files as green', () => {
    // An install/toolchain failure exits non-zero with zero FAIL lines; scoring
    // it "base green" would promote every PR-side failure to net-new.
    const r = runWith([cmd({ output: 'FAIL src/x.test.ts' })], () =>
      cmd({ exitCode: 1, output: 'npm ERR! missing script: test' }),
    );
    expect(r.netNew).toEqual([]);
    expect(r.entries[0].shared).toEqual([]);
  });

  it('has nothing to do when every PR-side test command passed', () => {
    const r = runWith([cmd({ exitCode: 0 })], '');
    expect(r.entries).toEqual([]);
    expect(r.note).toContain('nothing to attribute');
  });

  it('stops at the whole-command budget and discloses what it skipped', () => {
    // Three failed commands x 300s default would blow the 600s tool ceiling
    // with no report at all. The exec seam eats the budget in one call.
    const real = Date.now;
    let t = 0;
    Date.now = () => (t += 300_000);
    try {
      const r = runWith(
        [
          cmd({
            command: 'npm test --workspace="a"',
            output: 'FAIL a/x.test.ts',
          }),
          cmd({
            command: 'npm test --workspace="b"',
            output: 'FAIL b/y.test.ts',
          }),
        ],
        ' FAIL a/x.test.ts',
      );
      expect(r.entries).toHaveLength(1);
      expect(r.note).toContain('budget was exhausted');
      expect(r.note).toContain('npm test --workspace="b"');
    } finally {
      Date.now = real;
    }
  });

  it('refuses an unreadable report and a missing base tree without throwing', () => {
    expect(
      runTestDelta({ report: join(dir, 'nope.json'), baseline, timeout: 60 })
        .note,
    ).toMatch(/cannot read/);
    expect(
      runTestDelta({
        report: writeReport([cmd({ output: 'FAIL src/x.test.ts' })]),
        baseline: join(dir, 'no-such-base'),
        timeout: 60,
      }).note,
    ).toMatch(/base-tree/);
  });
});
