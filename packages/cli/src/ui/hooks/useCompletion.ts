/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect } from 'react';

import {
  MAX_SUGGESTIONS_TO_SHOW,
  type Suggestion,
} from '../components/SuggestionsDisplay.js';
import { calculateCenteredWindow } from '../utils/calculateCenteredWindow.js';

export interface UseCompletionReturn {
  suggestions: Suggestion[];
  activeSuggestionIndex: number;
  visibleStartIndex: number;
  isLoadingSuggestions: boolean;
  isPerfectMatch: boolean;
  setSuggestions: React.Dispatch<React.SetStateAction<Suggestion[]>>;
  setActiveSuggestionIndex: React.Dispatch<React.SetStateAction<number>>;
  setVisibleStartIndex: React.Dispatch<React.SetStateAction<number>>;
  setIsLoadingSuggestions: React.Dispatch<React.SetStateAction<boolean>>;
  setIsPerfectMatch: React.Dispatch<React.SetStateAction<boolean>>;
  resetCompletionState: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
}

export function useCompletion(): UseCompletionReturn {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] =
    useState<number>(-1);
  const [visibleStartIndex, setVisibleStartIndex] = useState<number>(0);
  const [isLoadingSuggestions, setIsLoadingSuggestions] =
    useState<boolean>(false);
  const [isPerfectMatch, setIsPerfectMatch] = useState<boolean>(false);

  // Use a ref for suggestions.length so navigateUp/Down closures always see
  // the latest value without needing to re-create the callback (which would
  // cascade through the entire completion/input handler dependency chain and
  // potentially trigger spurious effect re-runs).
  const suggestionsLengthRef = useRef(suggestions.length);
  useEffect(() => {
    suggestionsLengthRef.current = suggestions.length;
  }, [suggestions.length]);

  const resetCompletionState = useCallback(() => {
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    setVisibleStartIndex(0);
    setIsLoadingSuggestions(false);
    setIsPerfectMatch(false);
  }, []);

  const navigateUp = useCallback(() => {
    const len = suggestionsLengthRef.current;
    if (len === 0) return;

    setActiveSuggestionIndex((prevActiveIndex) => {
      const newActiveIndex =
        prevActiveIndex <= 0 ? len - 1 : prevActiveIndex - 1;
      setVisibleStartIndex(
        calculateCenteredWindow(newActiveIndex, len, MAX_SUGGESTIONS_TO_SHOW),
      );
      return newActiveIndex;
    });
  }, []);

  const navigateDown = useCallback(() => {
    const len = suggestionsLengthRef.current;
    if (len === 0) return;

    setActiveSuggestionIndex((prevActiveIndex) => {
      const newActiveIndex =
        prevActiveIndex >= len - 1 ? 0 : prevActiveIndex + 1;
      setVisibleStartIndex(
        calculateCenteredWindow(newActiveIndex, len, MAX_SUGGESTIONS_TO_SHOW),
      );
      return newActiveIndex;
    });
  }, []);
  return {
    suggestions,
    activeSuggestionIndex,
    visibleStartIndex,
    isLoadingSuggestions,
    isPerfectMatch,

    setSuggestions,
    setActiveSuggestionIndex,
    setVisibleStartIndex,
    setIsLoadingSuggestions,
    setIsPerfectMatch,

    resetCompletionState,
    navigateUp,
    navigateDown,
  };
}
