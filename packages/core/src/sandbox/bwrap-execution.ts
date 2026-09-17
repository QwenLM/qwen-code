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
import { resolveBundleDir } from '../utils/bundlePaths.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { isInternalSecretEnvVar } from '../utils/sanitize-child-env.js';
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
import { sandboxStatusError, type BwrapStatus } from './bwrap-status.js';
import { realpathNearestExisting } from '../utils/paths.js';

const debugLogger = createDebugLogger('BWRAP_EXECUTION');

export interface BwrapPolicy {
  workspace: string;
  installation: string;
  state: string;
  filesystem: 'read-only' | 'workspace-write';
  network: 'open' | 'closed';
  bwrapPath?: string;
  protectedRoots?: readonly string[];
}

export interface BwrapExecutionResult extends ShellExecutionResult {
  sandboxStatus: BwrapStatus;
}

export interface BwrapExecutionHandle {
  pid: number | undefined;
  result: Promise<BwrapExecutionResult>;
  settled: Promise<BwrapStatus>;
}

export function sandboxAsset(name: 'bwrap-relay' | 'file-worker'): string {
  const sibling = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    `${name}.js`,
  );
  const bundled = path.join(
    resolveBundleDir(import.meta.url),
    name === 'bwrap-relay' ? 'sandboxBwrapRelay.js' : 'sandboxFileWorker.js',
  );
  const asset = existsSync(sibling) ? sibling : bundled;
  if (!existsSync(asset))
    throw new Error(
      'Sandbox assets are missing. Run the build and bundle first.',
    );
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

export async function executeBwrap(
  policy: BwrapPolicy,
  payload: ProcessLaunch,
  onOutput: (event: ShellOutputEvent) => void,
  signal: AbortSignal,
  usePty = false,
  config: ShellExecutionConfig = {},
  options: ShellExecuteOptions = {},
): Promise<BwrapExecutionHandle> {
  if (process.platform !== 'linux')
    throw new Error('bwrap execution requires Linux.');
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
  const workspace = directory(policy.workspace);
  const state = directory(policy.state);
  const relay = sandboxAsset('bwrap-relay');
  const node = realpathSync(process.execPath);
  const requestedBwrap = policy.bwrapPath ?? '/usr/bin/bwrap';
  if (!path.isAbsolute(requestedBwrap))
    throw new Error('bwrap path must be absolute.');
  const bwrap = existsSync(requestedBwrap)
    ? realpathSync(requestedBwrap)
    : requestedBwrap;
  const protectedRoots = [
    directory(policy.installation),
    state,
    path.dirname(relay),
    path.dirname(node),
    path.dirname(bwrap),
    ...(policy.protectedRoots ?? []).map((root) => {
      if (!path.isAbsolute(root))
        throw new Error('Protected sandbox paths must be absolute.');
      return realpathNearestExisting(root);
    }),
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
  // Keep this admission invariant even for read-only profiles so a later profile
  // change cannot turn a trusted installation/state directory into a workspace.
  checkWritable(workspace);
  const cwd = directory(payload.cwd);
  if (!contains(workspace, cwd))
    throw new Error('Payload cwd must be inside the workspace.');
  const executable = payload.executable;
  const args = [...payload.args];
  const env = Object.fromEntries(
    Object.entries(payload.env).filter(([key]) => !isInternalSecretEnvVar(key)),
  );
  const stdin = Buffer.isBuffer(payload.stdin)
    ? Buffer.from(payload.stdin)
    : payload.stdin;
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
    scratch = directory(await mkdtemp(path.join(os.tmpdir(), 'qwen-sandbox-')));
    checkWritable(scratch);
    if (overlaps(workspace, scratch))
      throw new Error('Workspace and scratch must be disjoint.');
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
      // `--clearenv` wipes everything before these --setenv apply, so a
      // payload env without TERM would run with TERM unset (ncurses:
      // "unknown terminal type"). The relay bootstrap TERM default never
      // reaches the payload; the default belongs here.
      TERM: env['TERM'] || 'xterm-256color',
    })) {
      if (
        !key ||
        key.includes('=') ||
        key.includes('\0') ||
        value.includes('\0')
      )
        throw new Error('Invalid payload environment.');
      bwrapArgs.push('--setenv', key, value);
    }
    bwrapArgs.push('--bind', scratch, scratch);
    if (filesystem === 'workspace-write')
      bwrapArgs.push('--bind', workspace, workspace);
    if (network === 'closed') bwrapArgs.push('--unshare-net');
    bwrapArgs.push('--chdir', cwd, '--', executable, ...args);
    const statusPath = path.join(control, 'status.json');
    let complete!: (status: BwrapStatus) => void;
    const settled = new Promise<BwrapStatus>((resolve) => {
      complete = resolve;
    });
    let finalizing: Promise<BwrapStatus> | undefined;
    const finalize = (info: {
      signal: number | NodeJS.Signals | null;
      aborted?: boolean;
      exitCode: number | null;
      error?: unknown;
    }) =>
      (finalizing ??= (async () => {
        let status: BwrapStatus = { state: 'unconfirmed' };
        // The relay creates the receipt file (O_EXCL) before spawning bwrap,
        // so its existence attests the relay got as far as the spawn call.
        let receiptExisted = false;
        let receiptParsed = false;
        if (info.aborted || isSignalTermination(info.signal))
          status = { state: 'interrupted' };
        else {
          try {
            const text = await readFile(statusPath, 'utf8');
            // The file existing at all attests the relay got past its
            // O_EXCL create — i.e. as far as the bwrap spawn call.
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
            else
              status = {
                state: 'unconfirmed',
                payloadExitObserved: record['payloadExitObserved'] === true,
              };
          } catch {
            /* Missing/partial receipt never proves that the payload did not run. */
          }
        }
        // Retain the dirs only when the payload may genuinely have run:
        // either the receipt attests a payload exit record (payload past
        // exec, correlation failed), or the receipt exists but is
        // unreadable (relay died mid-payload). A missing receipt means the
        // relay died before spawning bwrap, and an attested no-exec
        // unconfirmed means setup failed before exec — a missing bwrap or
        // payload binary — so both clean up (PR #12067 review: retaining
        // those leaked a dir pair per invocation).
        const retain =
          status.state === 'unconfirmed' &&
          receiptExisted &&
          (!receiptParsed || status.payloadExitObserved === true);
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
    const handle = await ShellExecutionService.executeLaunch(
      {
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
      },
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
          const sandboxStatus: BwrapStatus = result.promoted
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
