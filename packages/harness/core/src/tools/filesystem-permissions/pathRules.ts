/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { posix } from 'node:path';
import { getPlatform } from '../../utils/platform.js';
import { windowsPathToPosixPath } from '../../utils/windowsPathConvert.js';

/** Use the same path representation when generating and matching rules. */
export function toPosixPath(filePath: string): string {
  return getPlatform() === 'windows'
    ? windowsPathToPosixPath(filePath)
    : filePath;
}

/**
 * Build a directory rule using the permission DSL's absolute-path prefix.
 * `/repo/docs` becomes `//repo/docs/**`; `C:\\docs` becomes `//c/docs/**`.
 * Keep leading separators intact so network paths retain their shape.
 */
export function directoryPermissionPattern(dirPath: string): string {
  const normalizedPath = toPosixPath(dirPath);
  const pathForPattern = normalizedPath.replace(/\/+$/, '') || normalizedPath;
  return posix.isAbsolute(pathForPattern)
    ? `/${pathForPattern}/**`
    : `${pathForPattern}/**`;
}
