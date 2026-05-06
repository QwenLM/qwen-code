/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Owns the search-query state and the editing-key handler used by the
 * session picker while it's in search mode.
 *
 * Scoped intentionally narrow: this hook only knows how to mutate the
 * query (append a printable char, pop a char, clear) and how to ask
 * its parent to leave search mode. Mode transitions, navigation
 * (Enter / ↑ / ↓ / Ctrl+C), list-only shortcuts (Ctrl+B branch
 * toggle, Space-preview), and the "implicit entry" fallback that
 * seeds the query from list mode are all the parent's responsibility
 * — kept out of here so the search editor can be reasoned about as a
 * small, append-only buffer with a few escape hatches.
 *
 * Inspired by claude-code's `useSearchInput` but trimmed to qwen's
 * current feature set: no cursor movement, no kill ring, no word-wise
 * editing. Adding those later only requires extending this hook —
 * the outer picker stays untouched.
 */

import { useCallback, useState } from 'react';
import type { Key } from './useKeypress.js';

const DELETION_KEY_NAMES = new Set(['backspace', 'delete']);

/**
 * True when the key represents a single printable character that
 * should be appended to the search buffer. Excludes:
 *   - any modified key (Ctrl/Meta combos handled separately);
 *   - bracketed pastes (a multi-line paste should never silently
 *     become a search query);
 *   - control characters (sequences below 0x20 like Tab/Enter/Esc);
 *   - DEL (0x7F) — Backspace's sequence byte, otherwise it would
 *     slip past the printable check and produce a literal DEL
 *     character in the query.
 *
 * Exported because the picker's outer keypress handler reuses this
 * predicate to recognize the "implicit search entry" gesture (any
 * printable letter typed in list mode flips into search and seeds
 * the query). Sharing the definition keeps the two paths in sync.
 */
export function isPrintableSearchChar(key: Key): boolean {
  if (key.ctrl || key.meta || key.paste) return false;
  if (key.sequence.length !== 1) return false;
  const code = key.sequence.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export interface UseSessionSearchInputOptions {
  /**
   * Called when the search frame should yield back to list mode —
   * fires on Esc, Ctrl+U/Ctrl+L, and on a Backspace that empties the
   * query. The parent typically maps this to `setViewMode('list')`.
   * This hook has already cleared the query for the Esc/Ctrl+U/L
   * paths and left it empty for the Backspace path, so the parent
   * doesn't need to touch the query itself.
   */
  onExitToList: () => void;
}

export interface UseSessionSearchInputResult {
  /** Current query text. */
  searchQuery: string;
  /**
   * Imperative setter — the parent uses this for "implicit entry"
   * (typing in list mode seeds the query) without going through
   * `handleSearchKey`. Functional updaters are supported and
   * recommended whenever the new value depends on the previous one.
   */
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  /**
   * Process a key event that arrived while the picker is in search
   * mode. Always treated as the final handler for that key — the
   * search input has exclusive ownership of the keyboard while
   * focused, so anything this function doesn't recognize is
   * intentionally swallowed by the caller. (Mode-independent
   * shortcuts that need to fire in search mode — Enter, ↑/↓,
   * Ctrl+C — are routed by the parent before this delegate.)
   */
  handleSearchKey: (key: Key) => void;
}

export function useSessionSearchInput(
  options: UseSessionSearchInputOptions,
): UseSessionSearchInputResult {
  const { onExitToList } = options;
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearchKey = useCallback(
    (key: Key): void => {
      const { name, sequence, ctrl } = key;

      if (name === 'escape') {
        // Drop the query and yield to list mode in one Esc.
        // The list mode's own Esc handler then implements the
        // second-stage cancel.
        setSearchQuery('');
        onExitToList();
        return;
      }

      if (DELETION_KEY_NAMES.has(name)) {
        // Pop one char from the query. Once the query has been
        // fully erased, fall back to list mode so the shortcut
        // keymap is immediately available again — typing `/abc`
        // ⌫⌫⌫⌫ should leave the user exactly where they started,
        // not stuck in a search frame with an empty query.
        //
        // The side effect inside the updater is intentional. The
        // functional form is required for correctness under batched
        // Backspaces (each call sees the previous queued value, so
        // they don't all read the same stale closure). React 18
        // StrictMode will invoke this updater twice in dev for
        // purity checks, which means `onExitToList()` may fire
        // twice — harmless because `setViewMode('list')` is
        // idempotent. Don't refactor this back into a plain
        // `setSearchQuery(searchQuery.slice(0, -1))` without
        // re-deriving the empty-query check from the next state
        // somehow; the closure read is what's actually unsafe.
        setSearchQuery((q) => {
          const next = q.slice(0, -1);
          if (!next) onExitToList();
          return next;
        });
        return;
      }

      if (ctrl && (name === 'u' || name === 'l')) {
        // Wipe the query and exit search — same end state as
        // backspacing through every char, just one keystroke.
        setSearchQuery('');
        onExitToList();
        return;
      }

      if (isPrintableSearchChar(key)) {
        setSearchQuery((q) => q + sequence);
        return;
      }

      // Anything else (Ctrl+B, Tab, Page keys, …) is silently
      // swallowed by the caller — search owns the keyboard.
    },
    [onExitToList],
  );

  return { searchQuery, setSearchQuery, handleSearchKey };
}
