/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

export function shouldResolveAgainstWorkspace(filePath: string): boolean {
  return !path.posix.isAbsolute(filePath) && !path.win32.isAbsolute(filePath);
}
