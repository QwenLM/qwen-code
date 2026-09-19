/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ShellExecutionService,
  isSignalTermination,
} from '../services/shellExecutionService.js';
import type {
  ProcessLaunch,
  ShellExecutionConfig,
  ShellExecuteOptions,
  ShellExecutionResult,
  ShellOutputEvent,
  ShellPostPromoteSettleInfo,
} from '../services/shellExecutionService.js';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isInternalSecretEnvVar } from '../utils/sanitize-child-env.js';
import { sandboxStatusError, type SandboxStatus } from './sandbox-status.js';

const debugLogger = createDebugLogger('SANDBOX_EXECUTION');

export type ExecutionSandboxBackend = 'bwrap' | 'landlock';
export type ExecutionSandboxEnforcement = 'full' | 'partial';

export interface ExecutionSandboxPolicy {
  workspace: string;
  installation: string;
  state: string;
  filesystem: 'read-only' | 'workspace-write';
  network: 'open' | 'closed';
  requestedBackend?: 'auto' | ExecutionSandboxBackend;
  effectiveBackend?: ExecutionSandboxBackend;
  enforcement?: ExecutionSandboxEnforcement;
  landlockAbi?: number;
  bwrapPath?: string;
  landlockPath?: string;
}

export interface ResolvedExecutionSandboxPolicy extends ExecutionSandboxPolicy {
  effectiveBackend: ExecutionSandboxBackend;
  enforcement: ExecutionSandboxEnforcement;
}

export interface SandboxExecutionResult extends ShellExecutionResult {
  sandboxStatus: SandboxStatus;
}

export interface SandboxExecutionHandle {
  pid: number | undefined;
  result: Promise<SandboxExecutionResult>;
  settled: Promise<SandboxStatus>;
}

export function sandboxAsset(
  name: 'bwrap-relay' | 'landlock-relay' | 'file-worker',
): string {
  const sibling = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    `${name}.js`,
  );
  const bundledNames = {
    'bwrap-relay': 'sandboxBwrapRelay.js',
    'landlock-relay': 'sandboxLandlockRelay.js',
    'file-worker': 'sandboxFileWorker.js',
  } as const;
  const bundled = path.join(
    resolveBundleDir(import.meta.url),
    bundledNames[name],
  );
  const asset = existsSync(sibling) ? sibling : bundled;
  if (!existsSync(asset)) {
    throw new Error(
      'Sandbox assets are missing. Run the build and bundle first.',
    );
  }
  return realpathSync(asset);
}

const contains = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);
const directory = (value: string) => {
  if (!path.isAbsolute(value))
    throw new Error('Sandbox paths must be absolute.');
  const resolved = realpathSync(value);
  if (!statSync(resolved).isDirectory())
    throw new Error('Expected sandbox directory.');
  return resolved;
};

interface SandboxLaunchContext {
  workspace: string;
  cwd: string;
  executable: string;
  args: string[];
  filesystem: ExecutionSandboxPolicy['filesystem'];
  network: ExecutionSandboxPolicy['network'];
  scratch: string;
  statusPath: string;
  env: Record<string, string>;
  stdin: string | Buffer | undefined;
}

