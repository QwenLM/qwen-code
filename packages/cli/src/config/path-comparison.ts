/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function isWithinRoot(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}

/**
 * chokidar `ignored` filter for a bootstrap watcher on `root` that waits for
 * one entry, `entryName`, to appear directly under it. chokidar passes the
 * root back in its own spelling (forward slashes on Windows, sometimes a
 * trailing separator), so the root is compared after `path.resolve`. The
 * comparison keeps case as given; chokidar keeps the case it was passed.
 */
export function bootstrapWatchFilter(
  root: string,
  entryName: string,
): (filePath: string) => boolean {
  const resolvedRoot = path.resolve(root);
  return (filePath: string) =>
    path.resolve(filePath) !== resolvedRoot &&
    path.basename(filePath) !== entryName;
}

export function getPathComparisonVariants(rawPath: string): Set<string> {
  const variants = new Set<string>([path.normalize(path.resolve(rawPath))]);
  try {
    variants.add(path.normalize(fs.realpathSync(rawPath)));
  } catch {
    // Non-existent paths still compare by their resolved lexical form.
  }
  return variants;
}

export function arePathsEquivalent(left: string, right: string): boolean {
  const rightVariants = getPathComparisonVariants(right);
  for (const leftVariant of getPathComparisonVariants(left)) {
    if (rightVariants.has(leftVariant)) {
      return true;
    }
  }
  return false;
}
