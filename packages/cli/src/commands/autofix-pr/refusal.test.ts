/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import yargs, { type CommandModule } from 'yargs';
import { autofixPrCommand } from '../autofix-pr.js';

const mocks = vi.hoisted(() => ({
  stderr: vi.fn((_line: string) => {}),
  stdout: vi.fn((_line: string) => {}),
}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mocks.stderr,
  writeStdoutLine: mocks.stdout,
  writeStderrLineSafe: () => {},
}));

import {
  AutofixPrRefusal,
  MAX_REFUSAL_MESSAGE,
  REFUSAL_CODES,
  nextStep,
  refusalOf,
  withRefusals,
  type RefusalCode,
  type RefusalNext,
} from './refusal.js';
import {
  assertOwnedBySession,
  assertWatching,
  autofixPrPaths,
  requireState,
  withWatchLock,
  type AutofixPrState,
} from './state.js';

const COMMANDS = [
  'prepare',
  'snapshot',
  'ci-log',
  'push',
  'sync',
  'reply',
  'rerun',
  'schedule',
  'fix-start',
  'fix-end',
  'status',
  'cleanup',
];

describe('nextStep', () => {
  // Every code of every helper: its step, then the helpers that differ.
  const ROUND = ['snapshot', 'ci-log', 'push', 'sync', 'reply', 'rerun'];
  const SPEC: Record<
    RefusalCode,
    [RefusalNext, Array<[string[], RefusalNext]>]
  > = {
    busy: ['retry', []],
    partial: ['retry', []],
    pr_closed: ['stop', [[['prepare'], 'report']]],
    not_prepared: ['report', [[ROUND, 'end_task']]],
    watch_stopped: ['report', [[ROUND, 'end_task']]],
    task_replaced: ['report', [[ROUND, 'end_task']]],
    watched_elsewhere: [
      'report',
      [
        [ROUND, 'end_task'],
        [['prepare'], 'take_over'],
      ],
    ],
    fix_in_flight: ['report', []],
    worktree_dirty: [
      'report',
      [
        [['sync'], 'discard'],
        [['push'], 'needs_human'],
      ],
    ],
    no_failed_job: ['rerun', []],
    no_background_fix: ['foreground', []],
    rerun_failed: ['needs_human', []],
    push_failed: ['needs_human', []],
    plan_invalid: ['fix_plan', []],
    failed: [
      'report',
      [
        [['push', 'rerun'], 'needs_human'],
        [['reply'], 'retry'],
      ],
    ],
  };

  it('gives every code of every helper the step the skill takes', () => {
    expect(Object.keys(SPEC).sort()).toEqual([...REFUSAL_CODES].sort());
    for (const code of REFUSAL_CODES) {
      const [step, except] = SPEC[code];
      for (const command of COMMANDS) {
        const want =
          except.find(([commands]) => commands.includes(command))?.[1] ?? step;
        expect(`${command} ${code} → ${nextStep(command, code)}`).toBe(
          `${command} ${code} → ${want}`,
        );
      }
    }
  });

  it.each<[string, RefusalCode, RefusalNext]>([
    // Another helper holds the lock: it did nothing, so the call is run again.
    ['sync', 'busy', 'retry'],
    ['prepare', 'busy', 'retry'],
    ['fix-end', 'busy', 'retry'],
    ['snapshot', 'partial', 'retry'],
    // A merged or closed PR stops a watch; a start has none to stop.
    ['sync', 'pr_closed', 'stop'],
    ['reply', 'pr_closed', 'stop'],
    ['rerun', 'pr_closed', 'stop'],
    ['prepare', 'pr_closed', 'report'],
    // A round's helper refused for its task ends that task.
    ['sync', 'not_prepared', 'end_task'],
    ['snapshot', 'watch_stopped', 'end_task'],
    ['push', 'task_replaced', 'end_task'],
    ['ci-log', 'watched_elsewhere', 'end_task'],
    // Outside a round, the same refusals are reported.
    ['schedule', 'watched_elsewhere', 'report'],
    ['cleanup', 'watched_elsewhere', 'report'],
    ['status', 'not_prepared', 'report'],
    ['fix-end', 'task_replaced', 'report'],
    // A start asks whether to take the watch over.
    ['prepare', 'watched_elsewhere', 'take_over'],
    // Work an earlier round left: sync discards it, push answers for it.
    ['sync', 'worktree_dirty', 'discard'],
    ['push', 'worktree_dirty', 'needs_human'],
    ['snapshot', 'worktree_dirty', 'report'],
    ['sync', 'fix_in_flight', 'report'],
    ['cleanup', 'fix_in_flight', 'report'],
    // A fix in flight is no failure of the push's or the re-run's items.
    ['push', 'fix_in_flight', 'report'],
    ['rerun', 'fix_in_flight', 'report'],
    ['ci-log', 'no_failed_job', 'rerun'],
    ['fix-start', 'no_background_fix', 'foreground'],
    ['rerun', 'rerun_failed', 'needs_human'],
    ['push', 'push_failed', 'needs_human'],
    ['reply', 'plan_invalid', 'fix_plan'],
    // Anything else stops a push or a re-run for its items, and is
    // reported elsewhere.
    ['push', 'failed', 'needs_human'],
    ['rerun', 'failed', 'needs_human'],
    ['reply', 'failed', 'retry'],
    ['prepare', 'failed', 'report'],
  ])('%s refused with %s → %s', (command, code, next) => {
    expect(nextStep(command, code)).toBe(next);
  });
});

