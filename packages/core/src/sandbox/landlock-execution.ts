/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import type {
  ProcessLaunch,
  ShellExecutionConfig,
  ShellExecuteOptions,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import {
  resolveLandlockRunner,
  resolveStdinBridge,
} from './landlock-runner-path.js';
export { landlockRunnerPath } from './landlock-runner-path.js';
import {
  executeSandboxRelay,
  sandboxAsset,
  type ExecutionSandboxPolicy,
  type SandboxExecutionHandle,
} from './sandbox-execution.js';

export async function probeLandlock(
  policy: ExecutionSandboxPolicy,
  signal: AbortSignal,
): Promise<{ abi: number; enforcement: 'partial' }> {
  if (policy.network !== 'open') {
    throw new Error('Landlock cannot enforce network: closed.');
  }
  if (policy.maskedPaths?.length)
    throw new Error('Landlock cannot enforce masked paths.');
  const runner = resolveLandlockRunner(policy.landlockPath);
  const handle = await ShellExecutionService.executeLaunch(
    {
      executable: runner,
      args: ['--probe'],
      cwd: policy.workspace,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    },
    () => {},
    signal,
    false,
    {},
  );
  const result = await handle.result;
  if (result.error || result.aborted || result.exitCode !== 0) {
    throw new Error(
      `Landlock capability probe failed: ${result.error?.message ?? (result.output || `exit ${result.exitCode}`)}`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.output.trim()) as Record<string, unknown>;
  } catch {
    throw new Error('Landlock capability probe returned an invalid report.');
  }
  if (
    typeof parsed['abi'] !== 'number' ||
    !Number.isInteger(parsed['abi']) ||
    parsed['abi'] < 3 ||
    parsed['enforcement'] !== 'partial'
  ) {
    throw new Error('Landlock capability probe returned an invalid report.');
  }
  const policyProbe = await executeLandlock(
    policy,
    {
      executable: '/usr/bin/true',
      args: [],
      cwd: policy.workspace,
      env: { PATH: '/usr/bin:/bin' },
    },
    () => {},
    signal,
  );
  const policyResult = await policyProbe.result;
  if (
    policyResult.sandboxStatus.state !== 'confirmed' ||
    policyResult.sandboxStatus.exitCode !== 0 ||
    policyResult.error ||
    policyResult.aborted
  ) {
    throw new Error(
      `Landlock policy probe failed: ${policyResult.error?.message || policyResult.output || policyResult.sandboxStatus.state}`,
    );
  }
  return { abi: parsed['abi'], enforcement: 'partial' };
}

export async function executeLandlock(
  policy: ExecutionSandboxPolicy,
  payload: ProcessLaunch,
  onOutput: (event: ShellOutputEvent) => void,
  signal: AbortSignal,
  usePty = false,
  config: ShellExecutionConfig = {},
  options: ShellExecuteOptions = {},
): Promise<SandboxExecutionHandle> {
  if (policy.network !== 'open')
    throw new Error('Landlock cannot enforce network: closed.');
  if (policy.maskedPaths?.length)
    throw new Error('Landlock cannot enforce masked paths.');
  const runner = resolveLandlockRunner(policy.landlockPath);
  const relay = sandboxAsset('landlock-relay');
  const inputBridge = payload.inheritStdin
    ? resolveStdinBridge(policy.landlockPath)
    : undefined;
  const node = realpathSync(process.execPath);
  return executeSandboxRelay(
    policy,
    payload,
    [
      path.dirname(runner),
      path.dirname(relay),
      path.dirname(node),
      ...(inputBridge ? [path.dirname(inputBridge)] : []),
    ],
    ({
      workspace,
      cwd,
      executable,
      args,
      filesystem,
      scratch,
      statusPath,
      payloadEnvPath,
      env,
      stdin,
      inheritStdin,
    }) => {
      const runnerArgs = [
        '--status-fd',
        '3',
        '--ro',
        '/',
        '--rw',
        '/dev/null',
        '--rw',
        scratch,
      ];
      if (filesystem === 'workspace-write') runnerArgs.push('--rw', workspace);
      runnerArgs.push('--', executable, ...args);
      return {
        executable: node,
        args: [
          relay,
          String(process.pid),
          statusPath,
          payloadEnvPath,
          inputBridge ?? '',
          runner,
          ...runnerArgs,
        ],
        cwd,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          PWD: cwd,
          TERM: env['TERM'] || 'xterm-256color',
        },
        stdin,
        inheritStdin,
      };
    },
    onOutput,
    signal,
    usePty,
    config,
    options,
  );
}
