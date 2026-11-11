/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAbsolute, join } from 'node:path';
import { resolveAbsoluteGlobPattern } from './searchPaths.js';
import { ripGrep } from './ripgrep.js';
import { lstat } from 'node:fs/promises';
import { decodeSearchPaths } from './searchOutput.js';
import {
  ENV_CLI_GLOB_NO_IGNORE,
  ENV_CLI_GLOB_HIDDEN,
} from '../config/brand.js';

export { extractGlobBaseDirectory } from './searchPaths.js';

/**
 * Checks if an environment variable string is truthy.
 */
function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
}

/**
 * Glob file search using ripgrep's --files mode.
 */
export async function glob(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
  ignorePatterns: string[] = [],
  denyFilter?: (absolutePath: string) => boolean,
): Promise<{
  files: string[];
  truncated: boolean;
  totalMatches: number;
  countIsComplete: boolean;
}> {
  let searchDir = cwd;
  let searchPattern = filePattern;

  // Use the same normalized absolute root as the permission checker.
  const absolutePattern = resolveAbsoluteGlobPattern(filePattern, cwd);
  if (absolutePattern) {
    searchDir = absolutePattern.searchDir;
    searchPattern = absolutePattern.relativePattern;
  } else {
    searchPattern = await normalizeGlobPrefix(filePattern, searchDir);
  }

  // Use ripgrep for better memory performance
  // --files: list files instead of searching content
  // --glob: filter by pattern
  // --sort=modified: sort by modification time (oldest first)
  // --no-ignore: don't respect .gitignore (default true)
  // --hidden: include hidden files (default true)
  const noIgnore = isEnvTruthy(process.env[ENV_CLI_GLOB_NO_IGNORE] || 'true');
  const hidden = isEnvTruthy(process.env[ENV_CLI_GLOB_HIDDEN] || 'true');
  const args = [
    '--files',
    '--null',
    '--glob',
    searchPattern,
    '--sort=modified',
    ...(noIgnore ? ['--no-ignore'] : []),
    ...(hidden ? ['--hidden'] : []),
  ];

  // Add ignore patterns
  for (const pattern of ignorePatterns) {
    args.push('--glob', `!${pattern}`);
  }

  let countIsComplete = true;
  const allPaths = decodeSearchPaths(
    await ripGrep(args, '.', abortSignal, {
      cwd: searchDir,
      onPartialResults: () => {
        countIsComplete = false;
      },
      outputDelimiter: '\0',
      rejectOnInputError: true,
    }),
  );

  // ripgrep returns relative paths, convert to absolute
  const absolutePaths = allPaths.map((p: string) =>
    isAbsolute(p) ? p : join(searchDir, p),
  );

  // WHY before the slice: a filtered-out file must not consume the
  // offset/limit quota, otherwise excluded entries would shrink the visible
  // page (e.g. a deny-filtered directory returning fewer files than limit).
  // denyFilter returns true for paths to EXCLUDE.
  const visiblePaths = denyFilter
    ? absolutePaths.filter((p) => !denyFilter(p))
    : absolutePaths;

  const truncated = !countIsComplete || visiblePaths.length > offset + limit;
  const files = visiblePaths.slice(offset, offset + limit);

  return {
    files,
    truncated,
    totalMatches: visiblePaths.length,
    countIsComplete,
  };
}

/** Recover a duplicated directory prefix only if it isn't a real subdirectory. */
async function normalizeGlobPrefix(
  pattern: string,
  cwd: string,
): Promise<string> {
  const parts = pattern.split('/');
  let count = 0;
  while (
    count < parts.length - 1 &&
    parts[count] !== '' &&
    !/[*?[\]{}!]/.test(parts[count])
  )
    count++;
  const dirs = cwd.split(/[\\/]+/).filter(Boolean);
  for (let length = count; length > 0; length--) {
    const prefix = parts.slice(0, length);
    const tail = dirs.slice(-length);
    if (
      tail.length !== length ||
      !prefix.every((part, index) => part === tail[index])
    )
      continue;
    let nested = cwd;
    let exists = true;
    for (const part of prefix) {
      nested = join(nested, part);
      try {
        const stat = await lstat(nested);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          exists = false;
          break;
        }
      } catch {
        exists = false;
        break;
      }
    }
    return exists ? pattern : '/' + parts.slice(length).join('/');
  }
  return pattern;
}
