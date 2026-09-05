/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ensureAgentViewSupervisor = vi.fn();
const supervisorDispatch = vi.fn();
const dispatchAgentViewSession = vi.fn();
const listAgentViewSessionStates = vi.fn();

vi.mock('./supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: (...args: unknown[]) =>
    ensureAgentViewSupervisor(...args),
}));

vi.mock('./supervisor-dispatch.js', () => ({
  dispatchAgentViewSession: (...args: unknown[]) =>
    dispatchAgentViewSession(...args),
}));

// The store is the positive "the session was already recorded" signal the
// dispatch rejection cannot carry; the entry reads it through this one
// helper. Empty by default, so a rejection stays a failure unless a test
// says the store holds something.
vi.mock('./supervisor-store.js', () => ({
  listAgentViewSessionStates: (...args: unknown[]) =>
    listAgentViewSessionStates(...args),
}));

const stdout: string[] = [];
let stderr: string[] = [];
// Overridable per test: the EPIPE case makes the stdout write throw
// after the dispatch RPC resolves.
let writeStdoutLineImpl = (line: string): void => {
  stdout.push(line);
};
let ignoreBrokenPipeCalls = 0;
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine: (line: string) => writeStdoutLineImpl(line),
  // Mirror the real helper: swallows whatever the write throws, because
  // the write is incidental once the work is done.
  writeStdoutLineSafe: (line: string) => {
    try {
      writeStdoutLineImpl(line);
    } catch {
      // stdout is gone. Whatever this line had to say, its reader left.
    }
  },
  // Mirror the real helpers' newline contract so the assertions pin
  // the exact bytes the user sees.
  writeStderrLine: (line: string) => {
    stderr.push(line.endsWith('\n') ? line : `${line}\n`);
  },
  ignoreBrokenPipe: () => {
    ignoreBrokenPipeCalls += 1;
  },
}));

const { readBackgroundPrompt, runBackgroundDispatch } = await import(
  './background-entry.js'
);
const { BACKGROUND_FLAG } = await import('./entry-flags.js');

// The error the client settles with when the supervisor dies mid-request:
// the socket's 'end' handler builds it with code 'closed', never
// 'timeout' (supervisor-client.ts).
function supervisorClosedError(): Error & { code: string } {
  const error = new Error(
    'Agent View supervisor closed before sending a response.',
  ) as Error & { code: string };
  error.code = 'closed';
  return error;
}

