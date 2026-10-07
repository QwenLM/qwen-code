/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ExecFileOptions } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';

export function pdfDescriptorPath(): string {
  if (process.platform === 'linux') return '/proc/self/fd/3';
  if (process.platform === 'darwin') return '/dev/fd/3';
  throw new Error('PDF descriptor input is unsupported on this platform.');
}

export async function execPDFCommandFromHandle(
  command: string,
  args: string[],
  fileHandle: FileHandle,
  options: ExecFileOptions,
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  maxBufferExceeded: boolean;
  timedOut: boolean;
}> {
  pdfDescriptorPath();
  options.signal?.throwIfAborted();
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe', fileHandle.fd],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let maxBufferExceeded = false;
    let timedOut = false;
    let exited = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (exited || child.pid === undefined) return;
      try {
        child.kill(signal);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    };
    const stop = () => {
      if (killTimer !== undefined) return;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 100);
    };
    const fail = (error: Error) => {
      failure = error;
      stop();
    };
    const capture = (bytes: Buffer, isStdout: boolean) => {
      const length = isStdout ? stdoutBytes : stderrBytes;
      const kept = bytes.subarray(0, Math.max(0, maxBuffer - length));
      if (kept.length > 0) (isStdout ? stdout : stderr).push(kept);
      if (isStdout) stdoutBytes += kept.length;
      else stderrBytes += kept.length;
      if (length + bytes.length > maxBuffer) {
        maxBufferExceeded = true;
        stop();
      }
    };
    child.stdout?.on('data', (bytes: Buffer) => capture(bytes, true));
    child.stderr?.on('data', (bytes: Buffer) => capture(bytes, false));
    child.stdout?.on('error', fail);
    child.stderr?.on('error', fail);
    child.on('error', fail);
    child.on('exit', () => {
      exited = true;
    });
    const abort = () => stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeout)
      : undefined;
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr:
          Buffer.concat(stderr).toString('utf8') || failure?.message || '',
        code:
          failure || options.signal?.aborted || timedOut || maxBufferExceeded
            ? 1
            : (code ?? 1),
        maxBufferExceeded,
        timedOut,
      });
    });
    if (options.signal?.aborted) abort();
  });
}
