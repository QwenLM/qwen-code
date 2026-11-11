/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { killProcessGroup } from '../../utils/process-utils.js';
import {
  ENV_TERMINAL_PTY_BACKEND,
  spawnTerminalPtyProcess,
} from './terminalPtyProcess.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('../../utils/process-utils.js', () => ({
  killProcessGroup: vi.fn(),
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let deadline: AbortController;
let child: EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
};

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv(ENV_TERMINAL_PTY_BACKEND, '');
  deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  child = Object.assign(new EventEmitter(), {
    pid: 100,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.stdout.write('{"type":"ready","pid":200}\n'));
    return child as unknown as ReturnType<typeof spawn>;
  });
  vi.mocked(killProcessGroup).mockResolvedValue();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function openPty() {
  return spawnTerminalPtyProcess('cmd.exe', [], {
    name: 'xterm',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: {},
  });
}

it('uses the helper by default on Windows and waits for graceful exit', async () => {
  const pty = await openPty();
  expect(spawn).toHaveBeenCalled();
  const stopped = vi.fn();
  const closing = Promise.resolve(pty.kill()).then(stopped);
  child.stdout.write('{"type":"exit","exitCode":0,"signal":0}\n');
  await Promise.resolve();
  expect(child.stdin.writableEnded).toBe(true);
  expect(stopped).not.toHaveBeenCalled();
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await closing;
  expect(stopped).toHaveBeenCalledOnce();
  expect(killProcessGroup).not.toHaveBeenCalled();
});

it('forces only the silent helper tree before the 2 second shutdown deadline', async () => {
  const pty = await openPty();
  const closing = pty.kill();
  expect(AbortSignal.timeout).toHaveBeenCalledWith(1250);
  deadline.abort();
  await closing;
  expect(killProcessGroup).toHaveBeenCalledExactlyOnceWith({
    pid: child.pid,
    isLeaderExited: expect.any(Function),
  });
  expect(child.pid).not.toBe(pty.pid);
  const exited = vi.mocked(killProcessGroup).mock.calls[0][0].isLeaderExited!;
  expect(exited()).toBe(false);
  child.exitCode = 0;
  expect(exited()).toBe(true);
});

it('reports a failed tree termination to the caller', async () => {
  const pty = await openPty();
  vi.mocked(killProcessGroup).mockRejectedValueOnce(new Error('taskkill failed'));
  const closing = pty.kill();
  deadline.abort();
  await expect(closing).rejects.toThrow('taskkill failed');
});
