/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { isSubpath, realpathNearestExisting } from '../utils/paths.js';
import { isInternalSecretEnvVar } from '../utils/sanitize-child-env.js';
import { sandboxStatusError, type SandboxStatus } from './sandbox-status.js';

const debugLogger = createDebugLogger('SANDBOX_EXECUTION');

export type ExecutionSandboxBackend = 'bwrap' | 'landlock';
export type ExecutionSandboxEnforcement = 'full' | 'partial';

export interface ExecutionSandboxPolicy {
  workspace: string;
  installation: string;
  state: string;
  maskedPaths?: readonly string[];
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

const overlaps = (a: string, b: string) => isSubpath(a, b) || isSubpath(b, a);
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
  payloadEnvPath: string;
  maskedPaths: readonly string[];
  env: Record<string, string>;
  stdin: string | Buffer | undefined;
  inheritStdin: boolean | undefined;
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
  if (payload.stdin !== undefined && payload.inheritStdin)
    throw new Error('Process stdin cannot be both piped and inherited.');
  if (usePty && (payload.stdin !== undefined || payload.inheritStdin))
    throw new Error('Process stdin requires pipe execution.');
  const workspace = directory(policy.workspace);
  const state = directory(policy.state);
  const protectedRoots = [
    directory(policy.installation),
    state,
    ...runnerProtectedRoots,
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
      isSubpath(root, realpathSync(os.homedir())) ||
      protectedRoots.some((protectedRoot) => overlaps(root, protectedRoot))
    ) {
      throw new Error('Writable directory overlaps a protected root.');
    }
  };
  // Keep this admission invariant even for read-only profiles so a later profile
  // change cannot turn a trusted installation/state directory into a workspace.
  checkWritable(workspace);
  const maskedPaths = (policy.maskedPaths ?? []).map((value) => {
    if (!path.isAbsolute(value))
      throw new Error('Sandbox mask paths must be absolute.');
    const resolved = realpathNearestExisting(value);
    if (resolved === workspace || !isSubpath(workspace, resolved))
      throw new Error('Sandbox mask paths must remain inside the workspace.');
    return resolved;
  });
  const cwd = directory(payload.cwd);
  if (!isSubpath(workspace, cwd))
    throw new Error('Payload cwd must be inside the workspace.');
  const executable = payload.executable;
  const args = [...payload.args];
  const env = Object.fromEntries(
    Object.entries(payload.env).filter(([key]) => !isInternalSecretEnvVar(key)),
  );
  const stdin = Buffer.isBuffer(payload.stdin)
    ? Buffer.from(payload.stdin)
    : payload.stdin;
  const inheritStdin = payload.inheritStdin;
  const filesystem = policy.filesystem;
  const network = policy.network;
  const control = await mkdtemp(path.join(state, 'sandbox-control-'));
  let scratch: string | undefined;
  const cleanup = async () => {
    const results = await Promise.allSettled([
      rm(control, { recursive: true, force: true }),
      ...(scratch ? [rm(scratch, { recursive: true, force: true })] : []),
    ]);
    for (const result of results) {
      if (result.status === 'rejected')
        debugLogger.warn(
          'Sandbox temporary directory cleanup failed',
          result.reason,
        );
    }
  };
  try {
    const requestedScratchRoot = os.tmpdir();
    const scratchRoot =
      path.isAbsolute(requestedScratchRoot) && existsSync(requestedScratchRoot)
        ? realpathSync(requestedScratchRoot)
        : realpathSync('/tmp');
    if (
      isSubpath(workspace, scratchRoot) ||
      protectedRoots.some((protectedRoot) =>
        isSubpath(protectedRoot, scratchRoot),
      )
    )
      throw new Error(
        `Temporary root ${scratchRoot} overlaps the workspace or a protected root.`,
      );
    scratch = await mkdtemp(path.join(scratchRoot, 'qwen-sandbox-'));
    scratch = directory(scratch);
    checkWritable(scratch);
    if (overlaps(workspace, scratch))
      throw new Error('Workspace and scratch must be disjoint.');
    const payloadEnv = {
      ...env,
      PWD: cwd,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      TERM: env['TERM'] || 'xterm-256color',
    };
    for (const [key, value] of Object.entries(payloadEnv)) {
      if (
        !key ||
        key.includes('=') ||
        key.includes('\0') ||
        value.includes('\0')
      )
        throw new Error('Invalid payload environment.');
    }
    const payloadEnvPath = path.join(control, 'payload-env.json');
    await writeFile(payloadEnvPath, JSON.stringify(payloadEnv), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
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
        // The relay creates the receipt file (O_EXCL) before spawning the backend,
        // so its existence attests the relay got as far as the spawn call.
        let receiptExisted = false;
        let receiptParsed = false;
        if (info.aborted || isSignalTermination(info.signal))
          status = { state: 'interrupted' };
        else {
          try {
            const text = await readFile(statusPath, 'utf8');
            // The file existing at all attests the relay got past its
            // O_EXCL create — i.e. as far as the backend spawn call.
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
            )
              status = { state: 'confirmed', exitCode: record['exitCode'] };
            else if (record['state'] === 'interrupted')
              status = { state: 'interrupted' };
            else {
              // Preserve the attestation exactly as written: an absent or
              // non-boolean field means "unknown", never "did not run"
              // (PR #12067 review, round 2).
              const attested = record['payloadExitObserved'];
              status = {
                state: 'unconfirmed',
                ...(typeof attested === 'boolean'
                  ? { payloadExitObserved: attested }
                  : {}),
              };
            }
          } catch {
            /* Missing/partial receipt never proves that the payload did not run. */
          }
        }
        // Retain the dirs unless the payload provably did not run. Two
        // positive proofs allow cleanup: the receipt attests no payload
        // exit record (spawn failure, or a wire showing the payload never
        // got past exec — missing backend or payload binary), or the receipt
        // file is absent, which means the relay died before its O_EXCL
        // create and therefore before spawning the backend. Everything else —
        // an attested exit record, an unreadable receipt, or an
        // unattested unconfirmed — is unknown and retains (PR #12067
        // review: the coarse key leaked a dir pair per pre-exec failure,
        // while collapsing "unknown" into "did not run" inverts the
        // fail-safe for a retry-deciding caller).
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
      payloadEnvPath,
      maskedPaths,
      env,
      stdin,
      inheritStdin,
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
                // The specific transport/spawn error outranks the generic
                // status-derived one: an unconfirmed run caused by a relay
                // spawn failure should surface the spawn error, not the
                // catch-all "could not be confirmed" (PR #12067 review).
                const error = info.error ?? sandboxStatusError(status);
                options.postPromote?.onSettle?.({ ...info, error });
              })
              .catch((settleError: unknown) => {
                // The caller's postPromote.onSettle throws here, one await
                // past the service's own try/catch guard — log instead of
                // discarding (PR #12067 review).
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
