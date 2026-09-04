/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ensureAgentViewSupervisor = vi.fn();
const supervisorDispatch = vi.fn();
const dispatchAgentViewSession = vi.fn();

vi.mock('./supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: (...args: unknown[]) =>
    ensureAgentViewSupervisor(...args),
}));

vi.mock('./supervisor-dispatch.js', () => ({
  dispatchAgentViewSession: (...args: unknown[]) =>
    dispatchAgentViewSession(...args),
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
    // writes arrive — after the work is done.
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