// A store row shaped like the one dispatchAgentViewSession writes before
// the ready wait; overrides let a test age it, move it or unmanage it.
// The default createdAt sits INSIDE the dispatch window: the entry dates
// the window when it starts, so a row stamped when the mock is built can
// land a millisecond earlier and read as a session from a previous
// launch.
function recordedSession(
  overrides: Partial<{
    createdAt: string;
    projectCwd: string;
    ownership: string;
    sessionState: string;
  }> = {},
) {
  return {
    sessionId: 'sess-recorded',
    ownership: 'managed',
    sessionState: 'starting',
    projectCwd: '/w/app',
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  stdout.length = 0;
  stderr = [];
  writeStdoutLineImpl = (line: string): void => {
    stdout.push(line);
  };
  ignoreBrokenPipeCalls = 0;
  supervisorDispatch
    .mockReset()
    .mockResolvedValue({ sessionId: 'sess-abc', state: 'created' });
  // The handle the entry gets back must carry the dispatch RPC.
  ensureAgentViewSupervisor
    .mockReset()
    .mockResolvedValue({ dispatch: supervisorDispatch });
  dispatchAgentViewSession
    .mockReset()
    .mockResolvedValue({ sessionId: 'sess-abc', state: 'created' });
  listAgentViewSessionStates.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readBackgroundPrompt', () => {
  it('declines a launch that never asked for a background session', () => {
    expect(readBackgroundPrompt(['-p', 'hello'])).toBeUndefined();
  });

  it('reads the prompt from the positional query', () => {
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, 'audit the release']),
    ).toEqual({ prompt: 'audit the release' });
  });

  it('joins a prompt the shell split into words', () => {
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, 'audit', 'the', 'release']),
    ).toEqual({ prompt: 'audit the release' });
    expect(readBackgroundPrompt([BACKGROUND_FLAG, 'audit', 'release'])).toEqual(
      { prompt: 'audit release' },
    );
  });

  it('reads the prompt from the attached --bg=<prompt> form', () => {
    // The CLI's other prompt flags are used as `--prompt=<value>`, so the
    // attached form must reach the same reader instead of dying in the
    // strict parser on an unregistered `bg`.
    expect(
      readBackgroundPrompt([`${BACKGROUND_FLAG}=audit the release`]),
    ).toEqual({ prompt: 'audit the release' });
    // The attached value is data even when it starts with a dash.
    expect(readBackgroundPrompt([`${BACKGROUND_FLAG}=-repro`])).toEqual({
      prompt: '-repro',
    });
    // Trailing positionals still join behind the attached prompt.
    expect(
      readBackgroundPrompt([`${BACKGROUND_FLAG}=audit`, 'the', 'release']),
    ).toEqual({ prompt: 'audit the release' });
  });

  it('reads the attached boolean literals as the flag, not as prompt text', () => {
    // `bg` is declared `type: 'boolean'` in the help surface, so
    // `--bg=false` / `--bg=0` is how a wrapper (`qwen --bg=$ENABLED
    // "$TASK"` with ENABLED=false) turns the launch OFF. Reading the
    // attached value as prompt data dispatched a real agent on the prompt
    // `false audit the release` — supervisor started, session recorded,
    // worker spawned, quota burned — and certified it with exit 0.
    expect(readBackgroundPrompt([`${BACKGROUND_FLAG}=false`])).toBeUndefined();
    expect(
      readBackgroundPrompt([`${BACKGROUND_FLAG}=0`, 'audit', 'the', 'release']),
    ).toBeUndefined();
    // The affirmative spellings mean the bare flag, so they contribute no
    // prompt word of their own.
    expect(
      readBackgroundPrompt([`${BACKGROUND_FLAG}=true`, 'audit the release']),
    ).toEqual({ prompt: 'audit the release' });
    expect(readBackgroundPrompt([`${BACKGROUND_FLAG}=1`, 'audit'])).toEqual({
      prompt: 'audit',
    });
    // Only the exact boolean literals are special: every other attached
    // value stays prompt data, dash-led included.
    expect(readBackgroundPrompt([`${BACKGROUND_FLAG}=-repro`])).toEqual({
      prompt: '-repro',
    });
    expect(readBackgroundPrompt([`${BACKGROUND_FLAG}=falsey`])).toEqual({
      prompt: 'falsey',
    });
  });

  it('declines any other flag and names it, because --bg forwards nothing', () => {
    // The worker argv carries only the session id and the prompt, so any
    // other flag would be silently dropped — worse, a hand-rolled scan of
    // which flags take values misreads their value slots as prompt words:
    // array-typed options consume N tokens (`--extensions a b "fix"`),
    // hidden options like `--sandbox-session-id` sit in no option table,
    // and a value flag can swallow a flag-shaped next token (`-p
    // --model qwen3 fix`). Declining and naming the flag closes the whole
    // class instead of modeling arities.
    expect(
      readBackgroundPrompt([
        BACKGROUND_FLAG,
        '--extensions',
        'a',
        'b',
        'fix the build',
      ]),
    ).toEqual({ unsupportedFlag: '--extensions' });
    expect(
      readBackgroundPrompt([
        BACKGROUND_FLAG,
        '--sandbox-session-id',
        '123e4567-e89b-12d3-a456-426614174000',
        'audit',
      ]),
    ).toEqual({ unsupportedFlag: '--sandbox-session-id' });
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, '-p', '--model', 'qwen3', 'fix']),
    ).toEqual({ unsupportedFlag: '-p' });
    expect(readBackgroundPrompt([BACKGROUND_FLAG, '--yolo', 'audit'])).toEqual({
      unsupportedFlag: '--yolo',
    });
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, '--model=qwen3-coder', 'audit']),
    ).toEqual({ unsupportedFlag: '--model' });
  });

  it('declines a --bg that appears only after `--`', () => {
    // `qwen -p x -- --bg` passes `--bg` as data. Scanning past the
    // separator for the flag would hijack that launch into a dispatch.
    expect(readBackgroundPrompt(['-p', 'x', '--', BACKGROUND_FLAG])).toBe(
      undefined,
    );
  });

  it('collects the tokens after `--` as prompt data, dash-led included', () => {
    // The only way to express a prompt that starts with `-`: before `--`
    // it would decline as a flag, and silently dropping it (or letting a
    // value-taking flag swallow its neighbor) would dispatch a modified
    // task under a normal-looking success line.
    expect(readBackgroundPrompt([BACKGROUND_FLAG, '--', '-repro'])).toEqual({
      prompt: '-repro',
    });
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, 'explain', '--', '-O2', 'flag']),
    ).toEqual({ prompt: 'explain -O2 flag' });
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, 'summarize', '--', '-p', 'x']),
    ).toEqual({ prompt: 'summarize -p x' });
  });

  it('reports an empty prompt rather than guessing one', () => {
    expect(readBackgroundPrompt([BACKGROUND_FLAG])).toEqual({ prompt: '' });
    expect(readBackgroundPrompt([BACKGROUND_FLAG, '--'])).toEqual({
      prompt: '',
    });
  });
});

