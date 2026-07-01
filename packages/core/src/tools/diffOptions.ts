/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Diff from 'diff';
import type { DiffStat } from './tools.js';

export const DEFAULT_DIFF_OPTIONS: Diff.PatchOptions = {
  context: 3,
  ignoreWhitespace: true,
};

/**
 * Returns true when the unified diff patch string contains at least one hunk.
 */
export function hasHunks(patch: string): boolean {
  return patch.includes('\n@@ ');
}

/**
 * Creates a unified diff patch with smart whitespace handling.
 *
 * Uses ignoreWhitespace:true first to produce clean diffs when content and
 * whitespace change together. Falls back to ignoreWhitespace:false when no
 * hunks are found, so that whitespace-only edits (e.g. re-indentation) still
 * produce a visible diff instead of "No changes detected".
 */
export function createPatchSmart(
  filename: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
): string {
  const cleanPatch = Diff.createPatch(
    filename,
    oldStr,
    newStr,
    oldHeader,
    newHeader,
    DEFAULT_DIFF_OPTIONS,
  );

  if (hasHunks(cleanPatch)) {
    return cleanPatch;
  }

  return Diff.createPatch(filename, oldStr, newStr, oldHeader, newHeader, {
    ...DEFAULT_DIFF_OPTIONS,
    ignoreWhitespace: false,
  });
}

function structuredPatchSmart(
  filename: string,
  oldStr: string,
  newStr: string,
  oldHeader?: string,
  newHeader?: string,
): Diff.ParsedDiff {
  const result = Diff.structuredPatch(
    filename,
    filename,
    oldStr,
    newStr,
    oldHeader,
    newHeader,
    DEFAULT_DIFF_OPTIONS,
  );

  if (result.hunks.length > 0) {
    return result;
  }

  return Diff.structuredPatch(
    filename,
    filename,
    oldStr,
    newStr,
    oldHeader,
    newHeader,
    {
      ...DEFAULT_DIFF_OPTIONS,
      ignoreWhitespace: false,
    },
  );
}

export function getDiffStat(
  fileName: string,
  oldStr: string,
  aiStr: string,
  userStr: string,
): DiffStat {
  const getStats = (patch: Diff.ParsedDiff) => {
    let addedLines = 0;
    let removedLines = 0;
    let addedChars = 0;
    let removedChars = 0;

    patch.hunks.forEach((hunk: Diff.Hunk) => {
      hunk.lines.forEach((line: string) => {
        if (line.startsWith('+')) {
          addedLines++;
          addedChars += line.length - 1;
        } else if (line.startsWith('-')) {
          removedLines++;
          removedChars += line.length - 1;
        }
      });
    });
    return { addedLines, removedLines, addedChars, removedChars };
  };

  const modelPatch = structuredPatchSmart(
    fileName,
    oldStr,
    aiStr,
    'Current',
    'Proposed',
  );
  const modelStats = getStats(modelPatch);

  const userStats =
    aiStr === userStr
      ? {
          addedLines: 0,
          removedLines: 0,
          addedChars: 0,
          removedChars: 0,
        }
      : getStats(
          structuredPatchSmart(
            fileName,
            aiStr,
            userStr,
            'Proposed',
            'User',
          ),
        );

  return {
    model_added_lines: modelStats.addedLines,
    model_removed_lines: modelStats.removedLines,
    model_added_chars: modelStats.addedChars,
    model_removed_chars: modelStats.removedChars,
    user_added_lines: userStats.addedLines,
    user_removed_lines: userStats.removedLines,
    user_added_chars: userStats.addedChars,
    user_removed_chars: userStats.removedChars,
  };
}
