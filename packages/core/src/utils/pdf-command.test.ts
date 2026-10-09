/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChildProcess, spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execPDFCommandFromHandle, pdfDescriptorPath } from './pdf-command.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

describe.skipIf(!['linux', 'darwin'].includes(process.platform))(
  'descriptor PDF command lifetime',
  () => {
    let child: ChildProcess;
    let stdout: PassThrough;
    let stderr: PassThrough;
    const handle = { fd: 37 } as FileHandle;

    beforeEach(() => {
      vi.useFakeTimers();
      stdout = new PassThrough();
      stderr = new PassThrough();
      child = new ChildProcess();
      Object.assign(child, { pid: 12345, stdout, stderr });
      vi.spyOn(child, 'kill').mockReturnValue(true);
      vi.mocked(spawn).mockReturnValue(child);
    });
    afterEach(() => {
      stdout.destroy();
      stderr.destroy();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('inherits the original fd and waits past exit for closed stdio', async () => {
      let settled = false;
      const command = execPDFCommandFromHandle(
        'pdftotext',
        ['--', pdfDescriptorPath(), '-'],
        handle,
        {},
      ).then((result) => {
        settled = true;
        return result;
      });
      expect(spawn).toHaveBeenCalledWith(
        'pdftotext',
        ['--', pdfDescriptorPath(), '-'],
        { stdio: ['ignore', 'pipe', 'pipe', 37] },
      );
      stdout.write(Buffer.from('original'));
      child.emit('exit', 0, null);
      await Promise.resolve();
      expect(settled).toBe(false);
      stdout.write(Buffer.from('-late-output'));
      child.emit('close', 0, null);
      expect(await command).toEqual({
        stdout: 'original-late-output',
        stderr: '',
        code: 0,
        maxBufferExceeded: false,
        timedOut: false,
      });
    });

    it.each(['abort', 'timeout', 'error'])(
      'keeps %s pending through kill escalation until close',
      async (cause) => {
        const controller = new AbortController();
        let settled = false;
        const command = execPDFCommandFromHandle('pdftotext', [], handle, {
          signal: controller.signal,
          timeout: cause === 'timeout' ? 10 : undefined,
        }).then((result) => {
          settled = true;
          return result;
        });
        if (cause === 'abort') controller.abort();
        else if (cause === 'error')
          child.emit('error', new Error('spawn failed'));
        else await vi.advanceTimersByTimeAsync(10);
        expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        await vi.advanceTimersByTimeAsync(100);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
        expect(settled).toBe(false);
        child.emit('close', 0, null);
        expect(await command).toMatchObject({
          code: 1,
          timedOut: cause === 'timeout',
          maxBufferExceeded: false,
        });
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('bounds both streams but joins close after overflow', async () => {
      let settled = false;
      const command = execPDFCommandFromHandle('pdftotext', [], handle, {
        maxBuffer: 4,
      }).then((result) => {
        settled = true;
        return result;
      });
      stdout.write(Buffer.from('abcdefgh'));
      stderr.write(Buffer.from('12345678'));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.emit('close', 0, null);
      expect(await command).toEqual({
        stdout: 'abcd',
        stderr: '1234',
        code: 1,
        maxBufferExceeded: true,
        timedOut: false,
      });
    });

    it('does not kill a PID after exit when cancellation awaits close', async () => {
      const controller = new AbortController();
      const command = execPDFCommandFromHandle('pdftotext', [], handle, {
        signal: controller.signal,
      });
      child.emit('exit', 0, null);
      controller.abort();
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).not.toHaveBeenCalled();
      child.emit('close', 0, null);
      expect(await command).toMatchObject({ code: 1 });
    });

    it('rejects an already cancelled call without spawning', async () => {
      vi.mocked(spawn).mockClear();
      const controller = new AbortController();
      controller.abort(new Error('before-spawn'));
      await expect(
        execPDFCommandFromHandle('pdftotext', [], handle, {
          signal: controller.signal,
        }),
      ).rejects.toThrow('before-spawn');
      expect(spawn).not.toHaveBeenCalled();
    });
  },
);