describe('refusalOf', () => {
  it('keeps the longest line well inside the 16 KiB of stderr the tool keeps', () => {
    // packages/core/src/tools/autofix-pr.ts: STDERR_CAP_CHARS = 16 * 1024,
    // the tail of a helper's stderr the tool reads the coded line from.
    const STDERR_CAP_CHARS = 16 * 1024;
    for (const worst of ['"', '\\', 'x', '\n', '\u2603']) {
      const line = JSON.stringify(
        refusalOf('rerun_failed', new Error(worst.repeat(100_000))),
      );
      expect(line.length).toBeLessThanOrEqual(MAX_REFUSAL_MESSAGE + 100);
    }
    expect(MAX_REFUSAL_MESSAGE + 100).toBeLessThan(STDERR_CAP_CHARS / 2);
  });

  it('keeps the head and the tail of a message too long for one line', () => {
    const long = `push failed:${'x'.repeat(20_000)}remote: denied`;
    const { message } = refusalOf('push', new Error(long));
    expect(message.length).toBeLessThanOrEqual(MAX_REFUSAL_MESSAGE + 3);
    expect(message.startsWith('push failed:')).toBe(true);
    expect(message.endsWith('remote: denied')).toBe(true);
  });

  it('drops escape sequences whole, C1 controls and bidi overrides, and keeps tabs and newlines', () => {
    const { message } = refusalOf(
      'push',
      new Error(
        'hook:\n\t\u001b[31mfatal\u001b[0m \u009b31mred \u202eevil\u202c \u200bzero\r\n',
      ),
    );
    expect(message).toBe('hook:\n\tfatal red evil zero\n');
  });

  it('drops terminal controls, and fits the message as JSON, not as text', () => {
    // A pre-push hook's output: colours and `\r` progress, six characters
    // each in JSON, and quotes, two.
    const noisy = `git push to feat failed:\n${'\u001b[31m"x"\r'.repeat(3000)}remote: denied`;
    const { message } = refusalOf('push', new Error(noisy));
    expect(
      [...message].filter((c) => c < ' ' && c !== '\n' && c !== '\t'),
    ).toEqual([]);
    expect(JSON.stringify(message).length).toBeLessThanOrEqual(
      MAX_REFUSAL_MESSAGE,
    );
    expect(message.startsWith('git push to feat failed:\n')).toBe(true);
    expect(message.endsWith('remote: denied')).toBe(true);
    // Short as text, twice as long as JSON: still cut.
    const quoted = refusalOf('push', new Error('"'.repeat(7000))).message;
    expect(quoted.length).toBeLessThan(7000);
    expect(JSON.stringify(quoted).length).toBeLessThanOrEqual(
      MAX_REFUSAL_MESSAGE,
    );
  });

  it('reads the code of a refusal', () => {
    expect(
      refusalOf('sync', new AutofixPrRefusal('worktree_dirty', 'dirty')),
    ).toEqual({ refused: 'worktree_dirty', next: 'discard', message: 'dirty' });
  });

  it('takes any other error for a failure', () => {
    expect(refusalOf('push', new Error('git push to feat failed'))).toEqual({
      refused: 'failed',
      next: 'needs_human',
      message: 'git push to feat failed',
    });
    expect(refusalOf('status', 'odd')).toEqual({
      refused: 'failed',
      next: 'report',
      message: 'odd',
    });
  });
});

