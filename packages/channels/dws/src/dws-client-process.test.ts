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

  it('includes sanitized stderr details when a DWS command exits non-zero', async () => {
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      callback,
    ) => {
      queueMicrotask(() => {
        callback(
          Object.assign(new Error('exit 1'), { code: 1 }),
          '',
          '\u001b[31mHTTP 400\n{"errorCode":"InvalidArgs"}\u001b[0m',
        );
      });
      return {
        exitCode: 1,
        kill: vi.fn(),
      };
    }) as typeof execFile);

    const error = await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DwsCommandError);
    expect((error as Error).message).toContain(
      'DWS command failed (1): HTTP 400\\n{"errorCode":"InvalidArgs"}',
    );
    expect((error as Error).message).not.toContain('[31m');
  });
});
