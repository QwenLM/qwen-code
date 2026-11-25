/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitArgs } from './gitCommandPolicy.js';
import { execFileNoThrow } from './execFileNoThrow.js';
import { createGitCommandEnv } from './gitUtils.js';

/**
 * Checks whether a given path is ignored by git (via .gitignore rules).
 * Uses `git check-ignore` which returns exit code 0 when the path is ignored.
 *
 * @param filePath - The path to check.
 * @param cwd - The working directory for git (typically the repo root).
 * @returns true if the path is gitignored, false otherwise.
 */
export async function isPathGitignored(
  filePath: string,
  cwd: string,
): Promise<boolean> {
  const result = await execFileNoThrow(
    'git',
    [...internalGitArgs(), '-C', cwd, 'check-ignore', filePath],
    {
      env: createGitCommandEnv(),
      timeout: 5_000,
    },
  );
  return result.code === 0;
}
