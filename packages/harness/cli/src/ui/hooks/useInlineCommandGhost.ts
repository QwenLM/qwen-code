/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useState } from 'react';
import type { SlashCommand } from '../commands/types.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { logicalPosToOffset } from '../components/shared/text-buffer.js';
import { cpLen, cpSlice } from '../utils/textUtils.js';
import {
  findBestCommandGhostMatch,
  findMidInputSlashQuery,
  type CommandGhostMatch,
} from '../utils/inlineCommandGhost.js';
import type { PromptCompletion } from './usePromptCompletion.js';

export interface UseInlineCommandGhostOptions {
  enabled: boolean;
  buffer: TextBuffer;
  slashCommands: readonly SlashCommand[];
}

interface GhostToken {
  /** The partial command name typed after the `/`. */
  query: string;
  match: CommandGhostMatch;
  /** Column of the `/` on the cursor's logical line. */
  slashCol: number;
}

/**
 * Inline ghost-text completion for a mid-input slash command.
 *
 * Typing `hello /extra` offers `ct-approach` as dim text after the cursor,
 * completing `/extract-approach`. The line-start `/` case is untouched — it
 * keeps the dropdown.
 *
 * The result is shaped as a {@link PromptCompletion} so it can ride the ghost
 * pipeline InputPrompt already has: dim rendering, Tab to accept, Esc to
 * dismiss, and mutual exclusion with the other input affordances.
 *
 * @returns A prompt completion to override with, or null to leave the default.
 */
export function useInlineCommandGhost({
  enabled,
  buffer,
  slashCommands,
}: UseInlineCommandGhostOptions): PromptCompletion | null {
  const [cursorRow, cursorCol] = buffer.cursor;
  const bufferLines = buffer.lines;
  const bufferText = buffer.text;
  const replaceRangeByOffset = buffer.replaceRangeByOffset;

  // Resolved synchronously — an async source would make the ghost appear a
  // frame late and flicker while typing.
  const token = useMemo((): GhostToken | null => {
    if (!enabled) {
      return null;
    }

    const line = bufferLines[cursorRow] ?? '';
    // The ghost is drawn at the end of the cursor's visual line, so anything
    // after the cursor on that line would push it to the wrong place.
    if (cursorCol !== cpLen(line)) {
      return null;
    }

    const textBeforeCursor = cpSlice(line, 0, cursorCol);
    const query = findMidInputSlashQuery(
      cursorRow > 0 ? `\n${textBeforeCursor}` : textBeforeCursor,
    );
    if (query === null) {
      return null;
    }

    const match = findBestCommandGhostMatch(slashCommands, query);
    if (!match) {
      return null;
    }

    // Command names are ASCII, so the typed length equals its code-point
    // count, and the token is anchored at the cursor.
    return { query, match, slashCol: cursorCol - query.length - 1 };
  }, [enabled, bufferLines, cursorRow, cursorCol, slashCommands]);

  // The query that was dismissed with Esc, if any. State rather than a ref
  // because dismissing has to re-render — the Esc handler's other work
  // (resetEscapeState) bails out when the escape count is already 0.
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const currentQuery = token?.query ?? null;

  // Release the dismissal once the token changes, so a dismissed suggestion
  // comes back if the user deletes a character and retypes it.
  useEffect(() => {
    if (dismissedQuery !== null && dismissedQuery !== currentQuery) {
      setDismissedQuery(null);
    }
  }, [dismissedQuery, currentQuery]);

  return useMemo(() => {
    if (!token || token.query === dismissedQuery) {
      return null;
    }

    const { query, match, slashCol } = token;

    return {
      // InputPrompt's ghost renderer requires the buffer text as a prefix and
      // draws `text.slice(buffer.text.length)` at the cursor. This is a suffix
      // carrier, not a claim about where the text ends up — `accept` below
      // owns the actual edit.
      text: bufferText + match.suffix,
      isLoading: false,
      isActive: true,
      accept: () => {
        replaceRangeByOffset(
          logicalPosToOffset(bufferLines, cursorRow, slashCol),
          logicalPosToOffset(bufferLines, cursorRow, cursorCol),
          // A trailing space only when the match was unambiguous. Appending one
          // to a common prefix would claim the token is finished and force the
          // user to delete it before typing the rest of the name.
          `/${match.token}${match.isUniqueMatch ? ' ' : ''}`,
        );
      },
      clear: () => {
        setDismissedQuery(query);
      },
      markSelected: () => {},
    };
  }, [
    token,
    dismissedQuery,
    bufferText,
    bufferLines,
    cursorRow,
    cursorCol,
    replaceRangeByOffset,
  ]);
}
