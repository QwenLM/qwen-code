/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ensureAgentViewSupervisor = vi.fn();
const dispatch = vi.fn();

vi.mock('./supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: (...args: unknown[]) =>
    ensureAgentViewSupervisor(...args),
}));

const stdout: string[] = [];
let stderr: string[] = [];
const ignoreBrokenPipe = vi.fn();
const writeStdoutLineSafe = vi.fn((line: string) => stdout.push(line));
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLineSafe: (line: string) => writeStdoutLineSafe(line),
  ignoreBrokenPipe: () => ignoreBrokenPipe(),
  // Mirror the real helpers' newline contract so the assertions pin
  // the exact bytes the user sees.
  writeStderrLine: (line: string) => {
    stderr.push(line.endsWith('\n') ? line : `${line}\n`);
  },
}));

const { readBackgroundPrompt, runBackgroundDispatch } = await import(
  './background-entry.js'
);
const { BACKGROUND_FLAG } = await import('./entry-flags.js');

beforeEach(() => {
  stdout.length = 0;
  stderr = [];
  ignoreBrokenPipe.mockReset();
  writeStdoutLineSafe.mockReset().mockImplementation((line: string) => {
    stdout.push(line);
    return undefined;
  });
  dispatch.mockReset().mockResolvedValue({ sessionId: 'sess-abc' });
  ensureAgentViewSupervisor
    .mockReset()
    .mockResolvedValue({ dispatch: (...args: unknown[]) => dispatch(...args) });
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

  it('never reads past `--`, where the tokens are the user’s own data', () => {
    // `qwen -p x -- --bg` passes `--bg` as data. Scanning past the
    // separator would hijack that launch into a dispatch.
    expect(readBackgroundPrompt(['-p', 'x', '--', BACKGROUND_FLAG])).toBe(
      undefined,
    );
  });

  it('collects the tokens after `--` as prompt instead of dropping them', () => {
    // Dropping them dispatches a different task than the one asked for and
    // then reports it as started: the whole suite instead of one file.
    expect(
      readBackgroundPrompt([
        BACKGROUND_FLAG,
        'run',
        'vitest',
        '--',
        'src/a.test.ts',
      ]),
    ).toEqual({ prompt: 'run vitest src/a.test.ts' });
  });

  it('dispatches a prompt whose first word starts with a dash', () => {
    // `--` is the only spelling there is for one: scanned as a flag the
    // word declines, and dropped after the separator the launch had
    // nothing to read.
    expect(readBackgroundPrompt([BACKGROUND_FLAG, '--', '-O2', 'fix'])).toEqual(
      { prompt: '-O2 fix' },
    );
  });

  it('reports an empty prompt rather than guessing one', () => {
    expect(readBackgroundPrompt([BACKGROUND_FLAG])).toEqual({ prompt: '' });
  });
});

describe('runBackgroundDispatch', () => {
  it('dispatches through the supervisor, which is what launches the worker', async () => {
    // The supervisor's dispatch op is the only path that both records the
    // session and launches its PTY host. Writing the store directly
    // records a session nothing ever starts — while printing that it
    // started.
    const order: string[] = [];
    ensureAgentViewSupervisor.mockImplementation(async () => {
      order.push('ensure');
      return {
        dispatch: (...args: unknown[]) => {
          order.push('dispatch');
          return dispatch(...args);
        },
      };
    });

    const code = await runBackgroundDispatch('audit the release', '/w/app');

    expect(code).toBe(0);
    expect(order).toEqual(['ensure', 'dispatch']);
    expect(dispatch).toHaveBeenCalledWith('audit the release', '/w/app');
  });

  it('prints the session id and where to see it', async () => {
    await runBackgroundDispatch('audit', '/w/app');
    expect(stdout[0]).toContain('sess-abc');
    expect(stdout.join('\n')).toContain('qwen sessions ps');
  });

  it('guards the pipe before printing a launch that already happened', async () => {
    // Both success writes come after the session is durably recorded and
    // its worker launched, so a reader that went away must not turn that
    // into a crash-class exit with no session id on any stream.
    const code = await runBackgroundDispatch('audit', '/w/app');
    expect(code).toBe(0);
    expect(ignoreBrokenPipe).toHaveBeenCalledTimes(1);
  });

  it('does not report a finished launch as a failure when stdout is gone', async () => {
    // The success writes sit outside the launch `try`: were they inside
    // it, a write failure would be re-reported as "Could not start a
    // background session" with exit code 1 for a session that is running.
    writeStdoutLineSafe.mockImplementationOnce(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });

    await expect(runBackgroundDispatch('audit', '/w/app')).rejects.toThrow(
      'EPIPE',
    );
    expect(dispatch).toHaveBeenCalledWith('audit', '/w/app');
    expect(stderr.join('')).not.toContain('Could not start');
  });

  it('refuses an empty prompt with the usage, and dispatches nothing', async () => {
    const code = await runBackgroundDispatch('', '/w/app');
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('needs a prompt');
    expect(ensureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
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
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports a failed dispatch the same way', async () => {
    dispatch.mockRejectedValue(new Error('prompt too large'));
    const code = await runBackgroundDispatch('audit', '/w/app');
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('prompt too large');
  });

  it('reports a dispatch that names no session instead of inventing one', async () => {
    // A supervisor from another build can answer without the id; printing
    // an empty one would send the user after a session that does not exist.
    dispatch.mockResolvedValue({ state: 'created' });
    const code = await runBackgroundDispatch('audit', '/w/app');
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('did not report a session id');
  });
});
