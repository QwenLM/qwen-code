/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
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

import { resolveStdinBridge } from './landlock-runner-path.js';

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
  const inputBridge = payload.inheritStdin ? resolveStdinBridge() : undefined;
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
    [
      path.dirname(relay),
      path.dirname(node),
      path.dirname(bwrap),
      ...(inputBridge ? [path.dirname(inputBridge)] : []),
    ],
    ({
      workspace,
      cwd,
      executable,
      args,
      filesystem,
      network,
      scratch,
      statusPath,
      payloadEnvPath,
      maskedPaths,
      env,
      stdin,
      inheritStdin,
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
      ];
      bwrapArgs.push('--bind', scratch, scratch);
      if (filesystem === 'workspace-write')
        bwrapArgs.push('--bind', workspace, workspace);
      for (const maskedPath of maskedPaths) {
        if (!existsSync(maskedPath)) {
          if (filesystem === 'read-only') continue;
          mkdirSync(maskedPath, { recursive: true });
        }
        if (!statSync(maskedPath).isDirectory())
          throw new Error('Sandbox mask paths must be directories.');
        bwrapArgs.push('--tmpfs', maskedPath);
      }
      if (network === 'closed') bwrapArgs.push('--unshare-net');
      bwrapArgs.push('--chdir', cwd, '--', executable, ...args);
      return {
        executable: node,
        args: [
          relay,
          String(process.pid),
          statusPath,
          payloadEnvPath,
          inputBridge ?? '',
          bwrap,
          ...bwrapArgs,
        ],
        cwd,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          TERM: env['TERM'] || 'xterm-256color',
          PWD: cwd,
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
