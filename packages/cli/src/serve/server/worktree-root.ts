/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertWorktreeRootContainmentSync,
  InvalidWorktreeRootError,
  parseWorktreeRoot,
  type ParsedWorktreeRoot,
} from '@qwen-code/qwen-code-core/utils/worktree-root.js';
import { readSettingsSnapshot } from '../../config/settings.js';
import type { WorkspaceRuntime } from '../workspace-registry.js';

function foldsPathCase(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function normalizeForComparison(value: string): string {
  return foldsPathCase() ? value.toLowerCase() : value;
}

function isStrictlyWithinDir(candidate: string, root: string): boolean {
  const rel = path.relative(
    normalizeForComparison(root),
    normalizeForComparison(candidate),
  );
  return (
    rel.length > 0 &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

/**
 * Reads and validates `worktree.root` for a workspace without mutating disk or
 * `process.env`. Fails closed with {@link InvalidWorktreeRootError} on
 * unreadable/malformed settings or an invalid `worktree.root` value.
 */
export function readWorkspaceWorktreeRoot(
  workspaceCwd: string,
  options: {
    environment: Readonly<NodeJS.ProcessEnv>;
    workspaceTrusted: boolean;
  },
): ParsedWorktreeRoot {
  let settings: ReturnType<typeof readSettingsSnapshot>;
  try {
    settings = readSettingsSnapshot(workspaceCwd, options);
  } catch (error) {
    throw new InvalidWorktreeRootError(
      `Cannot read worktree.root settings: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const activeLayers: unknown[] = [
    settings.systemDefaults.settings,
    settings.user.settings,
    ...(options.workspaceTrusted ? [settings.workspace.settings] : []),
    settings.system.settings,
    settings.merged,
  ];
  for (const layer of activeLayers) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    const section: unknown = (layer as Record<string, unknown>)['worktree'];
    if (
      section !== undefined &&
      (section === null ||
        typeof section !== 'object' ||
        Array.isArray(section))
    ) {
      throw new InvalidWorktreeRootError('worktree settings must be an object');
    }
  }
  return parseWorktreeRoot(settings.merged.worktree?.root);
}

/**
 * Reads and validates `worktree.root` from a live {@link WorkspaceRuntime}'s
 * own environment and trust boundary (never falls back to another runtime).
 */
export function readRuntimeWorktreeRoot(
  runtime: Pick<WorkspaceRuntime, 'workspaceCwd' | 'trusted'> & {
    env?: WorkspaceRuntime['env'];
  },
): ParsedWorktreeRoot {
  const environment =
    runtime.env?.effectiveEnv ??
    (runtime.env === undefined || runtime.env.mode === 'parent-process'
      ? process.env
      : undefined);
  if (!environment) {
    throw new InvalidWorktreeRootError(
      'workspace runtime environment is unavailable',
    );
  }
  return readWorkspaceWorktreeRoot(runtime.workspaceCwd, {
    environment,
    workspaceTrusted: runtime.trusted,
  });
}

/**
 * Best-effort variant for non-worktree paths (such as plain session listing or
 * `SessionService` construction) that must not crash when `worktree.root` has
 * a typo in settings. Returns `undefined` on failure.
 */
export function tryReadRuntimeWorktreeRoot(
  runtime: Pick<WorkspaceRuntime, 'workspaceCwd' | 'env' | 'trusted'>,
): ParsedWorktreeRoot | undefined {
  try {
    return readRuntimeWorktreeRoot(runtime);
  } catch {
    return undefined;
  }
}

/**
 * Sentinel returned by {@link resolveRuntimeWorktreeRootSetting} and
 * {@link resolveWorkspaceWorktreeRootSetting} when `worktree.root` settings
 * are invalid or unreadable. Passing this into `preclassifyWorktreeCleanup` or
 * `GitWorktreeService` forces fail-closed rejection (never silently falls back
 * to `.qwen/worktrees`), while `SessionService.matchesProject` ignores invalid
 * values without breaking ordinary non-worktree listing.
 */
export const INVALID_WORKTREE_ROOT_SENTINEL = '\0invalid-worktree-root';

export function resolveRuntimeWorktreeRootSetting(
  runtime: Pick<WorkspaceRuntime, 'workspaceCwd' | 'env' | 'trusted'>,
): string {
  try {
    return readRuntimeWorktreeRoot(runtime).normalized;
  } catch {
    return INVALID_WORKTREE_ROOT_SENTINEL;
  }
}

export function resolveWorkspaceWorktreeRootSetting(
  workspaceCwd: string,
  options: {
    environment: Readonly<NodeJS.ProcessEnv>;
    workspaceTrusted: boolean;
  },
): string {
  try {
    return readWorkspaceWorktreeRoot(workspaceCwd, options).normalized;
  } catch {
    return INVALID_WORKTREE_ROOT_SENTINEL;
  }
}

/**
 * Resolves the managed worktrees directory under `baseDir` and verifies
 * containment against `baseDir` and its `.git` directory.
 */
export function resolveContainedWorktreeRoot(
  baseDir: string,
  parsedRoot: ParsedWorktreeRoot,
  gitDir?: string,
): string {
  const worktreesDir = path.join(baseDir, ...parsedRoot.segments);
  assertWorktreeRootContainmentSync(
    baseDir,
    worktreesDir,
    parsedRoot,
    gitDir ?? path.join(baseDir, '.git'),
  );
  return worktreesDir;
}

/**
 * Checks whether an existing canonical `realTarget` path lies strictly inside
 * `<baseDir>/<parsedRoot>` for at least one allowed `baseDir`, while enforcing
 * symlink/junction containment on the managed root itself.
 */
export function isWorktreePathInManagedRoots(
  realTarget: string,
  baseDirs: readonly string[],
  parsedRoot: ParsedWorktreeRoot,
): boolean {
  for (const baseDir of baseDirs) {
    const candidateRoot = path.join(baseDir, ...parsedRoot.segments);
    try {
      assertWorktreeRootContainmentSync(
        baseDir,
        candidateRoot,
        parsedRoot,
        path.join(baseDir, '.git'),
      );
      const realRoot = fs.realpathSync(candidateRoot);
      if (isStrictlyWithinDir(realTarget, realRoot)) {
        return true;
      }
    } catch {
      // Missing root or unsafe symlink/junction containment — do not admit.
    }
  }
  return false;
}
