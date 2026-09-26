/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ensureAgentViewSupervisor = vi.fn();
const supervisorDispatch = vi.fn();
const dispatchAgentViewSession = vi.fn();
const listAgentViewSessionStates = vi.fn();
const readAgentViewWorker = vi.fn();

vi.mock('./supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: (...args: unknown[]) =>
    ensureAgentViewSupervisor(...args),
}));

vi.mock('./supervisor-dispatch.js', () => ({
  dispatchAgentViewSession: (...args: unknown[]) =>
    dispatchAgentViewSession(...args),
}));

// The store is the positive "the session was already recorded" signal the
// dispatch rejection cannot carry; the entry reads it through these two
// helpers — the row list, and the per-session worker record that carries
// the pids proving a PTY host was actually spawned. Empty rows by
// default, so a rejection stays a failure unless a test says the store
// holds something; a spawned worker record by default, so a test that
// pins the row predicate is not also silently asserting on pids. Both
// exports must be present: the entry's fail-closed catch would swallow a
// missing-helper TypeError and flip every exit-2 case to exit 1.
vi.mock('./supervisor-store.js', () => ({
  listAgentViewSessionStates: (...args: unknown[]) =>
    listAgentViewSessionStates(...args),
  readAgentViewWorker: (...args: unknown[]) => readAgentViewWorker(...args),
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
// `projectCwd` must round-trip through `path.resolve` because that is the
// value production compares against — the writer stores
// `path.resolve(cwd)` (supervisor-dispatch.ts) and the entry's row
// predicate matches on exact identity against `path.resolve(cwd)`
// (background-entry.ts). A hardcoded POSIX literal never equals it on
// Windows, where `path.resolve('/w/app')` is drive-relative, so every row
// these tests seed would stop matching and the exit-2 cases would fall
// through to exit 1 on that lane alone. Same rule as server.test.ts's
// workspace fixtures.
function recordedSession(
  overrides: Partial<{
    sessionId: string;
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
    projectCwd: path.resolve('/w/app'),
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
  // The pids the dispatch handler persists right after the spawn, before
  // any further store I/O. Present by default so the row-predicate cases
  // below keep testing rows; the liveness cases override it.
  readAgentViewWorker.mockReset().mockResolvedValue({
    sessionId: 'sess-recorded',
    hostPid: 424242,
    workerPid: 424243,
  });
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

  it('leaves every attached --bg=<value> spelling to the parser', () => {
    // `bg` is declared `type: 'boolean'`, and yargs-parser reads an
    // attached value as that boolean rather than as a prompt: measured on
    // the installed 21.1.1, `--bg=false`, `--bg=` and `--bg=false\r` all
    // give `bg: false`, and `--bg=audit` gives `bg: false` with `audit` as
    // the positional. Intercepting attached values here is what made the
    // two spellings of one wrapper variable disagree, and what let a
    // padded or empty OFF value dispatch a real agent and certify it with
    // exit 0. So none of them is a background launch: the prompt has one
    // spelling, the positional one, and a dash-led prompt goes after `--`.
    expect(
      readBackgroundPrompt([`${BACKGROUND_FLAG}=audit the release`]),
    ).toBeUndefined();
    expect(readBackgroundPrompt([`${BACKGROUND_FLAG}=-repro`])).toBeUndefined();
    expect(readBackgroundPrompt([`${BACKGROUND_FLAG}=false`])).toBeUndefined();
    expect(
      readBackgroundPrompt([`${BACKGROUND_FLAG}=false\r`, 'audit the release']),
    ).toBeUndefined();
    expect(
      readBackgroundPrompt([`${BACKGROUND_FLAG}=`, 'audit the release']),
    ).toBeUndefined();
    expect(
      readBackgroundPrompt([`${BACKGROUND_FLAG}=true`, 'audit the release']),
    ).toBeUndefined();
  });

  it('reads the space-separated boolean words as the flag value, like yargs', () => {
    // yargs-parser consumes exactly the lowercase `false`/`true` after a
    // boolean flag: measured on the installed 21.1.1, `--bg false` is
    // `bg: false` with NO positional, while `--bg FALSE`, `--bg 0` and
    // `--bg off` leave `bg: true` and put the word in `_`. The intercept
    // runs before the parser, so it has to agree. Reading every non-dash
    // word as prompt data made the unquoted-variable wrapper form
    // `qwen --bg $ENABLED "$TASK"` with ENABLED=false dispatch a real
    // agent on the prompt `false audit the release` — supervisor started,
    // session recorded, worker spawned, quota burned — and certify it with
    // exit 0, where the parser itself would have started no session.
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, 'false', 'audit the release']),
    ).toBeUndefined();
    expect(readBackgroundPrompt([BACKGROUND_FLAG, 'false'])).toBeUndefined();
    // `true` means the bare flag, so it contributes no prompt word.
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, 'true', 'audit the release']),
    ).toEqual({ prompt: 'audit the release' });
    // Every other word stays prompt data, exactly as yargs leaves it in
    // `_` — the reader is not allowed to be cleverer than the parser, or
    // the two disagree about what the operator asked for.
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, 'FALSE', 'audit the release']),
    ).toEqual({ prompt: 'FALSE audit the release' });
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, '0', 'audit the release']),
    ).toEqual({ prompt: '0 audit the release' });
    expect(readBackgroundPrompt([BACKGROUND_FLAG, 'off', 'audit'])).toEqual({
      prompt: 'off audit',
    });
    // A dash-led prompt keeps its spelling through `--`, which the reader
    // collects verbatim now that the attached form is the parser's.
    expect(readBackgroundPrompt([BACKGROUND_FLAG, '--', '-repro'])).toEqual({
      prompt: '-repro',
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

  it('reports a supervisor that died mid-dispatch as a failure, not in flight', async () => {
    // A supervisor killed between the store write and its reply leaves the
    // client with the socket's 'closed' error beside a persisted `starting`
    // session and possibly a live detached host. This used to certify that
    // as exit 2 "may still be starting" by scanning the store for a managed
    // row recorded since the dispatch began — but the store cannot say
    // WHICH launch a row belongs to: the failure envelope carries only a
    // code and a message, so the client holds no session id to match, and
    // ownership + projectCwd + createdAt are equally satisfied by a
    // concurrent launch in the same directory. Two rounds of adding
    // conjuncts (a terminal-state exclusion, then a worker-pid term)
    // narrowed that without closing it.
    //
    // The false positive was the worse error: it told a wrapper "do not
    // retry" about a launch that definitively failed, so the task was
    // silently never run, where a retry that starts a second agent is at
    // least visible in `qwen sessions ps`. So every non-timeout rejection
    // reports failure, whatever the store happens to hold.
    supervisorDispatch.mockRejectedValue(supervisorClosedError());
    listAgentViewSessionStates.mockResolvedValue([recordedSession({})]);
    readAgentViewWorker.mockResolvedValue({
      sessionId: 'sess-recorded',
      hostPid: 4242,
      workerPid: 4343,
    });

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Could not start a background session');
    expect(stderr.join('')).not.toContain('may still be starting');
    // The store is not consulted at all now. A fresh, non-terminal,
    // pid-bearing row for this cwd is exactly the shape that used to
    // certify the launch in flight, so pinning the absence of the read
    // pins the removal rather than one of its outcomes.
    expect(listAgentViewSessionStates).not.toHaveBeenCalled();
    expect(readAgentViewWorker).not.toHaveBeenCalled();
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