describe('withRefusals', () => {
  afterEach(() => {
    process.exitCode = undefined;
    mocks.stderr.mockClear();
  });

  const command = (handler: () => unknown): CommandModule => ({
    command: 'rerun <pr> <run-id>',
    describe: 'x',
    handler: handler as CommandModule['handler'],
  });
  const run = (module: CommandModule) =>
    withRefusals(module).handler({ _: [], $0: 'qwen' });

  it('prints a refusal as one JSON line, without a stack, and exits 1', async () => {
    await run(
      command(() => {
        throw new AutofixPrRefusal('pr_closed', 'PR #7 is merged');
      }),
    );
    expect(mocks.stderr.mock.calls).toEqual([
      [
        JSON.stringify({
          refused: 'pr_closed',
          next: 'stop',
          message: 'PR #7 is merged',
        }),
      ],
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('prints the frames of a defect before its line, and none for a refusal', async () => {
    await run(
      command(() => {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'x')",
        );
      }),
    );
    const lines = mocks.stderr.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\s+at /);
    expect(JSON.parse(lines[1])).toMatchObject({ refused: 'failed' });
    mocks.stderr.mockClear();
    await run(
      command(() => {
        throw new AutofixPrRefusal('busy', 'another helper');
      }),
    );
    expect(mocks.stderr).toHaveBeenCalledOnce();
  });

  it('answers a rejected promise the same way', async () => {
    await run(command(() => Promise.reject(new Error('gh: HTTP 502'))));
    expect(JSON.parse(String(mocks.stderr.mock.calls.at(-1)?.[0]))).toEqual({
      refused: 'failed',
      next: 'needs_human',
      message: 'gh: HTTP 502',
    });
    expect(process.exitCode).toBe(1);
  });

  it('leaves a helper that answered alone', async () => {
    const handler = vi.fn();
    await run(command(handler));
    expect(handler).toHaveBeenCalledOnce();
    expect(mocks.stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('the refusals of the watch checks', () => {
  const state = (patch: Partial<AutofixPrState> = {}) =>
    ({
      prNumber: 7,
      sessionId: 'session-a',
      watch: { every: 2, reply: true, instructions: '', task: 'aaaaaaaaaaaa' },
      ...patch,
    }) as AutofixPrState;
  /** The code `fn` refused with: anything else it throws is the test's
   * failure, not a refusal. */
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof AutofixPrRefusal) return err.code;
      throw err;
    }
    return undefined;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names each', () => {
    vi.stubEnv('QWEN_CODE_SESSION_ID', 'session-a');
    const dir = mkdtempSync(join(tmpdir(), 'autofix-refusal-'));
    try {
      expect(codeOf(() => requireState(join(dir, 'none.json'), 7))).toBe(
        'not_prepared',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(
      codeOf(() =>
        assertWatching(state({ ended: { at: 'now', reason: 'kept' } })),
      ),
    ).toBe('watch_stopped');
    expect(codeOf(() => assertWatching(state(), 'bbbbbbbbbbbb'))).toBe(
      'task_replaced',
    );
    expect(
      codeOf(() => assertOwnedBySession(state({ sessionId: 'session-b' }))),
    ).toBe('watched_elsewhere');
    expect(() => assertWatching(state(), 'aaaaaaaaaaaa')).not.toThrow();
  });

  it('checks a stopped watch first, then its session, then the task', () => {
    vi.stubEnv('QWEN_CODE_SESSION_ID', 'session-b');
    // Stopped by session A, asked about by B: stopped, not someone else's
    // to take over.
    expect(
      codeOf(() =>
        assertWatching(
          state({ ended: { at: 'now', reason: 'kept' } }),
          'bbbbbbbbbbbb',
        ),
      ),
    ).toBe('watch_stopped');
    // Another session's watch, with its very task: still that session's.
    expect(codeOf(() => assertWatching(state(), 'aaaaaaaaaaaa'))).toBe(
      'watched_elsewhere',
    );
    expect(codeOf(() => assertWatching(state(), 'bbbbbbbbbbbb'))).toBe(
      'watched_elsewhere',
    );
  });

  it('takes a clone with no directory for the lock for one with no watch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofix-refusal-'));
    try {
      const paths = autofixPrPaths(dir, 7);
      expect(existsSync(dirname(paths.lockPath))).toBe(false);
      expect(() => withWatchLock(paths, 7, () => 'ran')).toThrow(
        expect.objectContaining({
          code: 'not_prepared',
          message: expect.stringMatching(/PR #7 is not prepared here/),
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the autofix-pr command', () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'autofix-refusal-cli-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh: no" >&2\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env['PATH']}`);
    process.chdir(dir);
    mocks.stderr.mockClear();
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.unstubAllEnvs();
  });

  // Every helper run through the command, in a clone with no watch and a
  // `gh` that fails: each refuses with its coded line.
  // The two that refuse nothing in an empty clone get what makes them.
  const fixInFlight = (root: string) => {
    const paths = autofixPrPaths(root, 7);
    mkdirSync(dirname(paths.fixPath), { recursive: true });
    writeFileSync(
      paths.fixPath,
      JSON.stringify({
        version: 1,
        attempt: '0123456789ab',
        task: 'aaaaaaaaaaaa',
        head: 'a'.repeat(40),
        startedAt: new Date().toISOString(),
      }),
    );
  };
  // The clone's own `.qwen/tmp` a file: nothing there can be listed.
  const unreadableState = (root: string) => {
    mkdirSync(join(root, '.qwen'), { recursive: true });
    writeFileSync(join(root, '.qwen', 'tmp'), '');
  };

  it.each<[string[], RefusalCode, RefusalNext, ((root: string) => void)?]>([
    [['prepare', '7', '--repo', 'o/r'], 'failed', 'report'],
    [['cleanup', '7'], 'fix_in_flight', 'report', fixInFlight],
    [['status', '7'], 'failed', 'report', unreadableState],
    [['snapshot', '7'], 'not_prepared', 'end_task'],
    [['ci-log', '7', '1'], 'not_prepared', 'end_task'],
    [['push', '7'], 'not_prepared', 'end_task'],
    [['sync', '7'], 'not_prepared', 'end_task'],
    [['reply', '7', 'plan.json'], 'not_prepared', 'end_task'],
    [['rerun', '7', '1'], 'not_prepared', 'end_task'],
    [['schedule', '7'], 'not_prepared', 'report'],
    [['fix-start', '7', '--attempt', '0123456789ab'], 'not_prepared', 'report'],
    [['fix-end', '7', '--attempt', '0123456789ab'], 'not_prepared', 'report'],
  ])(
    'prints the refusal of %j as its coded line',
    async (argv, code, next, make) => {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      make?.(dir);
      writeFileSync(join(dir, 'plan.json'), '{}');
      await yargs()
        .command(autofixPrCommand)
        .strict()
        .exitProcess(false)
        .parseAsync(['autofix-pr', ...argv]);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(mocks.stderr.mock.calls.at(-1)?.[0]))).toEqual({
        refused: code,
        next,
        message: expect.any(String),
      });
    },
  );
});
