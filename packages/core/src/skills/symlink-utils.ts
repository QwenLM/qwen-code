/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';

type PathModule = Pick<
  typeof path,
  'isAbsolute' | 'relative' | 'resolve' | 'sep'
>;

function normalizeForPathComparison(
  filePath: string,
  pathModule: PathModule,
): string {
  const resolved = pathModule.resolve(filePath);
  return pathModule.sep === '\\' ? resolved.toLowerCase() : resolved;
}

/**
 * Checks whether a resolved symlink target stays inside the resolved base
 * directory. Both inputs should be realpaths; this helper only handles the
 * platform-aware containment check.
 */
export function isResolvedPathInsideBase(
  targetRealPath: string,
  baseRealPath: string,
  pathModule: PathModule = path,
): boolean {
  const normalizedTarget = normalizeForPathComparison(
    targetRealPath,
    pathModule,
  );
  const normalizedBase = normalizeForPathComparison(baseRealPath, pathModule);
  const relative = pathModule.relative(normalizedBase, normalizedTarget);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !pathModule.isAbsolute(relative))
  );
}
