/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

export const DEFAULT_CONTEXT_FILENAME = 'AGENTS.md';

/**
 * Normalizes the configured context filename into the list of names to look for.
 *
 * Pure by necessity. This module used to hold the normalized result in a
 * module-level variable that `Config`'s constructor overwrote, so one process
 * hosting several sessions had a single filename shared by all of them: the last
 * session constructed decided which file every earlier session read, and a
 * session that set nothing inherited whatever the previous one left behind.
 * `Config` now owns the list; these helpers only compute it.
 *
 * A blank setting — an empty string, whitespace, or an empty array — falls back
 * to the default instead of yielding a filename that can never match a file.
 */
export function normalizeContextFilenames(
  newFilename: string | string[] | undefined,
): string[] {
  if (Array.isArray(newFilename)) {
    return newFilename.length > 0
      ? newFilename.map((name) => name.trim())
      : [DEFAULT_CONTEXT_FILENAME];
  }
  const trimmed = newFilename?.trim();
  return trimmed ? [trimmed] : [DEFAULT_CONTEXT_FILENAME];
}

/**
 * Derives `.local.md` variants from the configured context filenames.
 * E.g., `AGENTS.md` -> `AGENTS.local.md`
 */
export function deriveLocalContextFilenames(
  filenames: readonly string[],
): string[] {
  return filenames.map((filename) => {
    const ext = path.extname(filename); // .md
    const base = filename.slice(0, -ext.length); // AGENTS
    return `${base}.local${ext}`; // AGENTS.local.md
  });
}
