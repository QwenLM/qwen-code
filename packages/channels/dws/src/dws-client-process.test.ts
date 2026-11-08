/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DwsClient, DwsCommandError } from './dws-client.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('DWS command process', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(execFile).mockReset();
  });

  it('escalates a timed-out command to SIGKILL', async () => {
    vi.useFakeTimers();
    let callback!: (
      error: NodeJS.ErrnoException | null,
      stdout: string,
      stderr: string,
    ) => void;
    const child = {
      exitCode: null as number | null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGKILL') {
          child.exitCode = 1;
          callback(Object.assign(new Error('killed'), { code: null }), '', '');
        }
        return true;
      }),
    };
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      receivedCallback,
    ) => {
      callback = receivedCallback;
      return child;
    }) as typeof execFile);

    const result = new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50_000);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(result).resolves.toBeInstanceOf(DwsCommandError);
  });

  it('names the failing subcommand and its stderr instead of only the exit code', async () => {
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      callback,
    ) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('Command failed'), { code: 1 }),
          '',
          'error: conversation is not open\n',
        ),
      );
      return { exitCode: 1, kill: vi.fn() };
    }) as unknown as typeof execFile);

    const error = (await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught)) as DwsCommandError;

    expect(error).toBeInstanceOf(DwsCommandError);
    expect(error.message).toContain('`dws version`');
    expect(error.message).toContain('(exit 1)');
    expect(error.message).toContain('error: conversation is not open');
    expect(error.outcome).toBe('unknown');
  });

  it('keeps a long stderr tail so the actual reason survives truncation', async () => {
    const banner = `${'progress line\n'.repeat(100)}error: sender is not in the conversation\n`;
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      callback,
    ) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error('Command failed'), { code: 1 }),
          '',
          banner,
        ),
      );
      return { exitCode: 1, kill: vi.fn() };
    }) as unknown as typeof execFile);

    const error = (await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught)) as DwsCommandError;

    expect(error.message).toContain('sender is not in the conversation');
    expect(error.message.startsWith('…')).toBe(false);
    expect(error.message.length).toBeLessThan(800);
  });
});
