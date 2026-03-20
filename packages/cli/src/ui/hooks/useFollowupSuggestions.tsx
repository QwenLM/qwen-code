/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Hook for CLI
 *
 * React hook for managing follow-up suggestions in the CLI (Ink/React).
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { FollowupSuggestion } from '@qwen-code/qwen-code-core';

/**
 * State for follow-up suggestions in CLI
 */
export interface FollowupState {
  /** Current suggestion text (for ghost text) */
  suggestion: string | null;
  /** All available suggestions */
  suggestions: FollowupSuggestion[];
  /** Whether to show suggestion */
  isVisible: boolean;
  /** Index of current suggestion (for cycling) */
  currentIndex: number;
}

/**
 * Options for the hook
 */
export interface UseFollowupSuggestionsOptions {
  /** Whether the feature is enabled */
  enabled?: boolean;
  /** Callback when suggestion is accepted */
  onAccept?: (suggestion: string) => void;
}

/**
 * Result returned by the hook
 */
export interface UseFollowupSuggestionsReturn {
  /** Current state */
  state: FollowupState;
  /** Set suggestions directly (called by parent component) */
  setSuggestions: (suggestions: FollowupSuggestion[]) => void;
  /** Accept the current suggestion */
  accept: () => void;
  /** Dismiss the current suggestion */
  dismiss: () => void;
  /** Cycle to next suggestion */
  next: () => void;
  /** Cycle to previous suggestion */
  previous: () => void;
  /** Clear all suggestions */
  clear: () => void;
}

/**
 * Hook for managing follow-up suggestions in CLI
 *
 * @example
 * ```tsx
 * import { useFollowupSuggestionsCLI } from './hooks/useFollowupSuggestions';
 * import type { FollowupSuggestion } from '@qwen-code/qwen-code-core';
 *
 * const { state, accept, dismiss, next, previous, setSuggestions } = useFollowupSuggestionsCLI({
 *   onAccept: (suggestion) => {
 *     buffer.insert(suggestion);
 *   },
 * });
 *
 * // After streaming completes, call:
 * setSuggestions([{ text: 'commit this', priority: 100 }]);
 * ```
 */
export function useFollowupSuggestionsCLI(
  options: UseFollowupSuggestionsOptions = {},
): UseFollowupSuggestionsReturn {
  const { enabled = true, onAccept } = options;

  const [state, setState] = useState<FollowupState>({
    suggestion: null,
    suggestions: [],
    isVisible: false,
    currentIndex: 0,
  });

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const acceptingRef = useRef(false); // Prevent rapid-fire accepts
  const acceptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Set suggestions directly (called by parent component after generating)
   */
  const setSuggestions = useCallback(
    (suggestions: FollowupSuggestion[]) => {
      if (!enabled) {
        return;
      }

      // Clear any existing timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      // Small delay to show suggestion after response completes
      timeoutRef.current = setTimeout(() => {
        if (suggestions.length > 0) {
          setState({
            suggestion: suggestions[0].text,
            suggestions,
            isVisible: true,
            currentIndex: 0,
          });
        } else {
          setState({
            suggestion: null,
            suggestions: [],
            isVisible: false,
            currentIndex: 0,
          });
        }
      }, 300);
    },
    [enabled],
  );

  /**
   * Accept the current suggestion
   */
  const accept = useCallback(() => {
    // Prevent duplicate accepts (rapid Tab presses)
    if (acceptingRef.current) {
      return;
    }

    setState((prev) => {
      if (
        prev.suggestions.length === 0 ||
        prev.currentIndex >= prev.suggestions.length
      ) {
        return prev;
      }

      const suggestion = prev.suggestions[prev.currentIndex].text;
      onAccept?.(suggestion);

      // Set accepting lock
      acceptingRef.current = true;

      // Clear lock after a short delay
      if (acceptTimeoutRef.current) {
        clearTimeout(acceptTimeoutRef.current);
      }
      acceptTimeoutRef.current = setTimeout(() => {
        acceptingRef.current = false;
      }, 100);

      // Clear after accepting
      return {
        suggestion: null,
        suggestions: [],
        isVisible: false,
        currentIndex: 0,
      };
    });
  }, [onAccept]);

  /**
   * Dismiss the current suggestion
   */
  const dismiss = useCallback(() => {
    setState({
      suggestion: null,
      suggestions: [],
      isVisible: false,
      currentIndex: 0,
    });
  }, []);

  /**
   * Cycle to next suggestion
   */
  const next = useCallback(() => {
    setState((prev) => {
      if (prev.suggestions.length === 0) {
        return prev;
      }

      const nextIndex = (prev.currentIndex + 1) % prev.suggestions.length;
      return {
        ...prev,
        currentIndex: nextIndex,
        suggestion: prev.suggestions[nextIndex].text,
      };
    });
  }, []);

  /**
   * Cycle to previous suggestion
   */
  const previous = useCallback(() => {
    setState((prev) => {
      if (prev.suggestions.length === 0) {
        return prev;
      }

      const prevIndex =
        prev.currentIndex === 0
          ? prev.suggestions.length - 1
          : prev.currentIndex - 1;
      return {
        ...prev,
        currentIndex: prevIndex,
        suggestion: prev.suggestions[prevIndex].text,
      };
    });
  }, []);

  /**
   * Clear all suggestions and reset state
   */
  const clear = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (acceptTimeoutRef.current) {
      clearTimeout(acceptTimeoutRef.current);
      acceptTimeoutRef.current = null;
    }

    setState({
      suggestion: null,
      suggestions: [],
      isVisible: false,
      currentIndex: 0,
    });
  }, []);

  // Clean up timeouts on unmount
  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (acceptTimeoutRef.current) {
        clearTimeout(acceptTimeoutRef.current);
        acceptTimeoutRef.current = null;
      }
    },
    [],
  );

  // Stable reference to return value to prevent unnecessary re-renders
  return useMemo(
    () => ({
      state,
      setSuggestions,
      accept,
      dismiss,
      next,
      previous,
      clear,
    }),
    [state, setSuggestions, accept, dismiss, next, previous, clear],
  );
}
