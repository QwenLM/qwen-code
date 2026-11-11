/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  copyFile,
  lstat,
  mkdir,
  opendir,
  readlink,
  realpath,
  stat,
  symlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { isPathContained } from '../utils/pathContainment.js';
import { closeDirHandleQuietly } from '../utils/dirHandle.js';
import { runLogger } from '../utils/runLogger.js';

export interface ContainedTreeCopyOptions {
  /**
   * Canonical trust boundary for symlink targets. Defaults to `sourceRoot`.
   * Targets inside this root but outside `sourceRoot` are materialized.
   */
  containmentRoot?: string;
}

export interface ContainedTreeCopyResult {
  rewrittenSymlinks: number;
  materializedSymlinks: number;
  skippedSymlinks: number;
}

interface CopyState {
  sourceRoot: string;
  destinationRoot: string;
  containmentRoot: string;
  result: ContainedTreeCopyResult;
}

/**
 * Copy a contained source tree without leaving the destination dependent on
 * the source tree.
 *
 * Symlink policy:
 * - target inside sourceRoot: recreate a relative link into destinationRoot
 * - target inside containmentRoot but outside sourceRoot: materialize content
 * - target outside containmentRoot, broken, cyclic, or non-regular: skip + warn
 */
export async function copyContainedTree(
  sourceRoot: string,
  destinationRoot: string,
  options: ContainedTreeCopyOptions = {},
): Promise<ContainedTreeCopyResult> {
  const canonicalSourceRoot = await realpath(resolve(sourceRoot));
  const canonicalContainmentRoot = await realpath(
    resolve(options.containmentRoot ?? sourceRoot),
  );

  if (!isPathContained(canonicalSourceRoot, canonicalContainmentRoot)) {
    throw new Error(
      `Copy source "${sourceRoot}" resolves outside containment root "${options.containmentRoot}"`,
    );
  }

  const sourceStats = await stat(canonicalSourceRoot);
  if (!sourceStats.isDirectory()) {
    throw new Error(`Copy source is not a directory: ${sourceRoot}`);
  }

  const state: CopyState = {
    sourceRoot: canonicalSourceRoot,
    destinationRoot: resolve(destinationRoot),
    containmentRoot: canonicalContainmentRoot,
    result: {
      rewrittenSymlinks: 0,
      materializedSymlinks: 0,
      skippedSymlinks: 0,
    },
  };

  await copyDirectory(
    canonicalSourceRoot,
    state.destinationRoot,
    state,
    new Set([canonicalSourceRoot]),
  );
  return state.result;
}

/** Backward-compatible plugin-specific name for the shared safe copier. */
export const copyPluginTree = copyContainedTree;

async function copyDirectory(
  sourceDir: string,
  destinationDir: string,
  state: CopyState,
  activeDirectories: Set<string>,
): Promise<void> {
  await mkdir(destinationDir, { recursive: true });
  const handle = await opendir(sourceDir);
  try {
    for await (const entry of handle) {
      await copyEntry(
        join(sourceDir, entry.name),
        join(destinationDir, entry.name),
        state,
        activeDirectories,
      );
    }
  } finally {
    await closeDirHandleQuietly(handle);
  }
}

async function copyEntry(
  sourcePath: string,
  destinationPath: string,
  state: CopyState,
  activeDirectories: Set<string>,
): Promise<void> {
  const sourceStats = await lstat(sourcePath);

  if (sourceStats.isSymbolicLink()) {
    await copySymlink(
      sourcePath,
      destinationPath,
      state,
      activeDirectories,
    );
    return;
  }

  if (sourceStats.isDirectory()) {
    const canonicalDirectory = await realpath(sourcePath);
    if (activeDirectories.has(canonicalDirectory)) {
      recordSkippedSymlink(sourcePath, 'directory cycle', state);
      return;
    }
    const nextActive = new Set(activeDirectories);
    nextActive.add(canonicalDirectory);
    await copyDirectory(
      canonicalDirectory,
      destinationPath,
      state,
      nextActive,
    );
    return;
  }

  if (sourceStats.isFile()) {
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    return;
  }

  runLogger.warn(`[TreeCopy] Skipping non-regular entry: ${sourcePath}`);
}

async function copySymlink(
  sourcePath: string,
  destinationPath: string,
  state: CopyState,
  activeDirectories: Set<string>,
): Promise<void> {
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(sourcePath);
  } catch (error) {
    const declaredTarget = await readlink(sourcePath).catch(() => 'unknown');
    recordSkippedSymlink(
      sourcePath,
      `broken target ${declaredTarget}: ${formatError(error)}`,
      state,
    );
    return;
  }

  let targetStats;
  try {
    targetStats = await stat(canonicalTarget);
  } catch (error) {
    recordSkippedSymlink(
      sourcePath,
      `cannot stat target ${canonicalTarget}: ${formatError(error)}`,
      state,
    );
    return;
  }

  if (!targetStats.isDirectory() && !targetStats.isFile()) {
    recordSkippedSymlink(
      sourcePath,
      `non-regular target ${canonicalTarget}`,
      state,
    );
    return;
  }

  if (
    targetStats.isDirectory() &&
    activeDirectories.has(canonicalTarget)
  ) {
    recordSkippedSymlink(
      sourcePath,
      `cyclic target ${canonicalTarget}`,
      state,
    );
    return;
  }

  if (!isPathContained(canonicalTarget, state.containmentRoot)) {
    recordSkippedSymlink(
      sourcePath,
      `target escapes containment root: ${canonicalTarget}`,
      state,
    );
    return;
  }

  if (isPathContained(canonicalTarget, state.sourceRoot)) {
    const targetRelativeToSource = relative(
      state.sourceRoot,
      canonicalTarget,
    );
    if (
      targetRelativeToSource === '..' ||
      targetRelativeToSource.startsWith(`..${sep}`) ||
      isAbsolute(targetRelativeToSource)
    ) {
      recordSkippedSymlink(
        sourcePath,
        `cannot map internal target ${canonicalTarget}`,
        state,
      );
      return;
    }

    const destinationTarget = join(
      state.destinationRoot,
      targetRelativeToSource,
    );
    const rewrittenTarget = relative(dirname(destinationPath), destinationTarget);
    await mkdir(dirname(destinationPath), { recursive: true });
    await symlink(
      rewrittenTarget || '.',
      destinationPath,
      targetStats.isDirectory() ? 'dir' : 'file',
    );
    state.result.rewrittenSymlinks++;
    return;
  }

  const nextActive = new Set(activeDirectories);
  if (targetStats.isDirectory()) {
    nextActive.add(canonicalTarget);
    await copyDirectory(
      canonicalTarget,
      destinationPath,
      state,
      nextActive,
    );
  } else {
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(canonicalTarget, destinationPath);
  }
  state.result.materializedSymlinks++;
}

function recordSkippedSymlink(
  sourcePath: string,
  reason: string,
  state: CopyState,
): void {
  state.result.skippedSymlinks++;
  runLogger.warn(`[TreeCopy] Skipping symlink ${sourcePath}: ${reason}`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
