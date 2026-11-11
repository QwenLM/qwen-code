/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { expandPath } from './paths.js';
import { getPlatform } from './platform.js';
import { isFsTouchUnsafePath } from './pathShape.js';

/** Shared by execution and permission checks; rule roots remain project-based. */
export function resolveSearchRoot(
  searchPath: string | undefined,
  cwd: string,
  globPattern?: string,
): string {
  const absolutePattern = globPattern
    ? resolveAbsoluteGlobPattern(globPattern, cwd)
    : null;
  return (
    absolutePattern?.searchDir ?? resolveSearchPath(searchPath ?? '.', cwd)
  );
}

/** Normalize absolute globs identically for permission checks and execution. */
export function resolveAbsoluteGlobPattern(
  pattern: string,
  cwd: string,
): { searchDir: string; relativePattern: string } | null {
  if (!path.isAbsolute(pattern)) return null;
  const { baseDir, relativePattern } = extractGlobBaseDirectory(pattern);
  if (!baseDir) return null;
  return { searchDir: resolveSearchPath(baseDir, cwd), relativePattern };
}

function resolveSearchPath(searchPath: string, cwd: string): string {
  const root = searchPath.trim();
  // Preserve UNC/device spelling so permission checks can reject the raw shape.
  // Normalizing //host/share first would turn it into a local /host/share path.
  if (isFsTouchUnsafePath(root)) return root;
  if (
    isFsTouchUnsafePath(cwd) &&
    !path.isAbsolute(root) &&
    !/^~(?:[/\\]|$)/.test(root)
  ) {
    return `${cwd}${path.sep}${root || '.'}`;
  }
  return expandPath(root, cwd);
}

/**
 * Extracts the static base directory from a glob pattern.
 * The base directory is everything before the first glob special character (* ? [ {).
 * Returns the directory portion and the remaining relative pattern.
 */
export function extractGlobBaseDirectory(pattern: string): {
  baseDir: string;
  relativePattern: string;
} {
  // Find the first glob special character: *, ?, [, {
  const globChars = /[*?[{]/;
  const match = pattern.match(globChars);

  if (!match || match.index === undefined) {
    // No glob characters - this is a literal path
    // Return the directory portion and filename as pattern
    const dir = path.dirname(pattern);
    const file = path.basename(pattern);
    return { baseDir: dir, relativePattern: file };
  }

  // Get everything before the first glob character
  const staticPrefix = pattern.slice(0, match.index);

  // Find the last path separator in the static prefix
  const lastSepIndex = Math.max(
    staticPrefix.lastIndexOf('/'),
    staticPrefix.lastIndexOf(path.sep),
  );

  if (lastSepIndex === -1) {
    // No path separator before the glob - pattern is relative to cwd
    return { baseDir: '', relativePattern: pattern };
  }

  let baseDir = staticPrefix.slice(0, lastSepIndex);
  const relativePattern = pattern.slice(lastSepIndex + 1);

  // Handle root directory patterns (e.g., /*.txt on Unix or C:/*.txt on Windows)
  if (baseDir === '' && lastSepIndex === 0) {
    baseDir = '/';
  }

  // Handle Windows drive root paths (e.g., C:/*.txt)
  // 'C:' means "current directory on drive C" (relative), not root
  // We need 'C:/' or 'C:\' for the actual drive root
  if (getPlatform() === 'windows' && /^[A-Za-z]:$/.test(baseDir)) {
    baseDir = baseDir + path.sep;
  }

  return { baseDir, relativePattern };
}
