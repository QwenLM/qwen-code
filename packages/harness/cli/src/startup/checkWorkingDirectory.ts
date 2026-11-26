/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { writeSync } from 'node:fs';

/** Report cwd failures before configuration, Core, or stdio initialization. */
export function checkWorkingDirectory(): boolean {
  try {
    process.cwd();
    return true;
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : undefined;
    const macHint =
      process.platform === 'darwin' && (code === 'EPERM' || code === 'EACCES')
        ? "On macOS, check your terminal app's access in System Settings > Privacy & Security > Files & Folders.\n"
        : '';
    // Core and even lazy stdio initialization can require a usable cwd. Write
    // directly to fd 2 before loading either, including the fatal-error path.
    writeSync(
      2,
      `Error: Cannot access the current working directory${code ? ` (${code})` : ''}.\n` +
        'Check directory permissions, or change to an existing, accessible directory and try again.\n' +
        macHint,
    );
    process.exitCode = 1;
    return false;
  }
}
