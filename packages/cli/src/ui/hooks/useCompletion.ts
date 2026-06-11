/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useRef } from 'react';

import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { MAX_SUGGESTIONS_TO_SHOW } from '../components/SuggestionsDisplay.js';

export interface UseCompletionOptions {
  /** When the completion query changes, the dismissed flag is cleared
   *  (unless dismissCompletion was just called). */
  query?: string;
}

export interface UseCompletionReturn {
  suggestions: Suggestion[];
  activeSuggestionIndex: number;
  visibleStartIndex: number;
  showSuggestions: boolean;
  isLoadingSuggestions: boolean;
  isPerfectMatch: boolean;
  dismissed: boolean;
  setSuggestions: React.Dispatch<React.SetStateAction<Suggestion[]>>;
  setActiveSuggestionIndex: React.Dispatch<React.SetStateAction<number>>;
  setVisibleStartIndex: React.Dispatch<React.SetStateAction<number>>;
  setIsLoadingSuggestions: React.Dispatch<React.SetStateAction<boolean>>;
  setIsPerfectMatch: React.Dispatch<React.SetStateAction<boolean>>;
  setShowSuggestions: React.Dispatch<React.SetStateAction<boolean>>;
  /** Dismisses the completion dropdown and prevents re-open until query changes. */
  dismissCompletion: () => void;
  /** Clears the dismissed flag so the dropdown can re-open. */
  clearDismissed: () => void;
  resetCompletionState: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
}

export function useCompletion(
  options: UseCompletionOptions = {},
): UseCompletionReturn {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] =
    useState<number>(-1);
  const [visibleStartIndex, setVisibleStartIndex] = useState<number>(0);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [isLoadingSuggestions, setIsLoadingSuggestions] =
    useState<boolean>(false);
  const [isPerfectMatch, setIsPerfectMatch] = useState<boolean>(false);
  const [dismissed, setDismissed] = useState<boolean>(false);
  // Skip the next clearDismissed call when the query changes due to an
  // accepted suggestion (dismissCompletion).  Accepting a suggestion also
  // mutates the buffer → changes the query, but we don't want to reset
  // dismissed in that case.
  const skipNextClearRef = useRef<boolean>(false);

  const resetCompletionState = useCallback(() => {
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setVisibleStartIndex(0);
    setShowSuggestions(false);
    setIsLoadingSuggestions(false);
    setIsPerfectMatch(false);
  }, []);

  const dismissCompletion = useCallback(() => {
    setDismissed(true);
    skipNextClearRef.current = true;
    resetCompletionState();
  }, [resetCompletionState]);

  const clearDismissed = useCallback(() => {
    setDismissed(false);
  }, []);

  // Clear dismissed flag when the completion query changes (user typed more).
  // Skip the clear on the render immediately following a dismiss, since
  // accepting a suggestion also changes the query.
  const prevQueryRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (options.query !== prevQueryRef.current) {
      if (skipNextClearRef.current) {
        skipNextClearRef.current = false;
      } else {
        clearDismissed();
      }
      prevQueryRef.current = options.query;
    }
  }, [options.query, clearDismissed]);

  const navigateUp = useCallback(() => {
    if (suggestions.length === 0) return;

    setActiveSuggestionIndex((prevActiveIndex) => {
      // Calculate new active index, handling wrap-around
      const newActiveIndex =
        prevActiveIndex <= 0 ? suggestions.length - 1 : prevActiveIndex - 1;

      // Adjust scroll position based on the new active index
      setVisibleStartIndex((prevVisibleStart) => {
        // Case 1: Wrapped around to the last item
        if (
          newActiveIndex === suggestions.length - 1 &&
          suggestions.length > MAX_SUGGESTIONS_TO_SHOW
        ) {
          return Math.max(0, suggestions.length - MAX_SUGGESTIONS_TO_SHOW);
        }
        // Case 2: Scrolled above the current visible window
        if (newActiveIndex < prevVisibleStart) {
          return newActiveIndex;
        }
        // Otherwise, keep the current scroll position
        return prevVisibleStart;
      });

      return newActiveIndex;
    });
  }, [suggestions.length]);

  const navigateDown = useCallback(() => {
    if (suggestions.length === 0) return;

    setActiveSuggestionIndex((prevActiveIndex) => {
      // Calculate new active index, handling wrap-around
      const newActiveIndex =
        prevActiveIndex >= suggestions.length - 1 ? 0 : prevActiveIndex + 1;

      // Adjust scroll position based on the new active index
      setVisibleStartIndex((prevVisibleStart) => {
        // Case 1: Wrapped around to the first item
        if (
          newActiveIndex === 0 &&
          suggestions.length > MAX_SUGGESTIONS_TO_SHOW
        ) {
          return 0;
        }
        // Case 2: Scrolled below the current visible window
        const visibleEndIndex = prevVisibleStart + MAX_SUGGESTIONS_TO_SHOW;
        if (newActiveIndex >= visibleEndIndex) {
          return newActiveIndex - MAX_SUGGESTIONS_TO_SHOW + 1;
        }
        // Otherwise, keep the current scroll position
        return prevVisibleStart;
      });

      return newActiveIndex;
    });
  }, [suggestions.length]);

  return {
    suggestions,
    activeSuggestionIndex,
    visibleStartIndex,
    showSuggestions,
    isLoadingSuggestions,
    isPerfectMatch,
    dismissed,

    setSuggestions,
    setShowSuggestions,
    setActiveSuggestionIndex,
    setVisibleStartIndex,
    setIsLoadingSuggestions,
    setIsPerfectMatch,

    resetCompletionState,
    dismissCompletion,
    clearDismissed,
    navigateUp,
    navigateDown,
  };
}
