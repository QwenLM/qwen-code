/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Hook
 *
 * React hook for managing follow-up suggestions in the Web UI.
 *
 * Note: For browser environments, the parent component should handle
 * suggestion generation and pass the results to this hook.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  INITIAL_FOLLOWUP_STATE,
  followupReducers,
} from '@qwen-code/qwen-code-core';
import type {
  FollowupSuggestion,
  FollowupState,
} from '@qwen-code/qwen-code-core';

// Re-export types from core for convenience
export type {
  FollowupSuggestion,
  FollowupState,
} from '@qwen-code/qwen-code-core';

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
  /** Get current placeholder text */
  getPlaceholder: (defaultPlaceholder: string) => string;
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
 * Hook for managing follow-up suggestions
 *
 * @example
 * ```tsx
 * import { useFollowupSuggestions } from '@qwen-code/webui';
 * import type { FollowupSuggestion } from '@qwen-code/qwen-code-core';
 *
 * const { state, getPlaceholder, setSuggestions, accept, dismiss, next, previous } = useFollowupSuggestions({
 *   onAccept: (suggestion) => setInputText(suggestion),
 * });
 *
 * // After streaming completes, call:
 * setSuggestions([{ text: 'commit this', priority: 100 }]);
 *
 * // Pass to InputForm:
 * <InputForm
 *   followupState={state}
 *   onNextFollowup={next}
 *   onPreviousFollowup={previous}
 *   onAcceptFollowup={accept}
 *   onDismissFollowup={dismiss}
 * />
 * ```
 */
export function useFollowupSuggestions(
  options: UseFollowupSuggestionsOptions = {},
): UseFollowupSuggestionsReturn {
  const { enabled = true, onAccept } = options;

  const [state, setState] = useState<FollowupState>(INITIAL_FOLLOWUP_STATE);

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
      }

      timeoutRef.current = setTimeout(() => {
        setState(followupReducers.setSuggestions(suggestions));
      }, SUGGESTION_DELAY_MS);
    },
    [enabled],
  );

  const getPlaceholder = useCallback(
    (defaultPlaceholder: string) => {
      if (state.isVisible && state.suggestion) {
        return state.suggestion;
      }
      return defaultPlaceholder;
    },
    [state.isVisible, state.suggestion],
  );

  const accept = useCallback(() => {
    if (acceptingRef.current) {
      return;
    }

    setState((prev) => {
      const text = followupReducers.getAcceptText(prev);
      if (text === null) {
        return prev;
      }

      // Schedule side effects outside the updater via microtask
      queueMicrotask(() => {
        onAccept?.(text);

        acceptingRef.current = true;
        if (acceptTimeoutRef.current) {
          clearTimeout(acceptTimeoutRef.current);
        }
        acceptTimeoutRef.current = setTimeout(() => {
          acceptingRef.current = false;
        }, ACCEPT_DEBOUNCE_MS);
      });

      return followupReducers.clear();
    });
  }, [onAccept]);

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

  return {
    state,
    getPlaceholder,
    setSuggestions,
    accept,
    dismiss,
    next,
    previous,
    clear,
  };
}
