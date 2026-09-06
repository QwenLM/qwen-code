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
