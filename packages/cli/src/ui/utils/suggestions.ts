/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandKind,
  CommandSource,
  ExecutionMode,
} from '../commands/types.js';

/** Grouping category for the tabbed `@` completion UI. */
export type SuggestionCategory = 'file' | 'session' | 'mcp' | 'extension';

export interface Suggestion {
  label: string;
  value: string;
  description?: string;
  matchedIndex?: number;
  /** @deprecated Use source/sourceBadge instead. */
  commandKind?: CommandKind;
  source?: CommandSource;
  sourceLabel?: string;
  sourceBadge?: string;
  argumentHint?: string;
  matchedAlias?: string;
  supportedModes?: ExecutionMode[];
  modelInvocable?: boolean;
  /** Grouping category for the tabbed `@` completion UI. Defaults to 'file'. */
  category?: SuggestionCategory;
  /** Whether the suggestion represents a directory path. When true, handleAutocomplete should NOT append a trailing space so the user can continue tab-completing deeper into the directory tree. */
  isDirectory?: boolean;
  /**
   * When true, the input layer should submit `/<value>` immediately on
   * Enter-accept rather than just inserting the suggestion text and
   * waiting for a second Enter. Mirrors the `submitOnAccept` flag on the
   * underlying SlashCommand (see `commands/types.ts`). Used for parent
   * commands like `/skills` whose bare action just opens a dialog and
   * takes no further argument — typing `/skil<Enter>` should land in the
   * dialog in one keystroke.
   */
  submitOnAccept?: boolean;
}

export const MAX_SUGGESTIONS_TO_SHOW = 8;

export const MAX_SUGGESTION_LABEL_WIDTH = 150;

export function prepareSuggestionLabel(
  label: string,
  matchedIndex: number | undefined,
  userInput: string,
  isExpanded = false,
): { before: string; match: string; after: string } {
  const hasMatch =
    matchedIndex !== undefined &&
    matchedIndex >= 0 &&
    matchedIndex < label.length &&
    userInput.length > 0;

  // Keep Ink's UTF-16 window, independent of the terminal's wrapping width.
  if (!hasMatch) {
    return {
      before:
        !isExpanded && label.length > MAX_SUGGESTION_LABEL_WIDTH
          ? label.slice(0, MAX_SUGGESTION_LABEL_WIDTH) + '...'
          : label,
      match: '',
      after: '',
    };
  }

  const matchLength = userInput.length;
  let before = '';
  let match = '';
  let after = '';

  // Case 1: Show the full string if it's expanded or already fits
  if (isExpanded || label.length <= MAX_SUGGESTION_LABEL_WIDTH) {
    before = label.slice(0, matchedIndex);
    match = label.slice(matchedIndex, matchedIndex + matchLength);
    after = label.slice(matchedIndex + matchLength);
  }
  // Case 2: The match itself is too long, so we only show a truncated portion of the match
  else if (matchLength >= MAX_SUGGESTION_LABEL_WIDTH) {
    match =
      label.slice(matchedIndex, matchedIndex + MAX_SUGGESTION_LABEL_WIDTH - 1) +
      '...';
  }
  // Case 3: Truncate the string to create a window around the match
  else {
    const contextSpace = MAX_SUGGESTION_LABEL_WIDTH - matchLength;
    const beforeSpace = Math.floor(contextSpace / 2);
    const afterSpace = Math.ceil(contextSpace / 2);

    let start = matchedIndex - beforeSpace;
    let end = matchedIndex + matchLength + afterSpace;

    if (start < 0) {
      end += -start; // Slide window right
      start = 0;
    }
    if (end > label.length) {
      start -= end - label.length; // Slide window left
      end = label.length;
    }
    start = Math.max(0, start);

    const finalMatchIndex = matchedIndex - start;
    const slicedLabel = label.slice(start, end);

    before = slicedLabel.slice(0, finalMatchIndex);
    match = slicedLabel.slice(finalMatchIndex, finalMatchIndex + matchLength);
    after = slicedLabel.slice(finalMatchIndex + matchLength);

    if (start > 0) {
      before = before.length >= 3 ? '...' + before.slice(3) : '...';
    }
    if (end < label.length) {
      after = after.length >= 3 ? after.slice(0, -3) + '...' : '...';
    }
  }

  return { before, match, after };
}

/**
 * Collapse all runs of whitespace (including newlines from multi-line
 * SKILL.md/command descriptions) into single spaces so a description renders
 * as a single logical line. Without this, frontmatter line breaks are
 * preserved verbatim and a single long description can fill the whole terminal.
 */
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}
