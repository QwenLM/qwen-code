/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal line-diff utility for webview previews.
 *
 * This is a lightweight LCS-based algorithm to compute add/remove operations
 * between two texts. It intentionally avoids heavy dependencies and is
 * sufficient for rendering a compact preview inside the chat.
 */

export type DiffOp =
  | { type: 'add'; line: string; newIndex: number }
  | { type: 'remove'; line: string; oldIndex: number };

/**
 * Compute a minimal line-diff (added/removed only).
 * - Equal lines are omitted from output by design (we only preview changes).
 * - Order of operations follows the new text progression so the preview feels natural.
 */
export function computeLineDiff(
  oldText: string | null | undefined,
  newText: string | undefined,
): DiffOp[] {
  const a = (oldText || '').split('\n');
  const b = (newText || '').split('\n');

  const n = a.length;
  const m = b.length;

  // Build LCS DP table
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Walk to produce operations
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // remove a[i]
      ops.push({ type: 'remove', line: a[i], oldIndex: i });
      i++;
    } else {
      // add b[j]
      ops.push({ type: 'add', line: b[j], newIndex: j });
      j++;
    }
  }

  // Remaining tails
  while (i < n) {
    ops.push({ type: 'remove', line: a[i], oldIndex: i });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', line: b[j], newIndex: j });
    j++;
  }

  return ops;
}

/**
 * Truncate a long list of operations for preview purposes.
 * Keeps first `head` and last `tail` operations, inserting a gap marker.
 */
export function truncateOps<T>(
  ops: T[],
  head = 120,
  tail = 80,
): { items: T[]; truncated: boolean; omitted: number } {
  if (ops.length <= head + tail) {
    return { items: ops, truncated: false, omitted: 0 };
  }
  const items = [...ops.slice(0, head), ...ops.slice(-tail)];
  return { items, truncated: true, omitted: ops.length - head - tail };
}
