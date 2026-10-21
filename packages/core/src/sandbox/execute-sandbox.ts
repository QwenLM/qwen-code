/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ProcessLaunch,
  ShellExecutionConfig,
  ShellExecuteOptions,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { executeBwrap } from './bwrap-execution.js';
import { executeLandlock } from './landlock-execution.js';
import type {
  ExecutionSandboxPolicy,
  SandboxExecutionHandle,
} from './sandbox-execution.js';

export function executeSandbox(
  policy: Readonly<ExecutionSandboxPolicy>,
  payload: ProcessLaunch,
  onOutput: (event: ShellOutputEvent) => void,
  signal: AbortSignal,
  usePty = false,
  config: ShellExecutionConfig = {},
  options: ShellExecuteOptions = {},
): Promise<SandboxExecutionHandle> {
  if (policy.effectiveBackend === 'bwrap') {
    return executeBwrap(
      policy,
      payload,
      onOutput,
      signal,
      usePty,
      config,
      options,
    );
  }
  if (policy.effectiveBackend === 'landlock') {
    return executeLandlock(
      policy,
      payload,
      onOutput,
      signal,
      usePty,
      config,
      options,
    );
  }
  return Promise.reject(new Error('Sandbox backend was not resolved.'));
}
