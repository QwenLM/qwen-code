/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

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
