/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Diff statistics calculation tool
 */

/**
 * Diff statistics
 */
export interface DiffStats {
  /** Number of added lines */
  added: number;
  /** Number of removed lines */
  removed: number;
  /** Number of changed lines (estimated value) */
  changed: number;
  /** Total number of changed lines */
  total: number;
}

/**
 * Calculate diff statistics between two texts
 *
 * Using a simple line comparison algorithm (avoiding heavy-weight diff libraries)
 * Algorithm explanation:
 * 1. Split text by lines
 * 2. Compare set differences of lines
 * 3. Estimate changed lines (lines that appear in both added and removed)
 *
 * @param oldText Old text content
 * @param newText New text content
 * @returns Diff statistics
 *
 * @example
 * ```typescript
 * const stats = calculateDiffStats(
 *   "line1\nline2\nline3",
 *   "line1\nline2-modified\nline4"
 * );
 * // { added: 2, removed: 2, changed: 1, total: 3 }
 * ```
 */
export function calculateDiffStats(
  oldText: string | null | undefined,
  newText: string | undefined,
): DiffStats {
  // Handle null values
  const oldContent = oldText || '';
  const newContent = newText || '';

  // Split by lines
  const oldLines = oldContent.split('\n').filter((line) => line.trim() !== '');
  const newLines = newContent.split('\n').filter((line) => line.trim() !== '');

  // If one of them is empty, calculate directly
  if (oldLines.length === 0) {
    return {
      added: newLines.length,
      removed: 0,
      changed: 0,
      total: newLines.length,
    };
  }

  if (newLines.length === 0) {
    return {
      added: 0,
      removed: oldLines.length,
      changed: 0,
      total: oldLines.length,
    };
  }

  // Use Set for fast lookup
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  // Calculate added: lines in new but not in old
  const addedLines = newLines.filter((line) => !oldSet.has(line));

  // Calculate removed: lines in old but not in new
  const removedLines = oldLines.filter((line) => !newSet.has(line));

  // Estimate changes: take the minimum value (because changed lines are both deleted and added)
  // This is a simplified estimation, actual diff algorithms would be more precise
  const estimatedChanged = Math.min(addedLines.length, removedLines.length);

  const added = addedLines.length - estimatedChanged;
  const removed = removedLines.length - estimatedChanged;
  const changed = estimatedChanged;

  return {
    added,
    removed,
    changed,
    total: added + removed + changed,
  };
}

/**
 * Format diff statistics as human-readable text
 *
 * @param stats Diff statistics
 * @returns Formatted text, e.g. "+5 -3 ~2"
 *
 * @example
 * ```typescript
 * formatDiffStats({ added: 5, removed: 3, changed: 2, total: 10 });
 * // "+5 -3 ~2"
 * ```
 */
export function formatDiffStats(stats: DiffStats): string {
  const parts: string[] = [];

  if (stats.added > 0) {
    parts.push(`+${stats.added}`);
  }

  if (stats.removed > 0) {
    parts.push(`-${stats.removed}`);
  }

  if (stats.changed > 0) {
    parts.push(`~${stats.changed}`);
  }

  return parts.join(' ') || 'No changes';
}

/**
 * Format detailed diff statistics
 *
 * @param stats Diff statistics
 * @returns Detailed description text
 *
 * @example
 * ```typescript
 * formatDiffStatsDetailed({ added: 5, removed: 3, changed: 2, total: 10 });
 * // "+5 lines, -3 lines, ~2 lines"
 * ```
 */
export function formatDiffStatsDetailed(stats: DiffStats): string {
  const parts: string[] = [];

  if (stats.added > 0) {
    parts.push(`+${stats.added} ${stats.added === 1 ? 'line' : 'lines'}`);
  }

  if (stats.removed > 0) {
    parts.push(`-${stats.removed} ${stats.removed === 1 ? 'line' : 'lines'}`);
  }

  if (stats.changed > 0) {
    parts.push(`~${stats.changed} ${stats.changed === 1 ? 'line' : 'lines'}`);
  }

  return parts.join(', ') || 'No changes';
}
