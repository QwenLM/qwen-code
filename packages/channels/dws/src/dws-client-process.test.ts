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
  function mockFailedDwsCommand({
    code = 1,
    stdout = '',
    stderr = '',
  }: {
    code?: unknown;
    stdout?: string;
    stderr?: string;
  }) {
    vi.mocked(execFile).mockImplementation(((
      _file,
      _args,
      _options,
      callback,
    ) => {
      queueMicrotask(() => {
        callback(Object.assign(new Error('exit'), { code }), stdout, stderr);
      });
      return {
        exitCode: typeof code === 'number' ? code : null,
        kill: vi.fn(),
      };
    }) as typeof execFile);
  }

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
    const error = await result;
    expect(error).toBeInstanceOf(DwsCommandError);
    expect((error as Error).message).toBe('DWS command failed.');
  });

  it('includes sanitized stderr details when a DWS command exits non-zero', async () => {
    mockFailedDwsCommand({
      stderr: '\u001b[31mHTTP 400\n{"errorCode":"InvalidArgs"}\u001b[0m',
    });

    const error = await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DwsCommandError);
    expect((error as Error).message).toContain(
      'DWS command failed (1): HTTP 400\\n{"errorCode":"InvalidArgs"}',
    );
    expect((error as Error).message).not.toContain('[31m');
  });

  it('uses stdout details when stderr is empty', async () => {
    mockFailedDwsCommand({ stdout: 'detail on stdout' });

    const error = await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DwsCommandError);
    expect((error as Error).message).toContain(
      'DWS command failed (1): detail on stdout',
    );
  });

  it('falls back to stdout when stderr sanitizes to empty', async () => {
    mockFailedDwsCommand({
      stdout: 'error: quota exceeded',
      stderr: '\u001b[2K\r',
    });

    const error = await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DwsCommandError);
    expect((error as Error).message).toContain(
      'DWS command failed (1): error: quota exceeded',
    );
  });

  it('uses a bare message when stderr and stdout sanitize to empty', async () => {
    mockFailedDwsCommand({ stderr: '\u001b[2K\r' });

    const error = await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DwsCommandError);
    expect((error as Error).message).toBe('DWS command failed (1).');
  });

  it('strips OSC terminal control sequences from failure details', async () => {
    mockFailedDwsCommand({
      stderr: `${String.fromCharCode(27)}]0;evil${String.fromCharCode(7)}boom`,
    });

    const error = await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DwsCommandError);
    expect((error as Error).message).toContain('boom');
    expect((error as Error).message).not.toContain(']0;evil');
  });

  it('caps failure details before exposing them in the error message', async () => {
    mockFailedDwsCommand({ stderr: `${'x'.repeat(300)}tail` });

    const error = await new DwsClient({ executable: '/opt/dws' })
      .assertCompatible()
      .catch((caught: unknown) => caught);

    const prefix = 'DWS command failed (1): ';
    expect(error).toBeInstanceOf(DwsCommandError);
    expect((error as Error).message).toBe(`${prefix}${'x'.repeat(256)}`);
    expect((error as Error).message).not.toContain('tail');
  });
});
