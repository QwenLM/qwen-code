/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

const WINDOWS_SHELL_SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1']);

/**
 * Whether a Windows path names a script wrapper that requires an interpreter.
 * Such files cannot be used as the executable in a direct `spawn()` call.
 */
export function isWindowsShellScriptWrapper(candidate: string): boolean {
  const basename = path.win32
    .basename(candidate)
    .toLowerCase()
    .replace(/[. ]+$/, '');
  return WINDOWS_SHELL_SCRIPT_EXTENSIONS.has(path.win32.extname(basename));
}
