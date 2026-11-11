/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';
import {
  type TextBuffer,
  logicalPosToOffset,
} from '../components/shared/text-buffer.js';
import {
  useReverseSearchCompletion,
  type UseReverseSearchCompletionReturn,
} from './useReverseSearchCompletion.js';

export interface UseHistorySearchReturn {
  /** Whether the search overlay is currently open. */
  active: boolean;
  /** Snapshot of the suggestion engine for this search. */
  completion: UseReverseSearchCompletionReturn;
  /** Open the overlay; snapshots current buffer text + cursor for cancel(). */
  enter: () => void;
  /**
   * Restore the buffer to the pre-search state and close the overlay.
   * Used by Escape and the chat:escape action handler.
   */
  cancel: () => void;
  /**
   * Close the overlay without restoring text. Optionally autocomplete the
   * currently active suggestion first. Used after submit/accept.
   */
  finish: (opts?: { autocomplete?: boolean }) => void;
  /**
   * Resolve which text to submit: the active suggestion's value if one is
   * selected, otherwise the current buffer text.
   */
  resolveSubmitText: () => string;
}

/**
 * Encapsulates the lifecycle of a history-search overlay (Ctrl+R reverse
 * search in shell mode, or chat-message search in chat mode):
 *   - active flag
 *   - snapshot of the buffer text + cursor at entry, for restore-on-cancel
 *   - the underlying completion engine (suggestions / navigation / accept)
 *
 * The owning component decides which history source to feed in and when to
 * call enter()/cancel()/finish() based on its keybindings.
 */
export function useHistorySearch(
  buffer: TextBuffer,
  history: readonly string[],
): UseHistorySearchReturn {
  const [active, setActive] = useState(false);
  const [savedText, setSavedText] = useState('');
  const [savedCursor, setSavedCursor] = useState<[number, number]>([0, 0]);

  const completion = useReverseSearchCompletion(buffer, history, active);

  const enter = useCallback(() => {
    setSavedText(buffer.text);
    setSavedCursor(buffer.cursor);
    setActive(true);
  }, [buffer]);

  const cancel = useCallback(() => {
    completion.resetCompletionState();
    buffer.setText(savedText);
    const offset = logicalPosToOffset(
      buffer.lines,
      savedCursor[0],
      savedCursor[1],
    );
    buffer.moveToOffset(offset);
    setActive(false);
  }, [buffer, completion, savedText, savedCursor]);

  const finish = useCallback(
    (opts?: { autocomplete?: boolean }) => {
      if (
        opts?.autocomplete &&
        completion.showSuggestions &&
        completion.activeSuggestionIndex > -1
      ) {
        completion.handleAutocomplete(completion.activeSuggestionIndex);
      }
      completion.resetCompletionState();
      setActive(false);
    },
    [completion],
  );

  const resolveSubmitText = useCallback(() => {
    if (completion.showSuggestions && completion.activeSuggestionIndex > -1) {
      return completion.suggestions[completion.activeSuggestionIndex].value;
    }
    return buffer.text;
  }, [buffer, completion]);

  return { active, completion, enter, cancel, finish, resolveSubmitText };
}
