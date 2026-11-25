/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Path detection helpers extracted from filesystem.ts to
 * avoid circular dependencies between filesystem.ts and internalPaths.ts.
 *
 * These functions detect auto-memory paths (user-scope and project-scope)
 * for permission exemption purposes.
 */

import { posix } from 'node:path';
import type { InternalPathContext } from './internal-path-deps.js';
import { getPlatform } from '../../utils/platform.js';
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js';

// ============================================================================
// Local path helpers (duplicated from filesystem.ts to avoid circular dep)
// ============================================================================

function toPosixPath(filePath: string): string {
  if (getPlatform() === 'windows') {
    return windowsPathToPosixPath(filePath);
  }
  return filePath;
}

function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase();
}

function isUnderPosixDir(filePath: string, dirPath: string): boolean {
  const normalizedFile = normalizeCaseForComparison(
    toPosixPath(filePath).replace(/\/+$/, ''),
  );
  const normalizedDir = normalizeCaseForComparison(
    toPosixPath(dirPath).replace(/\/+$/, ''),
  );
  return (
    normalizedFile === normalizedDir ||
    normalizedFile.startsWith(`${normalizedDir}/`)
  );
}

// ============================================================================
// Auto-memory path detection
// ============================================================================

function isProjectAutoMemoryPath(segments: readonly string[], index: number) {
  return (
    segments[index + 1]?.toLowerCase() === 'projects' &&
    segments[index + 3]?.toLowerCase() === 'memory'
  );
}

/**
 * Checks if a path is an auto-memory path (user-scope or project-scope).
 * Used by both the permission pipeline (for exemption) and the dangerous-file
 * detector (to exclude auto-memory from dangerous path checks).
 */
export function isAutoMemoryPath(
  posixPath: string,
  ctx: InternalPathContext = {},
): boolean {
  if (
    (ctx.autoMemoryDirs ?? []).some((dir) => isUnderPosixDir(posixPath, dir))
  ) {
    return true;
  }

  const segments = posixPath.split('/').filter(Boolean);
  return segments.some(
    (segment, index) =>
      !!ctx.projectConfigDir &&
      segment.toLowerCase() ===
        posix.basename(toPosixPath(ctx.projectConfigDir)).toLowerCase() &&
      isProjectAutoMemoryPath(segments, index),
  );
}
