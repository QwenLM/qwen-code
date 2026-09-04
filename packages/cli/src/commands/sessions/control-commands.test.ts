/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const connectExistingAgentViewSupervisor = vi.fn();

vi.mock('../../agent-view/supervisor-runner.js', () => ({
  connectExistingAgentViewSupervisor: (...args: unknown[]) =>
    connectExistingAgentViewSupervisor(...args),
}));

const stdout: string[] = [];
const stderr: string[] = [];

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: (line: string) => stdout.push(line),
  writeStderrLine: (line: string) => stderr.push(line),
}));

const { answerCommand, peekCommand } = await import('./control-commands.js');

const SESSION = '0f8e1c42-9d3a-4d21-8f77-2b6a7c9e0c31';

let savedExitCode: typeof process.exitCode;

beforeEach(() => {
  stdout.length = 0;
  stderr.length = 0;
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
  connectExistingAgentViewSupervisor.mockReset();
});

afterEach(() => {
  process.exitCode = savedExitCode;
});

async function run(
  command: { handler?: unknown },
  argv: Record<string, unknown>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (command.handler as any)(argv);
}

describe('session control command reporting', () => {
  it('writes a failure to stderr and keeps stdout clean', async () => {
    // No supervisor running: peek fails, and the message must not land
    // in the success channel of a `qwen sessions peek <id> > last.log`.
    connectExistingAgentViewSupervisor.mockResolvedValue(undefined);
    await run(peekCommand, { session: SESSION });
    expect(stderr.join('\n')).toContain('No background sessions');
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('writes a refused answer to stderr, not into the result', async () => {
    // The shape that bit before the fix: `answer "$id" "$reply" > last.log`
    // against a stale id wrote the error into the redirected file, mixed
    // with what success prints, distinguishable only by exit code.
    connectExistingAgentViewSupervisor.mockResolvedValue({
      answer: vi
        .fn()
        .mockRejectedValue(new Error('No Agent View session found for zz.')),
    });
    await run(answerCommand, { session: 'zz', text: 'yes' });
    expect(stderr).toEqual(['No Agent View session found for zz.']);
    expect(stdout).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('writes a delivered answer to stdout', async () => {
    connectExistingAgentViewSupervisor.mockResolvedValue({
      answer: vi.fn().mockResolvedValue({ sessionId: SESSION, answered: true }),
    });
    await run(answerCommand, { session: SESSION, text: 'yes' });
    expect(stdout).toEqual(['Answer delivered.']);
    expect(stderr).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });
});