describe('runBackgroundDispatch', () => {
  it('starts the session through the supervisor dispatch RPC, not a raw store write', async () => {
    // The dispatch RPC is the one path that records the session AND spawns
    // its worker; a direct dispatchAgentViewSession write records a session
    // nothing ever starts.
    const order: string[] = [];
    ensureAgentViewSupervisor.mockImplementation(async () => {
      order.push('ensure');
      return { dispatch: supervisorDispatch };
    });
    supervisorDispatch.mockImplementation(async () => {
      order.push('dispatch');
      return { sessionId: 'sess-abc', state: 'created' };
    });

    const code = await runBackgroundDispatch('audit the release', '/w/app');

    expect(code).toBe(0);
    expect(order).toEqual(['ensure', 'dispatch']);
    expect(supervisorDispatch).toHaveBeenCalledWith(
      'audit the release',
      '/w/app',
    );
    expect(dispatchAgentViewSession).not.toHaveBeenCalled();
  });

  it('prints the session id the dispatch RPC returns, and where to see it', async () => {
    supervisorDispatch.mockResolvedValue({
      sessionId: 'sess-rpc',
      state: 'created',
    });

    await runBackgroundDispatch('audit', '/w/app');

    expect(supervisorDispatch).toHaveBeenCalledWith('audit', '/w/app');
    expect(stdout[0]).toContain('sess-rpc');
    expect(stdout.join('\n')).toContain('qwen sessions ps');
  });

  it('installs broken-pipe protection before dispatching', async () => {
    // The dispatch RPC can block for seconds while the worker starts; a
    // reader that leaves during that window (`qwen --bg "..." | true`,
    // a CI step closing the pipe) sends EPIPE back once the success
    // writes arrive — after the work is done. The protection must cover
    // that whole window, so the ordering is witnessed INSIDE the
    // dispatch call: a post-call count alone would still pass if
    // ignoreBrokenPipe() moved below the dispatch, re-exposing the
    // async-EPIPE crash for the multi-second RPC.
    supervisorDispatch.mockImplementation(async () => {
      expect(ignoreBrokenPipeCalls).toBe(1);
      return { sessionId: 'sess-abc', state: 'created' };
    });

    await runBackgroundDispatch('audit', '/w/app');

    expect(ignoreBrokenPipeCalls).toBe(1);
  });

  it('keeps exit 0 when the success write hits a broken pipe', async () => {
    // The dispatch succeeded — the session is recorded and the worker
    // spawned — then the stdout write throws EPIPE because the reader
    // is gone. The outcome must not flip: no launch-failure line, exit
    // code 0. A wrapper script keying on the exit code would otherwise
    // conclude the launch failed and start a second agent on the same
    // prompt.
    supervisorDispatch.mockImplementation(async () => {
      writeStdoutLineImpl = (): void => {
        const error = new Error('write EPIPE') as Error & { code: string };
        error.code = 'EPIPE';
        throw error;
      };
      return { sessionId: 'sess-abc', state: 'created' };
    });

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(0);
    expect(stderr.join('')).not.toContain(
      'Could not start a background session',
    );
  });

  it('refuses an empty prompt with the usage, and dispatches nothing', async () => {
    const code = await runBackgroundDispatch('', '/w/app');
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('needs a prompt');
    expect(ensureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(supervisorDispatch).not.toHaveBeenCalled();
    expect(dispatchAgentViewSession).not.toHaveBeenCalled();
  });

  it('reports a supervisor that will not start as a reason, not a stack', async () => {
    ensureAgentViewSupervisor.mockRejectedValue(
      new Error('EADDRINUSE: supervisor socket in use'),
    );

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(1);
    // The exact one-line reason, not a stack: a stack also starts with
    // "Error: EADDRINUSE...", so only the full output pins the contract.
    expect(stderr.join('')).toBe(
      'Could not start a background session: EADDRINUSE: supervisor socket in use\n',
    );
    expect(supervisorDispatch).not.toHaveBeenCalled();
    expect(dispatchAgentViewSession).not.toHaveBeenCalled();
  });

  it('reports a failed dispatch the same way', async () => {
    supervisorDispatch.mockRejectedValue(new Error('prompt too large'));
    const code = await runBackgroundDispatch('audit', '/w/app');
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('prompt too large');
    expect(dispatchAgentViewSession).not.toHaveBeenCalled();
  });

  it('reports a dispatch that timed out client-side as still starting, not failed', async () => {
    // The dispatch RPC runs under a client cap
    // (LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS); the server-side handler
    // keeps launching after the client gives up — a store I/O stall can
    // push it past the cap — so the session may still come up.
    // Certifying a failure with exit 1 would have a wrapping script
    // start a second agent on the same prompt. Report the in-flight
    // launch and a distinct exit code a wrapper can treat as "do not
    // retry".
    const timeout = new Error(
      'Timed out waiting for Agent View supervisor response.',
    ) as Error & { code: string };
    timeout.code = 'timeout';
    supervisorDispatch.mockRejectedValue(timeout);

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(2);
    expect(stderr.join('')).not.toContain(
      'Could not start a background session',
    );
    expect(stderr.join('')).toContain('may still be starting');
    expect(stderr.join('')).toContain('qwen sessions ps');
    expect(dispatchAgentViewSession).not.toHaveBeenCalled();
  });

  it('reports a supervisor that died after recording the session as in flight, not failed', async () => {
    // The dispatch handler records the session, spawns the PTY host and
    // persists its pids BEFORE the ready wait, and rolls the record back
    // only if it survives to do so. A supervisor killed inside that window
    // — an OOM kill, CI teardown, a logout — leaves the client with the
    // socket's 'closed' error (never 'timeout') beside a persisted
    // `starting` session, `ownership: 'managed'` and a live detached host.
    // Certifying exit 1 "Could not start" contradicts the product's own
    // store and has a wrapper honoring this entry's contract retry, which
    // starts a SECOND agent on the same prompt.
    supervisorDispatch.mockRejectedValue(supervisorClosedError());
    listAgentViewSessionStates.mockResolvedValue([recordedSession({})]);

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(2);
    expect(stderr.join('')).toContain('may still be starting');
    expect(stderr.join('')).toContain('qwen sessions ps');
    expect(stderr.join('')).not.toContain(
      'Could not start a background session',
    );
  });

  it('keeps a dispatch rejection the store does not date to this launch a failure', async () => {
    // The positive signal is narrow: a MANAGED session for THIS cwd
    // recorded AT OR AFTER the dispatch began. None of these rows is that
    // — an older `starting` session (an earlier launch), a fresh session in
    // another directory (a concurrent launch), a fresh unmanaged one — so a
    // genuine failure must keep its exit 1 and its reason. Widening the
    // guard to every dispatch rejection would turn the pre-record
    // rejections (an oversize prompt, an empty one) into do-not-retry
    // in-flight reports.
    supervisorDispatch.mockRejectedValue(supervisorClosedError());
    listAgentViewSessionStates.mockResolvedValue([
      recordedSession({
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      recordedSession({ projectCwd: '/w/other' }),
      recordedSession({ ownership: 'unmanaged' }),
    ]);

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(1);
    expect(stderr.join('')).toBe(
      'Could not start a background session: Agent View supervisor closed before sending a response.\n',
    );
  });

  it('keeps a supervisor that never came up a failure even with a fresh session in the store', async () => {
    // The widened guard is scoped to the dispatch RPC: this launch never
    // reached it, so it recorded nothing, and a concurrent launch's fresh
    // session must not certify it as in flight.
    ensureAgentViewSupervisor.mockRejectedValue(
      new Error('ECONNREFUSED: no supervisor socket'),
    );
    listAgentViewSessionStates.mockResolvedValue([recordedSession({})]);

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(1);
    expect(supervisorDispatch).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Could not start a background session');
  });

  it('reports an error-like rejection reason instead of [object Object]', async () => {
    // A plain-object rejection with a message must surface the message:
    // the hand-rolled instanceof ternary stringified it to
    // "[object Object]" and hid the reason.
    ensureAgentViewSupervisor.mockRejectedValue({ message: 'boom' });

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(1);
    expect(stderr.join('')).toBe(
      'Could not start a background session: boom\n',
    );
    expect(supervisorDispatch).not.toHaveBeenCalled();
    expect(dispatchAgentViewSession).not.toHaveBeenCalled();
  });
});
