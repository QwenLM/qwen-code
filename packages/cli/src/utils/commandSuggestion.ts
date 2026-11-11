/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Optimal-string-alignment (OSA) edit distance between two strings.
 *
 * Like Levenshtein but counts a single adjacent transposition as one edit, so
 * common two-key typos (e.g. "udpate" -> "update") score 1 instead of 2. OSA
 * does not allow a substring to be edited more than once; that restriction is
 * irrelevant for short command names and keeps the implementation small.
 */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const rows = a.length;
  const cols = b.length;
  if (rows === 0) {
    return cols;
  }
  if (cols === 0) {
    return rows;
  }

  const dp: number[][] = Array.from({ length: rows + 1 }, (_, i) =>
    Array.from({ length: cols + 1 }, (__, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1, // deletion
        dp[i]![j - 1]! + 1, // insertion
        dp[i - 1]![j - 1]! + cost, // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1); // transposition
      }
    }
  }

  return dp[rows]![cols]!;
}

/**
 * Returns the candidate name (or alias) closest to `input` within
 * `maxEditDistance`, or `undefined` when nothing is close enough.
 *
 * Each candidate contributes its name plus any aliases; the exact matched
 * string that achieves the minimum distance is returned (which may be an
 * alias). Ties keep the first candidate in iteration order. A length prune
 * skips candidates that cannot possibly be within range before the (cheap, but
 * still avoidable) distance is computed.
 */
export function findClosestCommand(
  input: string,
  candidates: ReadonlyArray<{ name: string; aliases?: readonly string[] }>,
  options: { maxEditDistance?: number } = {},
): string | undefined {
  const maxEditDistance = options.maxEditDistance ?? 1;
  const names = candidates.flatMap((candidate) => [
    candidate.name,
    ...(candidate.aliases ?? []),
  ]);

  let best: string | undefined;
  let bestDistance = maxEditDistance + 1;

  for (const name of names) {
    if (Math.abs(name.length - input.length) > maxEditDistance) {
      continue;
    }
    const distance = damerauLevenshtein(input, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }

  return best;
}
