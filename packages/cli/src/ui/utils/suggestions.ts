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

/**
 * Narrowest description a row keeps when the @-mention label column is sized:
 * the reference takes priority, but not so much that its description becomes
 * unreadable. Shared because both renderers cap the same column.
 */
export const MIN_DESCRIPTION_WIDTH = 12;

/**
 * Collapse all runs of whitespace (including newlines from multi-line
 * SKILL.md/command descriptions) into single spaces so a description renders
 * as a single logical line. Without this, frontmatter line breaks are
 * preserved verbatim and a single long description can fill the whole terminal.
 */
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}
