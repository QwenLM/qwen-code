/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The parser and the attribution are the two halves that matter: a wrong
// failing-file parse invents or drops evidence, and a wrong delta turns a
// pre-existing flake into a public Critical (or the reverse). The base rerun
// itself is a seam — one command in one cwd — so the exec is injected.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import {
  testDeltaCommand,
  type TestDeltaArgs,
  failingFilesOf,
  runTestDelta,
  type TestDeltaReport,
} from './test-delta.js';
import type { BuildTestReport, CommandResult } from './build-test.js';

// A passthrough spy on the real spawn: the fractional-timeout pin below must
// observe the OPTIONS handed to spawnSync. A reverted coercion throws
// ERR_OUT_OF_RANGE synchronously and nothing on the call path catches it, so
// the outcome-level test catches the revert as a hard failure — but a crash
// only proves spawn REJECTED the value; this probe proves what it RECEIVED.
const spawnSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import('node:child_process');
  spawnSpy.mockImplementation((...args: unknown[]) =>
    (actual.spawnSync as (...a: unknown[]) => unknown)(...args),
  );
  const mod = { ...actual, spawnSync: spawnSpy };
  return { ...mod, default: mod };
});

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

  it('keeps the workspace project token IN the identity', () => {
    // Dropping it collapsed same-named files across workspaces, so a PR-caused
    // failure in one package could read as pre-existing because another package
    // has a file by the same name.
    const out = ' FAIL  |@qwen-code/qwen-code| src/commands/x.test.ts > case';
    expect(failingFilesOf(out)).toEqual([
      '@qwen-code/qwen-code::src/commands/x.test.ts',
    ]);
  });

  it("normalises paths against each run's own root before comparing", () => {
    // The two sides run in DIFFERENT roots; comparing absolute paths verbatim
    // made every pre-existing failure a fabricated netNew.
    expect(
      failingFilesOf(' FAIL  /wt/pr/src/a.test.ts > flaky', '/wt/pr'),
    ).toEqual(['src/a.test.ts']);
    expect(
      failingFilesOf(' FAIL  /wt/base/src/a.test.ts > flaky', '/wt/base'),
    ).toEqual(['src/a.test.ts']);
  });

  it('reads a Windows path shape', () => {
    // A missed parse is an unattributed failure, not a loud error.
    // Backslashes normalise to `/` so a Windows path compares with its
    // POSIX-printed twin on the other side.
    expect(failingFilesOf(' FAIL  C:\\repo\\src\\x.test.ts > case')).toEqual([
      'C:/repo/src/x.test.ts',
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
    now?: () => number,
  ): TestDeltaReport =>
    runTestDelta({
      report: writeReport(test),
      baseline,
      timeout: 60,
      now,
      // Hermetic: the real gate reads the operator's own settings, and this
      // helper's tests are about attribution, not about containment.
      refuse: () => null,
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

  it('refuses the base-side rerun under `required` instead of running it on the host', () => {
    // The PR side now runs in a container with an env allowlist and no
    // network. Running the base side on the host anyway does not just break
    // the operator's `required` — it makes the two sides incomparable, and
    // this file exists to compare them. So under `required` with no usable
    // containment the answer is "not measured", never a delta between two
    // differently-shaped runs.
    vi.stubEnv('QWEN_REVIEW_SANDBOX', 'required');
    let ran = 0;
    try {
      const r = runTestDelta({
        report: writeReport([cmd({ output: ' FAIL  src/new.test.ts > x' })]),
        baseline,
        timeout: 60,
        exec: (command) => {
          ran += 1;
          return cmd({ command, output: '' });
        },
      });
      // The rerun did not happen at all — asserting only on the note would
      // pass just as well with the host run still going ahead behind it.
      expect(ran).toBe(0);
      expect(r.entries).toEqual([]);
      expect(r.netNew).toEqual([]);
      // ...and it says so in the words that stop `netNew: []` from being read
      // as "no regression".
      expect(r.note).toContain('NOTHING was attributed');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('measures the base side normally when no policy demands containment', () => {
    // The other half of the gate: without `required` nothing changes, so the
    // refusal above cannot be a blanket "test-delta stopped working".
    let ran = 0;
    const r = runTestDelta({
      report: writeReport([cmd({ output: ' FAIL  src/new.test.ts > x' })]),
      baseline,
      timeout: 60,
      refuse: () => null,
      exec: (command) => {
        ran += 1;
        return cmd({ command, output: '' });
      },
    });
    expect(ran).toBe(1);
    expect(r.entries).toHaveLength(1);
  });

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

  it('does not admit a timed-out NON-Maven command that merely echoes a maven marker', () => {
    // R2-2 over-inclusion: the timed-out arm gates on the STRUCTURED Maven
    // fact, so an `npm test` that echoes a `[maven-test-failure] ` line
    // (this repo's own suites carry literal marker strings failing
    // assertions echo) is not admitted and re-executed — a green rerun
    // would manufacture netNew failures out of an infrastructure timeout.
    const calls: string[] = [];
    runWith(
      [
        cmd({
          command: 'npm test',
          timedOut: true,
          exitCode: null,
          output: '[maven-test-failure] core/target/x.xml: T#fails',
        }),
      ],
      (command) => {
        calls.push(command);
        return cmd({ command, output: '' });
      },
    );
    expect(calls).toEqual([]);
  });

  it('admits a timed-out Maven command carrying stdout-only failure evidence', () => {
    // R2-2 under-inclusion: a timed-out `./mvnw test` with a failing
    // Surefire summary but NO report markers still carries failure evidence
    // and must join the disclosure, not drop out to the all-clear note (the
    // opposite of build-test's verdict). A Maven command never matches the
    // rerun grammar, so it lands in skippedUnrecognised.
    const r = runWith(
      [
        cmd({
          command:
            './mvnw --batch-mode --no-transfer-progress -pl core -am test',
          timedOut: true,
          exitCode: null,
          output: '[ERROR] Tests run: 5, Failures: 2, Errors: 0, Skipped: 0',
          maven: { lifecycle: 'test', modules: ['core'], alsoMake: true },
        }),
      ],
      () => cmd({ output: '' }),
    );
    expect(r.note).not.toContain('no PR-side test command failed');
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

  it('does NOT read a base that failed to RUN as "nothing fails on base"', () => {
    // An unbuilt base tree, a missing install, a workspace the PR added: each
    // exits non-zero with zero FAIL lines. Reading that as green manufactures
    // the strongest evidence this command emits from a base that never ran.
    const r = runWith([cmd({ output: ' FAIL  src/a.test.ts > case' })], () =>
      cmd({
        exitCode: 1,
        output:
          'Error: Cannot find module vitest/dist/cli.js\nnpm error code 1',
      }),
    );
    expect(r.netNew).toEqual([]);
    expect(r.entries[0].shared).toEqual([]);
    expect(r.note).toContain('did not measure the base');
  });

  it('reads an external SIGTERM kill as a timeout, like build-test does', () => {
    // The substring form missed it: no ETIMEDOUT message, no exit code — so
    // timedOut:false with empty output, feeding the base-green path above.
    const r = runWith([cmd({ output: ' FAIL  src/a.test.ts > case' })], () =>
      cmd({ timedOut: true, exitCode: null, output: '' }),
    );
    expect(r.netNew).toEqual([]);
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
    // --timeout is PER COMMAND: three failures at the 300s default is 900s
    // against a 600s tool ceiling, killed with NO report at all.
    // The injected clock is the command's own seam — reassigning the global
    // `Date.now` leaks into every other test in the file if an assertion
    // throws before the `finally`.
    let t = 0;
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
      () => (t += 300_000),
    );
    expect(r.entries).toHaveLength(1);
    expect(r.note).toContain('budget was exhausted');
    expect(r.note).toContain('npm test --workspace="b"');
    // Structured, not prose-only: the skipped commands must be readable
    // without substring-matching the note.
    expect(r.skippedForBudget).toEqual(['npm test --workspace="b"']);
  });

  it('skips a command the remaining window cannot fit, rather than timing it out', () => {
    // The floor is priced against the command's OWN measured duration, the way
    // test-efficacy prices a mutant run. A flat 5s floor admitted this command
    // with 40s left, handed it a 40s deadline, and the guaranteed timeout was
    // then disclosed as "infrastructure, not evidence" — a budget exhaustion
    // wearing the wrong label, and the two tell the reader different things.
    // startedAt, the first command's check, then the second's: 500s of the
    // 540s budget are gone by then, so 40s remain against a 60s slot.
    const ticks = [0, 0, 500_000];
    let i = 0;
    const clock = () => ticks[Math.min(i++, ticks.length - 1)];
    const r = runWith(
      [
        cmd({
          command: 'npm test --workspace="a"',
          output: 'FAIL a/x.test.ts',
          seconds: 120,
        }),
        cmd({
          command: 'npm test --workspace="b"',
          output: 'FAIL b/y.test.ts',
          seconds: 120,
        }),
      ],
      ' FAIL a/x.test.ts',
      clock,
    );
    expect(r.skippedForBudget).toEqual(['npm test --workspace="b"']);
    expect(r.note).toContain('budget was exhausted');
    expect(r.note).not.toContain('timed out');
  });

  it('never hands a command outside the emitter grammar to a shell', () => {
    // The report is a file this reads and then executes from with shell:true.
    // A workspace token is a DIRECTORY, and a directory is a name a pull
    // request chooses — so the grammar, not the reader, is the boundary.
    const ran: string[] = [];
    const r = runWith(
      [
        cmd({
          command: 'npm test --workspace="packages/x";touch /tmp/pwned;"',
          output: 'FAIL src/a.test.ts',
        }),
      ],
      (command) => {
        ran.push(command);
        return cmd({ command, output: '' });
      },
    );
    expect(ran).toEqual([]);
    expect(r.entries).toEqual([]);
    expect(r.netNew).toEqual([]);
    expect(r.note).toContain('outside the npm rerun grammar');
    expect(r.note).toContain('judge them by the diff');
  });

  it('refuses the Maven lifecycle commands the Maven adapter records', () => {
    // build-test's test[] can now carry Maven command strings; the rerun
    // grammar stays npm-only. Pin the guard so a future widening of
    // RERUNNABLE_COMMAND_RE — or a Maven report handed straight to
    // `qwen review test-delta --report` — cannot re-execute a Maven
    // lifecycle command in the base worktree.
    const ran: string[] = [];
    const r = runWith(
      [
        cmd({
          command:
            './mvnw --batch-mode --no-transfer-progress -pl core -am test',
          output: '[ERROR] Tests failed',
        }),
      ],
      (command) => {
        ran.push(command);
        return cmd({ command, output: '' });
      },
    );
    expect(ran).toEqual([]);
    expect(r.entries).toEqual([]);
    expect(r.note).toContain('outside the npm rerun grammar');
    // The disclosure names the deliberate exclusion, not a grammar accident.
    expect(r.note).toContain('Maven lifecycle commands');
  });

  it('reads the exit-0 Maven verdict flags as failures, not an all-clear', () => {
    // The adapter marks these runs ok:false at exit 0 — a fail-never
    // setting swallowing failures, a skip setting suppressing the phase,
    // a wrapper that never started Maven, evidence the adapter refused to
    // certify. Reading "no PR-side test command failed" off the exit
    // codes alone would state the opposite of build-test's verdict. The
    // commands are still never re-executed (the npm rerun grammar), but
    // they join the disclosure instead of the reassuring all-clear.
    for (const flag of [
      { swallowedFailure: true },
      { testsSuppressed: true },
      { neverRan: true },
      { evidenceCapped: true },
      // Exit 0 over fresh FAILING reports: no other flag fires for this
      // shape, and missing it reported the all-clear over a run build-test
      // marked ok:false.
      { swallowedReports: true },
    ] as const) {
      const ran: string[] = [];
      const r = runWith(
        [
          cmd({
            command: './mvnw --batch-mode --no-transfer-progress test',
            exitCode: 0,
            ...flag,
          }),
        ],
        (command) => {
          ran.push(command);
          return cmd({ command, output: '' });
        },
      );
      expect(ran).toEqual([]);
      expect(r.note).not.toContain('no PR-side test command failed');
      expect(r.note).toContain('outside the npm rerun grammar');
    }
  });

  it('reruns both shapes build-test actually emits', () => {
    const ran: string[] = [];
    runWith(
      [
        cmd({ command: 'npm test', output: 'FAIL src/a.test.ts' }),
        cmd({
          command: 'npm test --workspace="packages/core"',
          output: 'FAIL src/b.test.ts',
        }),
      ],
      (command) => {
        ran.push(command);
        return cmd({ command, output: '' });
      },
    );
    expect(ran).toEqual(['npm test', 'npm test --workspace="packages/core"']);
  });

  it('holds the 30s floor: a FAST command is still skipped, not clamped', () => {
    // The floor is what separates "skipped, judge it by the diff" from
    // "started, timed out, disclosed as infrastructure". A 5s floor admits a
    // one-second command into a twenty-second window, where it gets a deadline
    // it cannot meet and comes back labelled `budgetClamped` — the exact
    // mislabelling the priced floor exists to prevent. Every other budget test
    // leaves the floor non-binding, so only this one moves if it regresses.
    const ticks = [0, 0, 520_000]; // 520s of the 540s budget gone -> 20s left
    let i = 0;
    const r = runWith(
      [
        cmd({
          command: 'npm test --workspace="a"',
          output: 'FAIL a/x.test.ts',
          seconds: 1,
        }),
        cmd({
          command: 'npm test --workspace="b"',
          output: 'FAIL b/y.test.ts',
          seconds: 1,
        }),
      ],
      ' FAIL a/x.test.ts',
      () => ticks[Math.min(i++, ticks.length - 1)],
    );
    expect(r.note).toContain('npm test --workspace="b"');
    expect(r.note).toContain('the whole-command budget was exhausted');
    expect(r.note).not.toContain('timed out');
  });

  it('prefers the failing set the run measured over re-parsing trimmed output', () => {
    // The base rerun parses its own raw text; `output` is only the bounded copy
    // that lands in the report. Re-parsing it would lose whatever the trim's
    // omitted middle swallowed, and a SHORT base set fabricates netNew.
    const r = runWith(
      [cmd({ output: 'FAIL src/a.test.ts\nFAIL src/b.test.ts' })],
      () => ({
        ...cmd({}),
        output: 'FAIL src/a.test.ts\n\n... [90000 characters omitted] ...\n',
        failingFiles: ['src/a.test.ts', 'src/b.test.ts'],
      }),
    );
    expect(r.netNew).toEqual([]);
    expect(r.shared).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  });

  it("prefers the PR side's capture-time set, so a trimmed netNew survives", () => {
    // The direction that matters: `src/z.test.ts` fails on the PR side only.
    // Re-parsing the trimmed report finds only `src/a.test.ts` and reports an
    // EMPTY netNew — a failure the PR caused, measured away. The report that
    // carries `failingFiles` was measured before the trim, so it still says so.
    const r = runWith(
      [
        cmd({
          output: 'FAIL src/a.test.ts\n\n... [120000 characters omitted] ...\n',
          failingFiles: ['src/a.test.ts', 'src/z.test.ts'],
        }),
      ],
      'FAIL src/a.test.ts',
    );

    expect(r.netNew).toEqual(['src/z.test.ts']);
    expect(r.shared).toEqual(['src/a.test.ts']);
    // The trim marker is still in `output`; the disclosure would be a false
    // alarm now that the set no longer comes from there.
    expect(r.entries[0].prTruncated).toBe(false);
    expect(r.note ?? '').not.toContain('may be partial');
  });

  it('treats a malformed failingFiles as no measurement, not a crash', () => {
    // The report is a file anything may have edited. A field that is not a
    // string array must read as "this seam supplied no measurement" — the
    // fallback an absent field has always taken — never reach `.filter` as-is.
    // `[]` too: the producer omits the field when nothing parsed, so an empty
    // array can only be hand-made — taken as authoritative it would skip the
    // reparse and understate both sets.
    for (const bad of ['a string', [null], [{ file: 'x' }], 42, []]) {
      const r = runWith(
        [
          cmd({
            output: 'FAIL src/a.test.ts',
            failingFiles: bad as unknown as string[],
          }),
        ],
        'FAIL src/a.test.ts',
      );
      // The reparse fallback still measures off the stored output.
      expect(r.shared).toEqual(['src/a.test.ts']);
      expect(r.netNew).toEqual([]);
    }
  });

  it('discloses a PR-side output that was already trimmed', () => {
    // build-test trimmed it before this command ran, so the PR failing set may
    // be short. That understates `shared`; it cannot invent a netNew. Say so.
    const r = runWith(
      [
        cmd({
          output:
            'FAIL src/a.test.ts\n\n... [120000 characters omitted] ...\nFAIL src/z.test.ts',
        }),
      ],
      'FAIL src/a.test.ts',
    );
    expect(r.note).toContain('may be partial');
    expect(r.entries[0].prTruncated).toBe(true);
  });

  it('says nothing about trimming when the PR output was complete', () => {
    const r = runWith(
      [cmd({ output: 'FAIL src/a.test.ts' })],
      'FAIL src/a.test.ts',
    );
    expect(r.note).not.toContain('may be partial');
    expect(r.entries[0].prTruncated).toBe(false);
  });

  it('says when a rerun died on a BUDGET-shortened deadline, not its own', () => {
    // Otherwise "timed out — infrastructure" sends the reader hunting a hang
    // that is really an exhausted budget, and a rerun with room to spare would
    // have measured it.
    let t = 0;
    // `runWith` passes timeout: 60, so `remaining` must fall below the 60s
    // per-command deadline while staying above the skip threshold (the
    // command's own 10s duration, floored at 30s). Each call advances 490s:
    // startedAt lands at 490s, the first iteration sees remaining = 540 − 490
    // = 50s — enough to start, not enough to finish — and the second falls
    // past the threshold entirely.
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
      (command) => cmd({ command, timedOut: true, exitCode: null, output: '' }),
      () => (t += 490_000),
    );
    expect(r.note).toContain('the whole-command budget shortened');
  });

  it('coerces a fractional --timeout at the spawn boundary', () => {
    // A decimal --timeout lands as a fractional deadline (60.123s * 1000
    // = 60122.99999999999); spawnSync validates `timeout` as an unsigned
    // integer and throws ERR_OUT_OF_RANGE on the raw value — with no
    // report at all. Every other test injects the exec seam and bypasses
    // the coercion, so this one drives the REAL spawn.
    const r = runTestDelta({
      report: writeReport([
        cmd({ command: 'npm test', output: 'FAIL src/a.test.ts' }),
      ]),
      baseline,
      timeout: 60.1234,
    });
    // The rerun executed (npm fails fast in the empty base dir) instead
    // of throwing out of the whole call.
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].base.timedOut).toBe(false);
    // The base output is the trim's TEXT — a plain string, never the
    // `{text, evidenceDropped}` shape trimOutput returns. Losing the
    // `.text` adaptation would serialize a nested object into the report.
    expect(typeof r.entries[0].base.output).toBe('string');
  });

  it('hands spawnSync an integral, positive timeout for a fractional budget', () => {
    // The outcome-level probe above catches a reverted coercion as a hard
    // crash — the ERR_OUT_OF_RANGE throw propagates out of the whole call,
    // so NO report of any shape is produced — but the crash only proves
    // spawn rejected the value; pin the spawn OPTIONS directly to prove
    // what it received. The input is genuinely fractional (60.1234 * 1000
    // is not integral): 60.123 used to pass even with the coercion
    // reverted, because its deadline is exact in JS.
    spawnSpy.mockClear();
    runTestDelta({
      report: writeReport([
        cmd({ command: 'npm test', output: 'FAIL src/a.test.ts' }),
      ]),
      baseline,
      timeout: 60.1234,
    });
    const opts = spawnSpy.mock.calls[0]?.[1] as { timeout?: number };
    expect(Number.isInteger(opts.timeout)).toBe(true);
    expect(opts.timeout).toBeGreaterThanOrEqual(1);
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

describe('the CLI option contract', () => {
  // Every test above builds its args by hand. That is how the flag-name bug
  // got into `test-plan`: yargs camel-cases `--build-test` to `buildTest`, a
  // field named for the flag read `undefined` on every real invocation, and
  // the suite stayed green because nothing went through yargs.
  //
  // `--pr-worktree` has the worst failure mode of any flag here: arriving
  // undefined, root stripping silently stops and EVERY pre-existing failure
  // becomes a fabricated netNew. So this test does not assert the parsed
  // shape and stop — it feeds the parsed object straight into runTestDelta
  // and asserts on an attribution only reachable when the root was stripped.
  let dir: string;
  let baseDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qwen-test-delta-cli-'));
    baseDir = join(dir, 'base');
    mkdirSync(baseDir);
    writeFileSync(
      join(dir, 'bt.json'),
      JSON.stringify({
        test: [
          {
            command: 'npm test',
            exitCode: 1,
            seconds: 1,
            timedOut: false,
            // Absolute, under the PR worktree root.
            output: ' FAIL  /wt/pr/src/flaky.test.ts > env',
          },
        ],
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parses --pr-worktree into the field runTestDelta actually reads', () => {
    const parsed = (testDeltaCommand.builder as (y: Argv) => Argv)(
      yargs([]),
    ).parseSync([
      '--report',
      join(dir, 'bt.json'),
      '--baseline',
      baseDir,
      '--pr-worktree',
      '/wt/pr',
    ]) as unknown as TestDeltaArgs;

    const report = runTestDelta({
      ...parsed,
      refuse: () => null,
      // The base side prints the SAME failure under its own root.
      exec: (command) => ({
        command,
        exitCode: 1,
        seconds: 1,
        timedOut: false,
        output: ` FAIL  ${baseDir}/src/flaky.test.ts > env`,
      }),
    });

    // Reachable ONLY if both roots were stripped: unstripped, the two absolute
    // paths differ and the pre-existing failure is reported as the PR's own.
    expect(report.netNew).toEqual([]);
    expect(report.shared).toEqual(['src/flaky.test.ts']);
  });
});
