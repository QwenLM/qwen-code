/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { addAbortListener } from 'node:events';
import {
  accessSync,
  constants,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import type {
  ProcessLaunch,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { isSubpath } from '../utils/paths.js';
import { getJsInterpreterCommand } from '../utils/runtime-info.js';
import {
  executeSandboxRelay,
  sandboxAsset,
  type ExecutionSandboxPolicy,
  type SandboxExecutionHandle,
} from './sandbox-execution.js';

type PrivateRootPolicy = Pick<
  ExecutionSandboxPolicy,
  'workspace' | 'installation' | 'state' | 'filesystem' | 'bwrapPath'
> & { rootfs: string };

export async function executePrivateRootBwrap(
  policy: PrivateRootPolicy,
  payload: Pick<ProcessLaunch, 'executable' | 'args' | 'stdin'>,
  onOutput: (event: ShellOutputEvent) => void,
  signal: AbortSignal,
): Promise<SandboxExecutionHandle> {
  if (
    process.platform !== 'linux' ||
    !process.getuid?.() ||
    !process.geteuid?.()
  ) {
    throw new Error('Private-root bwrap requires a non-root Linux worker.');
  }
  const {
    workspace,
    installation,
    state,
    filesystem,
    rootfs: requestedRoot,
    bwrapPath = '/usr/bin/bwrap',
  } = policy;
  if (!path.isAbsolute(requestedRoot) || !path.isAbsolute(bwrapPath)) {
    throw new Error(
      'Private-root bwrap requires absolute image and launcher paths.',
    );
  }
  const rootfs = realpathSync(requestedRoot);
  if (!statSync(rootfs).isDirectory()) {
    throw new Error('Private-root bwrap image must be a directory.');
  }
  const bwrap = realpathSync(bwrapPath);
  const launcher = statSync(bwrap);
  if (!launcher.isFile() || (launcher.mode & 0o6000) !== 0) {
    throw new Error(
      'Private-root bwrap requires a non-setuid, non-setgid executable.',
    );
  }
  accessSync(bwrap, constants.X_OK);

  const relay = sandboxAsset('bwrap-relay');
  const interpreter = realpathSync(
    getJsInterpreterCommand(import.meta.url).command,
  );
  const launcherRoots = [relay, interpreter, bwrap].map((file) =>
    path.dirname(file),
  );
  for (const hostPath of [installation, state, ...launcherRoots]) {
    const hostRoot = realpathSync(hostPath);
    if (isSubpath(rootfs, hostRoot) || isSubpath(hostRoot, rootfs)) {
      throw new Error('Private-root image overlaps a protected host root.');
    }
  }
  for (const mount of ['workspace', 'tmp', 'dev']) {
    const target = path.join(rootfs, mount);
    if (!lstatSync(target).isDirectory() || readdirSync(target).length !== 0) {
      throw new Error('Private-root mount points must be empty directories.');
    }
  }

  // A foreground launch must never hand process ownership to the Shell service.
  const cancel = new AbortController();
  const abortListener = addAbortListener(signal, () => cancel.abort());
  try {
    const handle = await executeSandboxRelay(
      { workspace, installation, state, filesystem, network: 'closed' },
      {
        executable: payload.executable,
        args: payload.args,
        stdin: payload.stdin,
        cwd: workspace,
        env: {},
      },
      [...launcherRoots, rootfs],
      ({
        workspace,
        filesystem,
        executable,
        args,
        stdin,
        statusPath,
        payloadEnvPath,
      }) => ({
        executable: interpreter,
        args: [
          relay,
          String(process.pid),
          statusPath,
          payloadEnvPath,
          '',
          bwrap,
          '--unshare-user',
          '--disable-userns',
          '--unshare-pid',
          '--unshare-net',
          '--unshare-ipc',
          '--unshare-uts',
          '--cap-drop',
          'ALL',
          '--new-session',
          '--die-with-parent',
          '--ro-bind',
          rootfs,
          '/',
          filesystem === 'workspace-write' ? '--bind' : '--ro-bind',
          workspace,
          '/workspace',
          '--tmpfs',
          '/tmp',
          '--dev',
          '/dev',
          '--clearenv',
          '--setenv',
          'PATH',
          '/usr/bin:/bin',
          '--setenv',
          'LANG',
          'C',
          '--setenv',
          'HOME',
          '/tmp',
          '--setenv',
          'PWD',
          '/workspace',
          '--setenv',
          'TMPDIR',
          '/tmp',
          '--setenv',
          'TMP',
          '/tmp',
          '--setenv',
          'TEMP',
          '/tmp',
          '--chdir',
          '/workspace',
          '--',
          executable,
          ...args,
        ],
        cwd: path.dirname(statusPath),
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdin,
      }),
      onOutput,
      cancel.signal,
    );
    return {
      ...handle,
      result: handle.result.finally(() => abortListener[Symbol.dispose]()),
    };
  } catch (error) {
    abortListener[Symbol.dispose]();
    throw error;
  }
}
