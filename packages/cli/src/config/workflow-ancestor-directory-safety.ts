/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export function isWorkflowAncestorDirectorySafe(directory: string): boolean {
  // Windows mode bits do not describe its ACLs.
  if (process.platform === 'win32') return true;
  for (const location of [
    directory,
    path.join(directory, '.qwen'),
    path.join(directory, '.qwen', 'workflows'),
  ]) {
    try {
      if ((fs.statSync(location).mode & 0o002) !== 0) return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (location === directory) return false;
      if (code === 'ENOENT' || code === 'ENOTDIR') break;
      return false;
    }
  }
  return true;
}
