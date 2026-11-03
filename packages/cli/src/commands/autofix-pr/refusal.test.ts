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
  it('gives every code a step for every helper', () => {
    const steps = new Set<RefusalNext>([
      'retry',
      'stop',
      'end_task',
      'take_over',
      'discard',
      'foreground',
      'rerun',
      'needs_human',
      'fix_plan',
      'report',
    ]);
    for (const command of COMMANDS) {
      for (const code of REFUSAL_CODES) {
        expect(steps.has(nextStep(command, code))).toBe(true);
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

  it('answers a rejected promise the same way', async () => {
    await run(command(() => Promise.reject(new Error('gh: HTTP 502'))));
    expect(JSON.parse(mocks.stderr.mock.calls[0][0])).toEqual({
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
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return (err as AutofixPrRefusal).code;
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
    expect(codeOf(() => assertWatching(state(), 'aaaaaaaaaaaa'))).toBe(
      undefined,
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

  // Every helper, in a directory with no watch and a `gh` that fails: each
  // refuses with its coded line, whichever check stops it first.
  it.each([
    ['prepare', '7', '--repo', 'o/r'],
    ['snapshot', '7'],
    ['ci-log', '7', '1'],
    ['push', '7'],
    ['sync', '7'],
    ['reply', '7', 'plan.json'],
    ['rerun', '7', '1'],
    ['schedule', '7'],
    ['fix-start', '7', '--attempt', '0123456789ab'],
    ['fix-end', '7', '--attempt', '0123456789ab'],
    ['cleanup', '7'],
  ])('prints the refusal of %s as its coded line', async (...argv) => {
    await yargs()
      .command(autofixPrCommand)
      .strict()
      .exitProcess(false)
      .parseAsync(['autofix-pr', ...argv]);
    expect(process.exitCode).toBe(1);
    const line = JSON.parse(String(mocks.stderr.mock.calls.at(-1)?.[0]));
    expect(REFUSAL_CODES).toContain(line.refused);
    expect(line.next).toBe(nextStep(argv[0], line.refused));
    expect(typeof line.message).toBe('string');
  });
});
