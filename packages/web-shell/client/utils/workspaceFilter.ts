/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Case-insensitive substring match against any of the candidate strings.
 * An empty (or whitespace-only) query matches everything.
 *
 * Both sides are NFKC-normalized first: macOS filesystems hand back
 * decomposed (NFD) names, while browser text inputs yield composed (NFC)
 * form, and `includes` would miss the same name spelled differently. NFKC is
 * this package's established matching contract (BranchPickerPopover).
 */
export function matchesWorkspaceQuery(
  candidates: Array<string | undefined>,
  query: string,
): boolean {
  const needle = query.trim().normalize('NFKC').toLowerCase();
  if (!needle) {
    return true;
  }
  return candidates.some((candidate) =>
    (candidate ?? '').normalize('NFKC').toLowerCase().includes(needle),
  );
}
