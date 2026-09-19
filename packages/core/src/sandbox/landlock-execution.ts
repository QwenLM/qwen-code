/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ProcessLaunch,
  ShellExecutionConfig,
  ShellExecuteOptions,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import {
  executeSandboxRelay,
  sandboxAsset,
  type ExecutionSandboxPolicy,
  type SandboxExecutionHandle,
} from './sandbox-execution.js';

const moduleFile = fileURLToPath(import.meta.url);
const moduleDirectory = resolveBundleDir(import.meta.url);

export function landlockRunnerPath(
  platform = process.platform,
  arch = process.arch,
): string {
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Landlock does not support ${platform}/${arch}.`);
  }
  const inSourceSandbox = moduleFile.includes(path.join('src', 'sandbox'));
  const levelsUp = !inSourceSandbox ? 0 : moduleFile.endsWith('.ts') ? 2 : 3;
  return path.join(
    moduleDirectory,
    ...Array<string>(levelsUp).fill('..'),
    'vendor',
    'landlock-run',
    `${arch}-linux`,
    'qwen-landlock-run',
  );
}

function resolveRunner(policy: ExecutionSandboxPolicy): string {
  const requested = policy.landlockPath ?? landlockRunnerPath();
  if (!path.isAbsolute(requested))
    throw new Error('Landlock helper path must be absolute.');
  if (!existsSync(requested))
    throw new Error(`Landlock helper is missing: ${requested}`);
  return realpathSync(requested);
}

export async function probeLandlock(
  policy: ExecutionSandboxPolicy,
  signal: AbortSignal,
): Promise<{ abi: number; enforcement: 'partial' }> {
  if (policy.network !== 'open') {
    throw new Error('Landlock cannot enforce network: closed.');
  }
  const runner = resolveRunner(policy);
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
  const runner = resolveRunner(policy);
  const relay = sandboxAsset('landlock-relay');
  const node = realpathSync(process.execPath);
  return executeSandboxRelay(
    policy,
    payload,
    [path.dirname(runner), path.dirname(relay), path.dirname(node)],
    ({
      workspace,
      cwd,
      executable,
      args,
      filesystem,
      scratch,
      statusPath,
      env,
      stdin,
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
        args: [relay, String(process.pid), statusPath, runner, ...runnerArgs],
        cwd,
        env: {
          ...env,
          PWD: cwd,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
          TERM: env['TERM'] || 'xterm-256color',
        },
        stdin,
      };
    },
    onOutput,
    signal,
    usePty,
    config,
    options,
  );
}
