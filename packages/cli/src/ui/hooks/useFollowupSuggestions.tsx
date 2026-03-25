/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Hook for CLI
 *
 * React hook for managing follow-up suggestions in the CLI (Ink/React).
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  INITIAL_FOLLOWUP_STATE,
  followupReducers,
} from '@qwen-code/qwen-code-core';
import type {
  FollowupSuggestion,
  FollowupState,
} from '@qwen-code/qwen-code-core';

// Re-export for consumers that import from here
export type { FollowupState } from '@qwen-code/qwen-code-core';

/** Delay before showing suggestion after response completes */
const SUGGESTION_DELAY_MS = 300;
/** Debounce lock duration to prevent rapid-fire accepts */
const ACCEPT_DEBOUNCE_MS = 100;

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

  const [state, setState] = useState<FollowupState>(INITIAL_FOLLOWUP_STATE);

  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const acceptingRef = useRef(false);
  const acceptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSuggestions = useCallback(
    (suggestions: FollowupSuggestion[]) => {
      if (!enabled) {
        return;
      }

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Empty array clears immediately; non-empty is delayed for UX
      if (suggestions.length === 0) {
        setState(followupReducers.clear());
        return;
      }

      timeoutRef.current = setTimeout(() => {
        setState(followupReducers.setSuggestions(suggestions));
      }, SUGGESTION_DELAY_MS);
    },
    [enabled],
  );

  const accept = useCallback(() => {
    if (acceptingRef.current) {
      return;
    }

    // Lock synchronously to prevent multiple rapid calls in the same tick
    acceptingRef.current = true;

    setState((prev) => {
      const text = followupReducers.getAcceptText(prev);
      if (text === null) {
        // Nothing to accept — release lock
        acceptingRef.current = false;
        return prev;
      }

      // Schedule side effects outside the updater via microtask
      queueMicrotask(() => {
        onAcceptRef.current?.(text);

        if (acceptTimeoutRef.current) {
          clearTimeout(acceptTimeoutRef.current);
        }
        acceptTimeoutRef.current = setTimeout(() => {
          acceptingRef.current = false;
        }, ACCEPT_DEBOUNCE_MS);
      });

      return followupReducers.clear();
    });
  }, []);

  const dismiss = useCallback(() => {
    setState(followupReducers.clear());
  }, []);

  const next = useCallback(() => {
    setState((prev) => followupReducers.next(prev) ?? prev);
  }, []);

  const previous = useCallback(() => {
    setState((prev) => followupReducers.previous(prev) ?? prev);
  }, []);

  const clear = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (acceptTimeoutRef.current) {
      clearTimeout(acceptTimeoutRef.current);
      acceptTimeoutRef.current = null;
    }
    acceptingRef.current = false;
    setState(followupReducers.clear());
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
