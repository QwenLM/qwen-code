/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ManagedToolResultPayload } from './managed-runtime-tool-executor.js';

export const PRIVATE_ROOT_CAPABILITY_DIGEST =
  'sha256:e3b6f905a8c29c601d33a2a6204d69c307aa77bbe40e5146e3e45d8c616bf85c';
export const CONFINED_SHELL_PROFILE = 'hosted-workspace-confined-shell/1';
export const CONFINEMENT_DENIED = 'managed_runtime_confinement_denied';
export const CONFINEMENT_UNAVAILABLE =
  'managed_runtime_confinement_unavailable';

const BWRAP = '/usr/bin/bwrap';

export interface PrivateRootRecipe {
  readonly version: 1;
  readonly rootfs: string;
  readonly rootfsIdentity: string;
  readonly bwrapIdentity: string;
}

export function parsePrivateRootRecipe(value: unknown): PrivateRootRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid private-root recipe.');
  const { version, rootfs, rootfsIdentity, bwrapIdentity } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(value).sort().join(',') !==
      'bwrapIdentity,rootfs,rootfsIdentity,version' ||
    version !== 1 ||
    typeof rootfs !== 'string' ||
    rootfs.length > 4096 ||
    !path.posix.isAbsolute(rootfs) ||
    rootfs.includes('\0') ||
    typeof rootfsIdentity !== 'string' ||
    !/^\d+:\d+$/.test(rootfsIdentity) ||
    typeof bwrapIdentity !== 'string' ||
    !/^\d+:\d+$/.test(bwrapIdentity)
  )
    throw new Error('Invalid private-root recipe.');
  return Object.freeze({ version, rootfs, rootfsIdentity, bwrapIdentity });
}

export function admitsConfinedShell(
  input: Readonly<Record<string, unknown>>,
): boolean {
  return (
    Object.keys(input).every((key) =>
      ['command', 'description', 'timeout', 'is_background'].includes(key),
    ) &&
    typeof input['command'] === 'string' &&
    input['command'].trim().length > 0 &&
    !input['command'].includes('\0') &&
    (!Object.hasOwn(input, 'description') ||
      typeof input['description'] === 'string') &&
    (!Object.hasOwn(input, 'is_background') ||
      input['is_background'] === false) &&
    (!Object.hasOwn(input, 'timeout') ||
      (Number.isSafeInteger(input['timeout']) &&
        Number(input['timeout']) >= 1 &&
        Number(input['timeout']) <= 600_000))
  );
}

async function hasIdentity(file: string, identity: string): Promise<boolean> {
  if ((await realpath(file)) !== file) return false;
  const { dev, ino } = await stat(file, { bigint: true });
  return `${dev}:${ino}` === identity;
}

export async function runPrivateRootShell(
  recipe: PrivateRootRecipe,
  workspace: string,
  command: string,
  signal: AbortSignal,
): Promise<ManagedToolResultPayload | undefined> {
  const available = await Promise.all([
    hasIdentity(recipe.rootfs, recipe.rootfsIdentity),
    hasIdentity(BWRAP, recipe.bwrapIdentity),
  ]).then(
    (matched) => matched.every(Boolean),
    () => false,
  );
  if (!available)
    return {
      executionStatus: 'not_started',
      responseParts: [],
      error: {
        type: CONFINEMENT_UNAVAILABLE,
        message: 'Private-root confinement is unavailable.',
      },
    };
  try {
    const { executePrivateRootBwrap } = await import(
      '@qwen-code/qwen-code-core/sandbox/private-root-bwrap.js'
    );
    const handle = await executePrivateRootBwrap(
      {
        rootfs: recipe.rootfs,
        bwrapPath: BWRAP,
        workspace,
        installation: path.dirname(process.argv[1]!),
        state: process.cwd(),
        filesystem: 'workspace-write',
      },
      { executable: '/bin/sh', args: ['-c', command] },
      () => {},
      signal,
    );
    const result = await handle.result;
    if (result.sandboxStatus.state !== 'confirmed') return undefined;
    const { exitCode } = result.sandboxStatus;
    return {
      executionStatus: exitCode === 0 ? 'success' : 'error',
      responseParts: [{ type: 'text', text: result.output }],
      ...(exitCode === 0
        ? {}
        : { error: { message: `Shell exited with code ${exitCode}.` } }),
    };
  } catch {
    // A missing launcher result cannot establish that the payload never ran.
    return undefined;
  }
}
