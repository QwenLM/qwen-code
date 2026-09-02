/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs';
import { lstat, mkdtemp } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

export type WorkspaceRuntimeProvenance = 'existing' | 'managed-scratch';

/** Filesystem identity captured when the daemon accepts its private root. */
export interface ManagedScratchRoot {
  readonly canonicalRoot: string;
  readonly device: number;
  readonly inode: number;
}

/** Compares already-canonical paths using the host platform's case rules. */
const isSamePath = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;

/** Tests strict path containment without relying on string prefixes. */
const isWithinRoot = (candidate: string, root: string): boolean => {
  const rel = relative(root, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Returns whether a canonical path is a daemon-shaped direct scratch child. */
export function isManagedScratchChild(
  canonicalCwd: string,
  canonicalRoot: string,
): boolean {
  return (
    isSamePath(dirname(canonicalCwd), canonicalRoot) &&
    /^scratch-.+/.test(basename(canonicalCwd))
  );
}

/**
 * Protects the scratch root from workspace nesting while allowing retained
 * `scratch-*` children to be registered again as ordinary workspaces.
 */
export function isScratchRootCompatible(
  canonicalCwd: string,
  canonicalRoot: string,
): boolean {
  if (isSamePath(canonicalCwd, canonicalRoot)) return false;
  if (isManagedScratchChild(canonicalCwd, canonicalRoot)) return true;
  return (
    !isWithinRoot(canonicalCwd, canonicalRoot) &&
    !isWithinRoot(canonicalRoot, canonicalCwd)
  );
}

/** Rejects roots that another user or a path substitution could control. */
function validateRootStats(stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Managed scratch root must be a non-symlink directory');
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stats.uid !== process.getuid()
  ) {
    throw new Error('Managed scratch root must be owned by the daemon user');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(
      'Managed scratch root must be accessible only to its owner',
    );
  }
}

/**
 * Creates and accepts the daemon's scratch root, recording its identity so
 * later requests can fail closed if the path is replaced.
 */
export function prepareManagedScratchRoot(
  root: string,
  startupWorkspaceCwds: readonly string[],
): ManagedScratchRoot {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const before = lstatSync(root);
  validateRootStats(before);
  const canonicalRoot = realpathSync.native(resolve(root));
  const after = lstatSync(canonicalRoot);
  validateRootStats(after);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Managed scratch root identity changed during validation');
  }
  if (
    startupWorkspaceCwds.some(
      (cwd) => !isScratchRootCompatible(cwd, canonicalRoot),
    )
  ) {
    throw new Error('Managed scratch root conflicts with a startup workspace');
  }
  return {
    canonicalRoot,
    device: after.dev,
    inode: after.ino,
  };
}

/** Verifies that the accepted path still names the original private root. */
async function revalidateManagedScratchRoot(
  root: ManagedScratchRoot,
): Promise<void> {
  const stats = await lstat(root.canonicalRoot);
  validateRootStats(stats);
  if (stats.dev !== root.device || stats.ino !== root.inode) {
    throw new Error('Managed scratch root identity changed');
  }
  const canonical = realpathSync.native(root.canonicalRoot);
  if (!isSamePath(canonical, root.canonicalRoot)) {
    throw new Error('Managed scratch root canonical path changed');
  }
}

/** Atomically creates one private, canonical direct child of the accepted root. */
export async function createManagedScratchDirectory(
  root: ManagedScratchRoot,
): Promise<string> {
  await revalidateManagedScratchRoot(root);
  const created = await mkdtemp(join(root.canonicalRoot, 'scratch-'));
  const canonical = realpathSync.native(created);
  if (!isManagedScratchChild(canonical, root.canonicalRoot)) {
    throw new Error('Managed scratch directory escaped its accepted root');
  }
  await revalidateManagedScratchRoot(root);
  return canonical;
}
