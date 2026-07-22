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
