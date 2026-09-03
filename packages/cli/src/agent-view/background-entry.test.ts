/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ensureAgentViewSupervisor = vi.fn();
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
vi.mock('../utils/stdioHelpers.js', () => ({
  writeStdoutLine: (line: string) => stdout.push(line),
  writeStderrLine: (line: string) => line,
}));

const { readBackgroundPrompt, runBackgroundDispatch } = await import(
  './background-entry.js'
);
const { BACKGROUND_FLAG } = await import('./entry-flags.js');

let stderr: string[] = [];

beforeEach(() => {
  stdout.length = 0;
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  ensureAgentViewSupervisor.mockReset().mockResolvedValue(undefined);
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
    expect(readBackgroundPrompt([BACKGROUND_FLAG, 'audit the release'])).toBe(
      'audit the release',
    );
  });

  it('joins a prompt the shell split into words', () => {
    (expect(readBackgroundPrompt([BACKGROUND_FLAG, 'audit', 'the', 'release'])),
      expect(readBackgroundPrompt([BACKGROUND_FLAG, 'audit', 'release'])).toBe(
        'audit release',
      ));
  });

  it('does not swallow the value of a flag that takes one', () => {
    // `--model qwen3-coder` is a flag and its value, not two prompt words.
    // The set of value-taking flags is derived from the CLI's own option
    // tables, so a flag added later cannot silently start leaking into
    // prompts.
    expect(
      readBackgroundPrompt([
        BACKGROUND_FLAG,
        '--model',
        'qwen3-coder',
        'audit the release',
      ]),
    ).toBe('audit the release');
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, '-m', 'qwen3-coder', 'audit']),
    ).toBe('audit');
  });

  it('treats an attached flag value as one token consuming nothing', () => {
    expect(
      readBackgroundPrompt([BACKGROUND_FLAG, '--model=qwen3-coder', 'audit']),
    ).toBe('audit');
  });

  it('keeps the word after a boolean flag, which consumes no value', () => {
    expect(readBackgroundPrompt([BACKGROUND_FLAG, '--yolo', 'audit'])).toBe(
      'audit',
    );
  });

  it('never reads past `--`, where the tokens are the user’s own data', () => {
    // `qwen -p x -- --bg` passes `--bg` as data. Scanning past the
    // separator would hijack that launch into a dispatch.
    expect(readBackgroundPrompt(['-p', 'x', '--', BACKGROUND_FLAG])).toBe(
      undefined,
    );
  });

  it('reports an empty prompt rather than guessing one', () => {
    expect(readBackgroundPrompt([BACKGROUND_FLAG])).toBe('');
  });
});

describe('runBackgroundDispatch', () => {
  it('starts the supervisor before recording the session', async () => {
    // Dispatching without a supervisor records a session nothing spawns.
    const order: string[] = [];
    ensureAgentViewSupervisor.mockImplementation(async () => {
      order.push('ensure');
    });
    dispatchAgentViewSession.mockImplementation(async () => {
      order.push('dispatch');
      return { sessionId: 'sess-abc', state: 'created' };
    });

    const code = await runBackgroundDispatch('audit the release', '/w/app');

    expect(code).toBe(0);
    expect(order).toEqual(['ensure', 'dispatch']);
    expect(dispatchAgentViewSession).toHaveBeenCalledWith(
      'audit the release',
      '/w/app',
    );
  });

  it('prints the session id and where to see it', async () => {
    await runBackgroundDispatch('audit', '/w/app');
    expect(stdout[0]).toContain('sess-abc');
    expect(stdout.join('\n')).toContain('qwen sessions ps');
  });

  it('refuses an empty prompt with the usage, and dispatches nothing', async () => {
    const code = await runBackgroundDispatch('', '/w/app');
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('needs a prompt');
    expect(ensureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(dispatchAgentViewSession).not.toHaveBeenCalled();
  });

  it('reports a supervisor that will not start as a reason, not a stack', async () => {
    ensureAgentViewSupervisor.mockRejectedValue(
      new Error('EADDRINUSE: supervisor socket in use'),
    );

    const code = await runBackgroundDispatch('audit', '/w/app');

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('EADDRINUSE');
    expect(stderr.join('')).not.toContain('at Object.');
    expect(dispatchAgentViewSession).not.toHaveBeenCalled();
  });

  it('reports a failed dispatch the same way', async () => {
    dispatchAgentViewSession.mockRejectedValue(new Error('prompt too large'));
    const code = await runBackgroundDispatch('audit', '/w/app');
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('prompt too large');
  });
});
