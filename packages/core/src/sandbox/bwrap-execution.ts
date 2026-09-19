/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type {
  ProcessLaunch,
  ShellExecutionConfig,
  ShellExecuteOptions,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import {
  executeSandboxRelay,
  sandboxAsset,
  type ExecutionSandboxPolicy,
  type SandboxExecutionHandle,
  type SandboxExecutionResult,
} from './sandbox-execution.js';

export { sandboxAsset } from './sandbox-execution.js';
export type BwrapPolicy = ExecutionSandboxPolicy;
export type BwrapExecutionHandle = SandboxExecutionHandle;
export type BwrapExecutionResult = SandboxExecutionResult;

export async function executeBwrap(
  policy: ExecutionSandboxPolicy,
  payload: ProcessLaunch,
  onOutput: (event: ShellOutputEvent) => void,
  signal: AbortSignal,
  usePty = false,
  config: ShellExecutionConfig = {},
  options: ShellExecuteOptions = {},
): Promise<SandboxExecutionHandle> {
  const relay = sandboxAsset('bwrap-relay');
  const node = realpathSync(process.execPath);
  const requestedBwrap = policy.bwrapPath ?? '/usr/bin/bwrap';
  if (!path.isAbsolute(requestedBwrap))
    throw new Error('bwrap path must be absolute.');
  const bwrap = existsSync(requestedBwrap)
    ? realpathSync(requestedBwrap)
    : requestedBwrap;

  return executeSandboxRelay(
    policy,
    payload,
    [path.dirname(relay), path.dirname(node), path.dirname(bwrap)],
    ({
      workspace,
      cwd,
      executable,
      args,
      filesystem,
      network,
      scratch,
      statusPath,
      env,
      stdin,
    }) => {
      const bwrapArgs = [
        '--ro-bind',
        '/',
        '/',
        '--unshare-pid',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--die-with-parent',
        '--clearenv',
      ];
      for (const [key, value] of Object.entries({
        ...env,
        PWD: cwd,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        TERM: env['TERM'] || 'xterm-256color',
      })) {
        if (
          !key ||
          key.includes('=') ||
          key.includes('\0') ||
          value.includes('\0')
        ) {
          throw new Error('Invalid payload environment.');
        }
        bwrapArgs.push('--setenv', key, value);
      }
      bwrapArgs.push('--bind', scratch, scratch);
      if (filesystem === 'workspace-write')
        bwrapArgs.push('--bind', workspace, workspace);
      if (network === 'closed') bwrapArgs.push('--unshare-net');
      bwrapArgs.push('--chdir', cwd, '--', executable, ...args);
      return {
        executable: node,
        args: [relay, String(process.pid), statusPath, bwrap, ...bwrapArgs],
        cwd,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          TERM: env['TERM'] || 'xterm-256color',
          PWD: cwd,
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
