/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Case-insensitive substring match against any of the candidate strings.
 * An empty (or whitespace-only) query matches everything.
 */
export function matchesWorkspaceQuery(
  candidates: Array<string | undefined>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return candidates.some((candidate) =>
    (candidate ?? '').toLowerCase().includes(needle),
  );
}
