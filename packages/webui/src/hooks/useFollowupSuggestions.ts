/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Hook
 *
 * Thin React wrapper around the framework-agnostic controller from core.
 *
 * Note: For browser environments, the parent component should handle
 * suggestion generation and pass the results to this hook.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  INITIAL_FOLLOWUP_STATE,
  createFollowupController,
  type FollowupSuggestion,
  type FollowupState,
} from './followupState.js';

export type { FollowupSuggestion, FollowupState } from './followupState.js';

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
 * Hook for managing follow-up suggestions in the Web UI.
 *
 * Delegates all timer/debounce/state logic to the shared
 * `createFollowupController` from core. Adds a `getPlaceholder`
 * helper specific to the WebUI input form.
 *
 * @example
 * ```tsx
 * const { state, getPlaceholder, setSuggestions, accept, dismiss, next, previous } = useFollowupSuggestions({
 *   onAccept: (suggestion) => setInputText(suggestion),
 * });
 *
 * // After streaming completes:
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

  // Keep a mutable ref so the controller always sees the latest callback
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;

  // Create the controller once — it is stable across renders
  const controller = useMemo(
    () =>
      createFollowupController({
        enabled,
        onStateChange: setState,
        getOnAccept: () => onAcceptRef.current,
      }),
    [enabled],
  );

  // Clean up timers on unmount
  useEffect(() => () => controller.cleanup(), [controller]);

  // WebUI-specific helper: resolves placeholder text
  const getPlaceholder = useCallback(
    (defaultPlaceholder: string) => {
      if (state.isVisible && state.suggestion) {
        return state.suggestion;
      }
      return defaultPlaceholder;
    },
    [state.isVisible, state.suggestion],
  );

  return useMemo(
    () => ({
      state,
      getPlaceholder,
      setSuggestions: controller.setSuggestions,
      accept: controller.accept,
      dismiss: controller.dismiss,
      next: controller.next,
      previous: controller.previous,
      clear: controller.clear,
    }),
    [state, getPlaceholder, controller],
  );
}
