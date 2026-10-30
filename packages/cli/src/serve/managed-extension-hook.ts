/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookRunner } from '@qwen-code/qwen-code-core/hooks/hookRunner.js';
import { resolveCommandHookTimeoutMs } from '@qwen-code/qwen-code-core/hooks/hook-timeout.js';
import type {
  CommandHookConfig,
  HookExecutionResult,
  HookInput,
  HookEventName,
} from '@qwen-code/qwen-code-core/hooks/types.js';
import type { ManagedExtensionProcessOwners } from './managed-extension-process.js';

export async function executeManagedExtensionCommandHook(
  runner: HookRunner,
  owners: ManagedExtensionProcessOwners,
  sessionId: string,
  configRevision: number,
  config: CommandHookConfig,
  input: HookInput,
  signal: AbortSignal,
  environment: NodeJS.ProcessEnv,
): Promise<HookExecutionResult> {
  const startedAt = Date.now();
  signal.throwIfAborted();
  const { shellConfig, command, env } = runner.commandInvocation(
    config,
    input,
    environment,
  );
  const { child, ownerId } = await owners.start({
    sessionId,
    configRevision,
    executable: shellConfig.executable,
    args: [...shellConfig.argsPrefix, command],
    env,
    cwd: input.cwd,
  });
  let stdout = '';
  let stderr = '';
  let overflow = false;
  const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    if (stream === 'stdout') stdout += chunk.toString();
    else stderr += chunk.toString();
    if (
      Buffer.byteLength(stdout) > 1024 * 1024 ||
      Buffer.byteLength(stderr) > 1024 * 1024
    ) {
      overflow = true;
      stdout = stdout.slice(0, 1024 * 1024);
      stderr = stderr.slice(0, 1024 * 1024);
      void owners.stop(ownerId);
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
  child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(JSON.stringify(input));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const exit = new Promise<'exited'>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        resolve('exited');
      else child.once('exit', () => resolve('exited'));
    });
    const cancelled = new Promise<'cancelled'>((resolve) => {
      cancel = () => resolve('cancelled');
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(
        () => resolve('timeout'),
        resolveCommandHookTimeoutMs(
          config.timeout,
          config.name ?? config.command,
        ),
      );
    });
    const outcome = await Promise.race([exit, cancelled, timeout]);
    const receipt = await owners.stop(ownerId);
    const result: HookExecutionResult =
      outcome === 'exited'
        ? runner.commandResult(
            config,
            input.hook_event_name as HookEventName,
            stdout,
            stderr,
            child.exitCode,
            Date.now() - startedAt,
          )
        : ({
            hookConfig: config,
            eventName: input.hook_event_name as HookEventName,
            success: false,
            outcome,
            duration: Date.now() - startedAt,
            stdout,
            stderr,
          } satisfies HookExecutionResult);
    if (overflow) {
      result.success = false;
      result.outcome = 'non_blocking_error';
      result.error = new Error('Hook output exceeds its size limit.');
    }
    return {
      ...result,
      processReceipt: receipt,
      ...(receipt.scope === 'process_tree'
        ? { processTreeDrained: receipt.state === 'stopped' }
        : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal.removeEventListener('abort', cancel);
  }
}