export async function executeSandboxRelay(
  policy: ExecutionSandboxPolicy,
  payload: ProcessLaunch,
  runnerProtectedRoots: string[],
  createLaunch: (context: SandboxLaunchContext) => ProcessLaunch,
  onOutput: (event: ShellOutputEvent) => void,
  signal: AbortSignal,
  usePty = false,
  config: ShellExecutionConfig = {},
  options: ShellExecuteOptions = {},
): Promise<SandboxExecutionHandle> {
  if (process.platform !== 'linux')
    throw new Error('Tool execution sandbox requires Linux.');
  if (
    !['read-only', 'workspace-write'].includes(policy.filesystem) ||
    !['open', 'closed'].includes(policy.network)
  ) {
    throw new Error('Unsupported sandbox policy.');
  }
  if (!path.isAbsolute(payload.executable) || !path.isAbsolute(payload.cwd))
    throw new Error('Payload paths must be absolute.');
  if (usePty && payload.stdin !== undefined)
    throw new Error('Process stdin requires pipe execution.');
  const executable = payload.executable;
  const args = [...payload.args];
  const filesystem = policy.filesystem;
  const network = policy.network;

  const workspace = directory(policy.workspace);
  const state = directory(policy.state);
  const protectedRoots = [
    directory(policy.installation),
    state,
    ...runnerProtectedRoots.map(directory),
    ...[
      '/proc',
      '/dev',
      '/sys',
      '/etc',
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
    ]
      .filter(existsSync)
      .map((value) => realpathSync(value)),
  ];
  const checkWritable = (root: string) => {
    if (
      contains(root, realpathSync(os.homedir())) ||
      protectedRoots.some((protectedRoot) => overlaps(root, protectedRoot))
    ) {
      throw new Error('Writable directory overlaps a protected root.');
    }
  };
  checkWritable(workspace);
  const cwd = directory(payload.cwd);
  if (!contains(workspace, cwd))
    throw new Error('Payload cwd must be inside the workspace.');

  const env = Object.fromEntries(
    Object.entries(payload.env).filter(([key]) => !isInternalSecretEnvVar(key)),
  );
  const stdin = Buffer.isBuffer(payload.stdin)
    ? Buffer.from(payload.stdin)
    : payload.stdin;
  const control = await mkdtemp(path.join(state, 'sandbox-control-'));
  let scratch: string | undefined;
  const cleanup = async () => {
    const results = await Promise.allSettled([
      rm(control, { recursive: true, force: true }),
      ...(scratch ? [rm(scratch, { recursive: true, force: true })] : []),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        debugLogger.warn(
          'Sandbox temporary directory cleanup failed',
          result.reason,
        );
      }
    }
  };

  try {
    const requestedScratchRoot = os.tmpdir();
    const scratchRoot =
      path.isAbsolute(requestedScratchRoot) && existsSync(requestedScratchRoot)
        ? realpathSync(requestedScratchRoot)
        : realpathSync('/tmp');
    if (
      contains(workspace, scratchRoot) ||
      protectedRoots.some((protectedRoot) =>
        contains(protectedRoot, scratchRoot),
      )
    ) {
      throw new Error(
        `Temporary root ${scratchRoot} overlaps the workspace or a protected root.`,
      );
    }
    scratch = directory(await mkdtemp(path.join(scratchRoot, 'qwen-sandbox-')));
    checkWritable(scratch);
    if (overlaps(workspace, scratch))
      throw new Error('Workspace and scratch must be disjoint.');

    const statusPath = path.join(control, 'status.json');
    let complete!: (status: SandboxStatus) => void;
    const settled = new Promise<SandboxStatus>((resolve) => {
      complete = resolve;
    });
    let finalizing: Promise<SandboxStatus> | undefined;
    const finalize = (info: {
      signal: number | NodeJS.Signals | null;
      aborted?: boolean;
      exitCode: number | null;
      error?: unknown;
    }) =>
      (finalizing ??= (async () => {
        let status: SandboxStatus = { state: 'unconfirmed' };
        let receiptExisted = false;
        let receiptParsed = false;
        if (info.aborted || isSignalTermination(info.signal)) {
          status = { state: 'interrupted' };
        } else {
          try {
            const text = await readFile(statusPath, 'utf8');
            receiptExisted = true;
            const record = JSON.parse(text) as Record<string, unknown>;
            receiptParsed = true;
            if (
              !info.error &&
              record['state'] === 'confirmed' &&
              record['exitCode'] === info.exitCode &&
              typeof record['exitCode'] === 'number' &&
              Number.isInteger(record['exitCode']) &&
              record['exitCode'] >= 0 &&
              record['exitCode'] <= 255
            ) {
              status = { state: 'confirmed', exitCode: record['exitCode'] };
            } else if (record['state'] === 'interrupted') {
              status = { state: 'interrupted' };
            } else {
              const attested = record['payloadExitObserved'];
              status = {
                state: 'unconfirmed',
                ...(typeof attested === 'boolean'
                  ? { payloadExitObserved: attested }
                  : {}),
              };
            }
          } catch {
            /* Missing or partial evidence never proves the payload did not run. */
          }
        }
        const attestedNoExec =
          receiptExisted &&
          receiptParsed &&
          status.state === 'unconfirmed' &&
          status.payloadExitObserved === false;
        const relayDiedBeforeSpawn = !receiptExisted;
        const retain =
          status.state === 'unconfirmed' &&
          !attestedNoExec &&
          !relayDiedBeforeSpawn;
        if (retain) {
          debugLogger.warn(
            'Sandbox termination is unconfirmed; retaining temporary directories',
            { control, scratch },
          );
        } else {
          await cleanup();
        }
        complete(status);
        return status;
      })());

    const launch = createLaunch({
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
    });
    const handle = await ShellExecutionService.executeLaunch(
      launch,
      onOutput,
      signal,
      usePty,
      config,
      {
        ...options,
        postPromote: {
          onData: options.postPromote?.onData,
          onSettle: (info: ShellPostPromoteSettleInfo) => {
            void finalize(info)
              .then((status) => {
                const error = info.error ?? sandboxStatusError(status);
                options.postPromote?.onSettle?.({ ...info, error });
              })
              .catch((settleError: unknown) => {
                debugLogger.warn(
                  `post-promote settle chain failed: ${settleError instanceof Error ? settleError.message : String(settleError)}`,
                );
              });
          },
        },
      },
    );
    return {
      pid: handle.pid,
      settled,
      result: handle.result.then(
        async (result) => {
          const sandboxStatus: SandboxStatus = result.promoted
            ? { state: 'running' }
            : await finalize(result);
          return {
            ...result,
            error: result.error ?? sandboxStatusError(sandboxStatus) ?? null,
            sandboxStatus,
          };
        },
        async (error: unknown) => {
          await finalize({ signal: null, exitCode: null, error });
          throw error;
        },
      ),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
