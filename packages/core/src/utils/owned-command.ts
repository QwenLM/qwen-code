/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import {
  ownProcessGroup,
  type OwnedProcessGroup,
} from './owned-process-group.js';

export interface OwnedCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
}

export type OwnedCommandError = Error & {
  code?: string | number | null;
  signal?: string | null;
};

export interface OwnedCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: OwnedCommandError;
}

const activeGroups = new Set<OwnedProcessGroup>();

function killActiveGroups(): void {
  for (const group of activeGroups) group.killSync();
}

function abortedError(): OwnedCommandError {
  return Object.assign(new Error('The operation was aborted.'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

function notStarted(error: OwnedCommandError): OwnedCommandResult {
  return { stdout: '', stderr: '', code: null, signal: null, error };
}

export async function runOwnedCommand(
  command: string,
  args: readonly string[],
  options: OwnedCommandOptions = {},
): Promise<OwnedCommandResult> {
  if (options.signal?.aborted) return notStarted(abortedError());
  if (os.platform() === 'win32') {
    return notStarted(
      Object.assign(
        new Error(
          'Verified command process group exit is not supported on Windows.',
        ),
        { code: 'ERR_OWNED_COMMAND_UNSUPPORTED' },
      ),
    );
  }

  let child;
  try {
    child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return notStarted(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  const controller = new AbortController();
  let firstError: OwnedCommandError | undefined;
  const stop = (error: OwnedCommandError) => {
    firstError ??= error;
    controller.abort();
  };
  const onAbort = () => stop(abortedError());
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    const size = stream === 'stdout' ? stdoutBytes : stderrBytes;
    const remaining = maxBuffer - size;
    const retained =
      chunk.length > remaining
        ? chunk.subarray(0, Math.max(0, remaining))
        : chunk;
    if (retained.length > 0) {
      (stream === 'stdout' ? stdout : stderr).push(retained);
      if (stream === 'stdout') stdoutBytes += retained.length;
      else stderrBytes += retained.length;
    }
    if (chunk.length > remaining) {
      stop(
        Object.assign(new Error(`${stream} maxBuffer length exceeded`), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }),
      );
    }
  };
  child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk));
  child.on('error', stop);
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timeout = options.timeout;
  const timer =
    timeout !== undefined && timeout > 0
      ? setTimeout(() => {
          stop(
            Object.assign(new Error('Command timed out.'), {
              code: 'ETIMEDOUT',
            }),
          );
        }, timeout)
      : undefined;

  const group =
    child.pid === undefined
      ? undefined
      : ownProcessGroup(child.pid, controller.signal);
  if (group) {
    if (activeGroups.size === 0) process.on('exit', killActiveGroups);
    activeGroups.add(group);
  }
  try {
    const outcome = await closed;
    await group?.exited;
    if (
      firstError === undefined &&
      (outcome.code !== 0 || outcome.signal !== null)
    ) {
      firstError = Object.assign(
        new Error(
          `Command failed: ${command}\n${Buffer.concat(stderr).toString('utf8').trim()}`,
        ),
        {
          code: outcome.code,
          signal: outcome.signal,
        },
      );
    }
    return {
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      ...outcome,
      ...(firstError === undefined ? {} : { error: firstError }),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (group) {
      activeGroups.delete(group);
      if (activeGroups.size === 0)
        process.removeListener('exit', killActiveGroups);
    }
  }
}
