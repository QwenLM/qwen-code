/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Keys are stored normalized so the same project resolves consistently. On
 * Windows, paths are case-insensitive but the entry points that produce a
 * project root disagree on casing: the CLI keeps `process.cwd()` as typed
 * (`D:\project`) while IDE integrations hand over VS Code's
 * `workspaceFolders[0].uri.fsPath`, which lowercases the drive letter
 * (`d:\project`). Fold case on win32 — same convention as
 * `getProjectHash()`/`sanitizeCwd()`. See issue #9775.
 */
export function normalizeProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return os.platform() === 'win32' ? resolved.toLowerCase() : resolved;
}
