/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ManagedExtensionExecutionUnknownError } from './managed-extension-error.js';
import { ToolErrorType } from '@qwen-code/qwen-code-core/tools/tool-error.js';
import { getShellConfiguration } from '@qwen-code/qwen-code-core/utils/shell-utils.js';
import type {
  ShellRawCaptureSink,
  ShellExecutionResult,
} from '@qwen-code/qwen-code-core/services/shellExecutionService.js';
import type { ToolResult } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { ManagedExtensionProcessOwners } from './managed-extension-process.js';

export async function runManagedExtensionShell(
  owners: ManagedExtensionProcessOwners,
  input: {
    sessionId: string;
    configRevision: number;
    command: string;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    signal: AbortSignal;
    capture?: ShellRawCaptureSink;
    timeoutMs?: number;
  },
): Promise<ToolResult> {
  input.signal.throwIfAborted();
  const shell = getShellConfiguration();
  const { child, ownerId } = await owners.start({
    sessionId: input.sessionId,
    configRevision: input.configRevision,
    executable: shell.executable,
    args: [...shell.argsPrefix, input.command],
    cwd: input.cwd,
    env: input.environment,
  });
  const streamsClosed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  if (child.pid) input.capture?.setStarted(child.pid);
  child.stdin?.end();
  const chunks: Buffer[] = [];
  let retained = 0;
  let exceeded = false;
  const captures = { stdout: Promise.resolve(), stderr: Promise.resolve() };
  for (const id of ['stdout', 'stderr'] as const) {
    child[id]?.on('data', (chunk: Buffer) => {
      if (input.capture) {
        child[id]?.pause();
        captures[id] = captures[id]
          .then(() => input.capture!.write(id, chunk))
          .finally(() => child[id]?.resume());
      }
      const remaining = Math.max(0, 1024 * 1024 - retained);
      if (chunk.length > remaining) exceeded = true;
      if (remaining) {
        const prefix = chunk.subarray(0, remaining);
        chunks.push(prefix);
        retained += prefix.length;
      }
    });
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    wake?.();
  };
  try {
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    const interrupted = new Promise<void>((resolve) => {
      wake = resolve;
      input.signal.addEventListener('abort', stop, { once: true });
      if (input.signal.aborted) resolve();
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, input.timeoutMs ?? 120000);
    });
    await Promise.race([exited, interrupted]);
    const receipt = await owners.stop(ownerId).catch(() => {
      throw new ManagedExtensionExecutionUnknownError(
        'Extension Shell process stop is unknown.',
      );
    });
    if (receipt.state !== 'stopped')
      throw new ManagedExtensionExecutionUnknownError(
        'Extension Shell process stop is unknown.',
      );
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        streamsClosed,
        new Promise<never>((_resolve, reject) => {
          drainTimer = setTimeout(
            () =>
              reject(
                new ManagedExtensionExecutionUnknownError(
                  'Extension Shell output closure is unknown.',
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      if (drainTimer) clearTimeout(drainTimer);
    }
    await Promise.all(Object.values(captures));
    const rawOutput = Buffer.concat(chunks);
    const output = rawOutput.toString('utf8');
    const result: ShellExecutionResult = {
      rawOutput,
      output,
      exitCode: child.exitCode,
      signal: null,
      error: null,
      aborted: input.signal.aborted || timedOut,
      pid: child.pid,
      executionMethod: 'child_process',
      outputCaptureLimitExceeded: exceeded,
    };
    input.capture?.setProcessResult(result);
    await input.capture?.finish('stdout', true);
    await input.capture?.finish('stderr', true);
    return {
      llmContent: `${output}${exceeded ? '\n[Output truncated]' : ''}${timedOut ? '\n[Command timed out]' : ''}`,
      returnDisplay: output,
      ...(child.exitCode !== 0 || result.aborted
        ? {
            error: {
              message: result.aborted
                ? 'Shell command stopped.'
                : `Shell exited with code ${child.exitCode}.`,
              type: ToolErrorType.EXECUTION_FAILED,
            },
          }
        : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener('abort', stop);
  }
}
