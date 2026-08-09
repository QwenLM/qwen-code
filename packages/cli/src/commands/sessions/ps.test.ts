/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionRegistryRecord } from '@qwen-code/qwen-code-core';

const listLiveSessions = vi.fn();

vi.mock('@qwen-code/qwen-code-core', () => ({
  listLiveSessions: (...args: unknown[]) => listLiveSessions(...args),
}));

const stdout: string[] = [];
const stderr: string[] = [];

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: (line: string) => stdout.push(line),
  writeStderrLine: (line: string) => stderr.push(line),
}));

const { psCommand, formatAge } = await import('./ps.js');

function record(
  over: Partial<SessionRegistryRecord> = {},
): SessionRegistryRecord {
  return {
    schemaVersion: 1,
    pid: 4242,
    procStart: '123',
    sessionId: 'sess-1',
    cwd: '/w/app',
    name: 'app-ab',
    kind: 'interactive',
    startedAt: Date.now() - 90_000,
    qwenVersion: '1.0.0',
    peerProtocol: 1,
    ...over,
  };
}

async function run(argv: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (psCommand.handler as any)(argv);
}

beforeEach(() => {
  stdout.length = 0;
  stderr.length = 0;
  listLiveSessions.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatAge', () => {
  it('scales the unit with the magnitude', () => {
    expect(formatAge(5_000)).toBe('5s');
    expect(formatAge(90_000)).toBe('1m');
    expect(formatAge(3 * 3600_000)).toBe('3h');
    expect(formatAge(50 * 3600_000)).toBe('2d');
  });

  it('clamps a record from the future to zero rather than showing a negative age', () => {
    expect(formatAge(-10_000)).toBe('0s');
  });
});

describe('qwen sessions ps', () => {
  it('prints a table of live sessions', async () => {
    listLiveSessions.mockResolvedValue([record()]);
    await run({ json: false, all: false });

    expect(stdout[0]).toMatch(/^NAME\s+PID\s+AGE\s+DIRECTORY$/);
    expect(stdout[1]).toContain('app-ab');
    expect(stdout[1]).toContain('4242');
    expect(stdout[1]).toContain('/w/app');
  });

  it('says so plainly when nothing else is running', async () => {
    listLiveSessions.mockResolvedValue([]);
    await run({ json: false, all: false });
    expect(stdout).toEqual(['No other Qwen Code sessions are running.']);
  });

  it('emits one JSON object per line with no header', async () => {
    listLiveSessions.mockResolvedValue([record(), record({ pid: 7 })]);
    await run({ json: true, all: false });

    expect(stdout).toHaveLength(2);
    expect(JSON.parse(stdout[0]).pid).toBe(4242);
    expect(JSON.parse(stdout[1]).pid).toBe(7);
  });

  it('prints nothing on stdout for an empty JSON listing', async () => {
    listLiveSessions.mockResolvedValue([]);
    await run({ json: true, all: false });
    expect(stdout).toEqual([]);
  });

  it('excludes this process unless --all is passed', async () => {
    listLiveSessions.mockResolvedValue([]);

    await run({ json: true, all: false });
    expect(listLiveSessions).toHaveBeenLastCalledWith({ includeSelf: false });

    await run({ json: true, all: true });
    expect(listLiveSessions).toHaveBeenLastCalledWith({ includeSelf: true });
  });

  it('neutralizes control sequences coming from another process record', async () => {
    listLiveSessions.mockResolvedValue([
      record({ name: 'ev[31mil\r', cwd: '/w/a\nb' }),
    ]);
    await run({ json: false, all: false });

    const row = stdout[1];
    expect(row).not.toContain('');
    expect(row).not.toContain('\r');
    expect(row).not.toContain('\n');
  });

  it('reports a registry read failure on stderr and exits 1', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    listLiveSessions.mockRejectedValue(new Error('EACCES'));

    await run({ json: false, all: false });

    expect(stderr.join('\n')).toContain(
      'failed to read the session registry: EACCES',
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout).toEqual([]);
  });

  it('truncates an over-long name instead of breaking the columns', async () => {
    listLiveSessions.mockResolvedValue([record({ name: 'x'.repeat(80) })]);
    await run({ json: false, all: false });
    expect(stdout[1]).toContain('...');
    expect(stdout[1]).toContain('4242');
  });
});
