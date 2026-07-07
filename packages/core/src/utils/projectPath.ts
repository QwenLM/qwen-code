/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fsPromises from 'node:fs/promises';

/**
 * Compute a project-relative, forward-slash-normalized path for matching
 * against `paths:` globs in conditional rules and conditional skills, or
 * `null` if the input falls outside the project root.
 *
 * Pure (no I/O), and parameterized over a `path` module so unit tests
 * can pin the Windows-specific `path.win32` cross-drive case (where
 * `path.relative('C:\\proj', 'D:\\elsewhere')` returns an absolute
 * string that, after normalizing backslashes, would otherwise
 * false-match a broad glob like `**\/*.ts`).
 *
 * Shared by `ConditionalRulesRegistry` and `SkillActivationRegistry`
 * so the two registries cannot drift on path validation.
 */
export function resolveProjectRelativePath(
  filePath: string,
  projectRoot: string,
  pathModule: typeof path = path,
): string | null {
  const absolutePath = pathModule.isAbsolute(filePath)
    ? filePath
    : pathModule.resolve(projectRoot, filePath);
  const rawRelativePath = pathModule.relative(projectRoot, absolutePath);
  if (
    rawRelativePath === '..' ||
    rawRelativePath.startsWith(`..${pathModule.sep}`) ||
    rawRelativePath.startsWith('../') ||
    pathModule.isAbsolute(rawRelativePath)
  ) {
    return null;
  }
  return rawRelativePath.replace(/\\/g, '/');
}

/**
 * Resolve project-relative paths with symlink awareness.
 *
 * When a file is accessed via a symlinked path (e.g., in a git worktree or
 * monorepo with symlinked directories), this function returns both the
 * original relative path and the realpath-resolved relative path, so that
 * glob patterns like `src/ **\/*.ts` can match either form.
 *
 * Falls back gracefully if `realpath` fails (e.g., ENOENT for non-existent
 * files or permission errors).
 *
 * @param filePath - Absolute or relative path to the file being accessed.
 * @param projectRoot - Absolute path to the project root.
 * @param realpath - Async realpath function (defaults to `fsPromises.realpath`).
 * @param pathModule - Path module (defaults to `path`, parameterized for testing).
 * @returns Array of unique project-relative paths (1 or 2 elements).
 */
export async function resolveSymlinkAwareRelativePaths(
  filePath: string,
  projectRoot: string,
  realpath: (path: string) => Promise<string> = fsPromises.realpath,
  pathModule: typeof path = path,
): Promise<string[]> {
  const originalRelative = resolveProjectRelativePath(
    filePath,
    projectRoot,
    pathModule,
  );

  // If original path is outside project root, return empty
  if (originalRelative === null) {
    return [];
  }

  const results = [originalRelative];

  // Try to resolve symlinks
  try {
    const absolutePath = pathModule.isAbsolute(filePath)
      ? filePath
      : pathModule.resolve(projectRoot, filePath);
    const realFilePath = await realpath(absolutePath);

    if (realFilePath !== absolutePath) {
      // Resolve projectRoot too — on macOS, os.tmpdir() returns /tmp/...
      // but realpath resolves it to /private/tmp/..., so both sides must
      // use the same canonical prefix for path.relative to work.
      const realProjectRoot = await realpath(projectRoot);
      const realRelative = resolveProjectRelativePath(
        realFilePath,
        realProjectRoot,
        pathModule,
      );
      if (realRelative !== null && realRelative !== originalRelative) {
        results.push(realRelative);
      }
    }
  } catch {
    // realpath failed (ENOENT, permission error, etc.) — use original only
  }

  return results;
}
