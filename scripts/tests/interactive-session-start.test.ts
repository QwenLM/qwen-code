/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No PR-triggered job collects the behavioural cases in
// integration-tests/interactive/interactive-session.test.ts: ci.yml's
// PR-gated integration_no_ak leg runs an explicit allow-list under
// --root ./integration-tests that does not name it, and the whole-root legs
// run post-merge and at release. These byte-shape pins give the #13552
// start() contract a PR-gated witness at ~0ms through test:scripts — each
// assertion names the revert it exists to redden, and each was probe-checked
// against that revert. The behaviour behind them is covered by the
// real-spawn cases beside the module. Patterns that pin a call site must
// tolerate the trailing-comma multi-line form prettier emits past 80
// columns, or a pure reflow reddens a PR-gated lane with no behavioural
// cause.
const source = readFileSync(
  join(
    resolve(import.meta.dirname, '../..'),
    'integration-tests/interactive/interactive-session.ts',
  ),
  'utf8',
);

describe('InteractiveSession.start source pins (#13552)', () => {
  it('threads the resolved ready-prompt budget into the waitFor', () => {
    // A full revert to the literal 30_000 drops the readyPromptBudgetMs call
    // and its import together, and otherwise passes every lane. The call
    // sits one token short of printWidth, so the pattern must also match the
    // trailing-comma multi-line form a reflow emits.
    expect(source).toMatch(
      /session\.waitFor\(\s*'Type your message',\s*readyPromptBudgetMs\(process\.env\),?\s*\)/,
    );
  });

  it('races the ready-prompt wait against child exit, keeping the tail', () => {
    // Reverting the race returns a dead-child boot to a full-budget wait;
    // dropping the tail discards the boot log that made #13552 diagnosable
    // from the job log alone. The exit line stays neutral: whether the
    // prompt reached rawOutput is undecidable once a child out-writes the
    // parent's final read, so a before/after claim can contradict the very
    // tail attached to it.
    expect(source).toContain('Promise.race([');
    expect(source).toContain('ptyProcess.onExit(');
    // Without the latch, close()'s kill() re-runs the handler's strip passes
    // and builds a rejection no settled race observes on every healthy
    // session's teardown.
    expect(source).toContain('if (!startupUndecided) return;');
    expect(source).toContain(
      'CLI exited during startup (code ${exitCode}, signal ${signal})',
    );
    expect(source).toContain(
      'Last 500 chars: ${stripAnsi(session.rawOutput).slice(-500)}',
    );
  });

  it('closes the session a failed start refuses to hand out', () => {
    // Dropping the catch-close orphans the child, pty, and terminal.
    expect(source).toMatch(/catch \(err\) \{[\s\S]*?await session\.close\(\)/);
  });

  it('stops the waitFor poll when the session closes', () => {
    // Without the flag, the race's abandoned loser keeps re-scanning a dead
    // pty's output every 200ms until its own budget expires. The guard is
    // pinned leading waitFor's loop condition — displaced into the body it
    // no longer stops the poll — while prettier's operator-leading reflow of
    // the condition still matches.
    expect(source).toMatch(/while\s*\(\s*!this\.closed\s*&&/);
  });

  it('fails an abandoned poll with the closed-session error', () => {
    // Deleting either statement leaves the loop text intact, so the guard
    // pin alone cannot see it: close() must set the flag, and waitFor must
    // throw on it.
    expect(source).toContain('this.closed = true;');
    expect(source).toContain('Session closed while waiting for text:');
  });

  it('pins the isolated-env loop-switch pass-through', () => {
    // The nightly loop legs export the two switches; deleting the forwarding
    // block (or narrowing it to one switch) leaves the inheritEnv:false
    // suites on the default loop on every arm, and only a nightly run would
    // notice. The guard must forward exactly the two switches, the assignment
    // must be live code, and it must run before the child env is built from
    // baseEnv — otherwise the forwarded values never reach the child.
    expect(source).toMatch(
      /if \(options\?\.inheritEnv === false\) \{[\s\S]*?for \(const key of \[\s*'QWEN_CODE_ENABLE_UNIFIED_AGENT_LOOP',\s*'QWEN_CODE_ENABLE_EVENT_BUS_AGENT_LOOP',?\s*\]\)/,
    );
    const forwardAt = source.search(
      /^\s*if \(process\.env\[key\] !== undefined\)\s*baseEnv\[key\]\s*=\s*process\.env\[key\];$/m,
    );
    const envBuiltAt = source.indexOf('const env = {');
    expect(forwardAt).toBeGreaterThan(-1);
    expect(envBuiltAt).toBeGreaterThan(forwardAt);
  });

  it('pins that a test own env overrides the forwarded switches', () => {
    // The parity control arm pins the switches off through options.env; that
    // only wins if options.env is spread after baseEnv. Reordering the spread
    // re-arms the control arm on the nightly legs.
    expect(source).toMatch(/\.\.\.baseEnv,\s*\.\.\.options\?\.env,/);
  });
});

// Only PTY transport is controlled; the real terminal/parser and helper run.
const lifecyclePty = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('@lydell/node-pty', () => ({ spawn: lifecyclePty.spawn }));
import {
  InteractiveSession,
  type InteractiveSessionLifecycleEvent,
} from '../../integration-tests/interactive/interactive-session.js';

type FakeExit = { exitCode: number; signal?: number };
function fakePty(
  options: {
    ignoreDefault?: boolean;
    defaultError?: boolean;
    force?: 'exit' | 'no-exit' | 'error';
  } = {},
) {
  const pid = 421337;
  const outputs: Array<(data: string) => void> = [];
  const exits: Array<(status: FakeExit) => void> = [];
  let ended = false;
  const exit = (status: FakeExit) => {
    if (ended) return;
    ended = true;
    for (const listener of exits) listener(status);
  };
  const force = () => {
    if (options.force === 'error')
      throw Object.assign(new Error('owned kill failure'), { code: 'EACCES' });
    if (options.force !== 'no-exit') exit({ exitCode: 0, signal: 9 });
  };
  const kill = vi.fn((signal?: string) => {
    if (signal === 'SIGKILL') return force();
    if (options.defaultError) throw new Error('owned default kill failure');
    if (!options.ignoreDefault) exit({ exitCode: 0, signal: 1 });
  });
  lifecyclePty.spawn.mockReturnValue({
    pid,
    kill,
    onData: (fn: (data: string) => void) => {
      outputs.push(fn);
      return { dispose() {} };
    },
    onExit: (fn: (status: FakeExit) => void) => {
      exits.push(fn);
      return { dispose() {} };
    },
  });
  return {
    pid,
    kill,
    force,
    exit,
    data: (data: string) => {
      for (const fn of outputs) fn(data);
    },
  };
}
function settleStart(attempt: Promise<InteractiveSession>) {
  return attempt.then(
    (session) => ({ ok: true as const, session }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
function expectStartupError(
  outcome: Awaited<ReturnType<typeof settleStart>>,
  message: string,
) {
  expect(outcome).toMatchObject({ ok: false, error: expect.any(Error) });
  if (outcome.ok) throw new Error('Expected startup rejection');
  expect(outcome.error).toMatchObject({
    message: expect.stringContaining(message),
  });
}
function expectObserverFields(
  events: InteractiveSessionLifecycleEvent[],
  pid: number,
) {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.pid).toBe(pid);
    expect(event.observerPid).toBe(process.pid);
    expect(event.hrtimeNs).toMatch(/^\d+$/);
  }
  expect(pid).not.toBe(process.pid);
  for (let i = 1; i < events.length; i++) {
    expect(BigInt(events[i].hrtimeNs)).toBeGreaterThanOrEqual(
      BigInt(events[i - 1].hrtimeNs),
    );
  }
}

// No subprocess, Bun, native PTY or OS signal is used by these cases.
describe('InteractiveSession public lifecycle observations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lifecyclePty.spawn.mockReset();
    vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted');
    vi.stubEnv('RUNNER_OS', 'Linux');
    vi.stubEnv('RUNNER_ARCH', 'ARM64');
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reports spawned PTY identity, raw output, readiness and actual exit as observer-owned data', async () => {
    const pty = fakePty();
    const events: InteractiveSessionLifecycleEvent[] = [];
    const attempt = InteractiveSession.start({
      command: { bin: '/owned/fake', args: [] },
      onLifecycle: (event) => {
        events.push(event);
      },
    });
    const settled = settleStart(attempt);
    const raw = '\x1b[32mType your message\x1b[0m\r\n';
    pty.data(raw);
    await vi.advanceTimersByTimeAsync(200);
    const outcome = await settled;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok)
      throw new Error('Expected ready session', { cause: outcome.error });
    const session = outcome.session;
    expect(events.filter((e) => e.type === 'spawn')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'ready')).toHaveLength(1);
    expect(events.find((e) => e.type === 'output')).toMatchObject({
      data: raw,
    });
    const status = { exitCode: 7, signal: 0 };
    pty.exit(status);
    await session.close();
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ status });
    expect(events.find((e) => e.type === 'close-complete')).toMatchObject({
      status,
    });
    expect(events.filter((e) => e.type === 'close-action')).toMatchObject([
      { action: 'pty-default', result: 'attempt' },
      { action: 'pty-default', result: 'returned' },
    ]);
    expectObserverFields(events, pty.pid);
  });

  it('retains raw startup failure once and original error despite throwing observation and capture callbacks', async () => {
    const pty = fakePty({ defaultError: true });
    const events: InteractiveSessionLifecycleEvent[] = [];
    const capture = vi.fn(() => {
      throw new Error('capture observer failed');
    });
    const attempt = InteractiveSession.start({
      command: { bin: '/owned/fake', args: [] },
      onStartupFailure: capture,
      onLifecycle: (event) => {
        events.push(event);
        throw new Error('lifecycle observer failed');
      },
    });
    const settled = settleStart(attempt);
    const raw = '\x1b[31mBOOT_RAW' + 'x'.repeat(1000) + '\x1b[0m';
    pty.data(raw);
    pty.exit({ exitCode: 3, signal: 0 });
    await vi.advanceTimersByTimeAsync(200);
    expectStartupError(
      await settled,
      'CLI exited during startup (code 3, signal 0)',
    );
    expect(capture).toHaveBeenCalledExactlyOnceWith(raw);
    expect(events.filter((e) => e.type === 'startup-failure')).toHaveLength(1);
    expect(
      events.find((e) => e.type === 'close-action' && e.result === 'error'),
    ).toMatchObject({
      action: 'pty-default',
      error: 'Error: owned default kill failure',
    });
    expect(events.find((e) => e.type === 'close-complete')).toMatchObject({
      status: { exitCode: 3, signal: 0 },
    });
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expectObserverFields(events, pty.pid);
  });

  it.each(['exit', 'no-exit', 'error'] as const)(
    'observes forced close %s without changing the 30s startup or 10s+5s cleanup budgets',
    async (outcome) => {
      const pty = fakePty({ ignoreDefault: true, force: outcome });
      const signals = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid, signal) => {
          expect(pid).toBe(-pty.pid);
          expect(signal).toBe('SIGKILL');
          pty.force();
          return true;
        });
      const events: InteractiveSessionLifecycleEvent[] = [];
      const attempt = InteractiveSession.start({
        command: { bin: '/owned/fake', args: [] },
        onLifecycle: (event) => {
          events.push(event);
        },
      });
      const settled = settleStart(attempt);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(events.some((e) => e.type === 'startup-failure')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(events.some((e) => e.type === 'startup-failure')).toBe(true);
      expect(pty.kill).toHaveBeenCalledExactlyOnceWith();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(
        events.some(
          (e) => e.type === 'close-action' && e.action !== 'pty-default',
        ),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const action =
        process.platform === 'win32' ? 'pty-SIGKILL' : 'group-SIGKILL';
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'close-action',
          action,
          result: 'attempt',
        }),
      );
      if (outcome === 'no-exit') {
        await vi.advanceTimersByTimeAsync(4_999);
        expect(events.some((e) => e.type === 'close-complete')).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      expectStartupError(
        await settled,
        'Timeout (30000ms) waiting for text: "Type your message"',
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'close-action',
          action,
          result: outcome === 'error' ? 'error' : 'returned',
        }),
      );
      expect(events.some((e) => e.type === 'close-error')).toBe(true);
      expect(events.find((e) => e.type === 'close-complete')).toMatchObject({
        status: outcome === 'exit' ? { exitCode: 0, signal: 9 } : null,
      });
      if (process.platform !== 'win32')
        expect(signals).toHaveBeenCalledTimes(1);
      expectObserverFields(events, pty.pid);
    },
  );

  it.each(['startup', 'ready-exit'] as const)(
    'observer mutation of status data cannot change %s outcome',
    async (phase) => {
      const pty = fakePty();
      const attempt = InteractiveSession.start({
        command: { bin: '/owned/fake', args: [] },
        onLifecycle: (event) => {
          if (
            (event.type === 'exit' || event.type === 'close-complete') &&
            event.status
          ) {
            event.status.exitCode = 99;
            event.status.signal = 88;
          }
        },
      });
      const settled = settleStart(attempt);
      if (phase === 'startup') {
        const status = { exitCode: 3, signal: 0 };
        pty.exit(status);
        await vi.advanceTimersByTimeAsync(200);
        expectStartupError(
          await settled,
          'CLI exited during startup (code 3, signal 0)',
        );
        expect(status).toEqual({ exitCode: 3, signal: 0 });
      } else {
        pty.data('Type your message');
        await vi.advanceTimersByTimeAsync(200);
        const outcome = await settled;
        expect(outcome.ok).toBe(true);
        if (!outcome.ok)
          throw new Error('Expected ready session', { cause: outcome.error });
        const session = outcome.session;
        const status = { exitCode: 7, signal: 2 };
        pty.exit(status);
        expect(session.exitResult()).toEqual({ exitCode: 7, signal: 2 });
        await session.close();
        expect(status).toEqual({ exitCode: 7, signal: 2 });
        expect(session.exitResult()).toEqual({ exitCode: 7, signal: 2 });
      }
    },
  );
});
