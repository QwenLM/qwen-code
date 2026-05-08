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

import { useCallback, useEffect, useRef, useState } from 'react';
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
   * fires after a non-empty → empty query transition (Esc, Ctrl+U/L,
   * or the last Backspace), via a `useEffect` so the side effect
   * lives outside the React state updater. The parent typically
   * maps this to `setViewMode('list')`. The query is already empty
   * by the time this fires, so the parent doesn't need to touch it.
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

  const handleSearchKey = useCallback((key: Key): void => {
    const { name, sequence, ctrl } = key;

    if (name === 'escape') {
      // Drop the query; the empty-query effect below routes the exit.
      // The list-mode Esc handler then implements the second-stage cancel.
      setSearchQuery('');
      return;
    }

    if (DELETION_KEY_NAMES.has(name)) {
      // Pop one char. Once the query empties out, the effect fires
      // the exit — typing `/abc` ⌫⌫⌫⌫ leaves the user exactly where
      // they started instead of stuck in a search frame.
      //
      // The functional updater is required for correctness under
      // batched Backspaces (each call sees the previous queued
      // value, not the same stale closure). React 18 StrictMode
      // double-invokes updaters in dev for purity checks, which
      // is why the side effect lives outside the updater.
      setSearchQuery((q) => q.slice(0, -1));
      return;
    }

    if (ctrl && (name === 'u' || name === 'l')) {
      // Wipe the query and let the empty-query effect fire the exit.
      setSearchQuery('');
      return;
    }

    if (isPrintableSearchChar(key)) {
      setSearchQuery((q) => q + sequence);
      return;
    }

    // Anything else (Ctrl+B, Tab, Page keys, …) is silently
    // swallowed by the caller — search owns the keyboard.
  }, []);

  // Exit to list mode whenever the query empties out — unifies Esc,
  // Ctrl+U/L, and the last Backspace through a single side-effect
  // site. The previous-value ref guards initial mount (where query
  // starts at ''): we only fire on a non-empty → empty transition.
  // StrictMode's mount/cleanup/mount dance is a no-op here because
  // the initial state can never satisfy `prev !== ''`.
  const prevSearchQueryRef = useRef('');
  useEffect(() => {
    if (searchQuery === '' && prevSearchQueryRef.current !== '') {
      onExitToList();
    }
    prevSearchQueryRef.current = searchQuery;
  }, [searchQuery, onExitToList]);

  return { searchQuery, setSearchQuery, handleSearchKey };
}
