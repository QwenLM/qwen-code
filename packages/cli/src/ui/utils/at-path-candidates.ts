/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { unescapeShellSpecials } from '@qwen-code/qwen-code-core/utils/paths.js';

// Preserve leading Windows root prefixes (`C:\`, `\\server\`, or `\`) so
// unescaping does not strip the root separator before a folder whose name
// starts with a shell metacharacter (e.g. `C:\(v2)\file.txt`).
const WINDOWS_ROOT_PREFIX = /^([A-Za-z]:\\|\\\\[^\\]+\\|\\)(.*)$/s;

/**
 * Returns candidate paths to try when resolving an `@`-referenced path.
 *
 * On POSIX, `parseAllAtCommands` already unescapes paths via `unescapePath`,
 * so only the input path is returned.
 *
 * On Windows, `unescapePath` leaves backslashes intact so literal paths like
 * `C:\(v2)\file.txt` keep their directory separators. However, `@` autocomplete
 * and drag-and-drop still emit backslash-escaped shell characters via
 * `escapePath` (for example `my\ file.txt` or `doc\ \(1\).md`). Returning the
 * literal path first and the unescaped path second preserves real literal
 * paths while allowing escaped `@`-paths to resolve.
 */
export function getAtPathCandidates(
  pathSpec: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') {
    return [pathSpec];
  }
  const rootMatch = WINDOWS_ROOT_PREFIX.exec(pathSpec);
  const unescaped = rootMatch
    ? `${rootMatch[1]}${unescapeShellSpecials(rootMatch[2])}`
    : unescapeShellSpecials(pathSpec);
  return unescaped !== pathSpec ? [pathSpec, unescaped] : [pathSpec];
}
