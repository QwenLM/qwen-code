/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePath } from './resolvePath.js';

/**
 * Returns sub-directory candidates that complete a user-typed path fragment.
 *
 * The fragment may be absolute (`/foo/bar`), relative (`./foo`), or start
 * with `~` for the home directory. The function walks the resolved parent
 * directory, drops dotfiles, keeps only directories, and returns paths in
 * the same style the user typed (absolute → absolute, relative → relative).
 *
 * Shared between:
 *   - the `/add-dir` slash command (Tab completion in the prompt)
 *   - the AddWorkspaceDirectory flow inside the /permissions Trust tab
 *
 * Errors (missing parent dir, permission denied, etc.) collapse to an
 * empty list so callers never need to wrap the call.
 */
export function getDirectoryCompletions(
  partialArg: string,
  cwd: string = process.cwd(),
): string[] {
  try {
    const expanded = resolvePath(partialArg);
    const base = path.isAbsolute(expanded)
      ? expanded
      : path.join(cwd, expanded);

    const isPartialSegment = !base.endsWith(path.sep) && !fs.existsSync(base);
    const searchDir = isPartialSegment ? path.dirname(base) : base;
    const prefix = isPartialSegment ? path.basename(base) : '';

    if (!fs.existsSync(searchDir)) return [];

    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          e.name.startsWith(prefix),
      )
      .map((e) => {
        const full = path.join(searchDir, e.name);
        return path.isAbsolute(partialArg) || partialArg.startsWith('~')
          ? full
          : path.relative(cwd, full);
      });
  } catch {
    return [];
  }
}
