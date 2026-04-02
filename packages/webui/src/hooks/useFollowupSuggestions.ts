/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prompt Suggestion Hook
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
} from '@qwen-code/qwen-code-core';
import type { FollowupState } from '@qwen-code/qwen-code-core';

// Re-export types from core for convenience
export type { FollowupState } from '@qwen-code/qwen-code-core';

/**
 * Options for the hook
 */
export interface UseFollowupSuggestionsOptions {
  /** Whether the feature is enabled */
  enabled?: boolean;
  /** Callback when suggestion is accepted */
  onAccept?: (suggestion: string) => void;
  /** Callback when a suggestion outcome is determined */
  onOutcome?: (params: {
    outcome: 'accepted' | 'ignored';
    accept_method?: 'tab' | 'enter' | 'right';
    time_ms: number;
    suggestion_length: number;
  }) => void;
}

/**
 * Result returned by the hook
 */
export interface UseFollowupSuggestionsReturn {
  /** Current state */
  state: FollowupState;
  /** Get current placeholder text */
  getPlaceholder: (defaultPlaceholder: string) => string;
  /** Set suggestion text (called by parent component) */
  setSuggestion: (text: string | null) => void;
  /** Accept the current suggestion */
  accept: (method?: 'tab' | 'enter' | 'right') => void;
  /** Dismiss the current suggestion */
  dismiss: () => void;
  /** Clear all state */
  clear: () => void;
}

/**
 * Hook for managing prompt suggestions in the Web UI.
 *
 * Delegates all timer/debounce/state logic to the shared
 * `createFollowupController` from core. Adds a `getPlaceholder`
 * helper specific to the WebUI input form.
 */
export function useFollowupSuggestions(
  options: UseFollowupSuggestionsOptions = {},
): UseFollowupSuggestionsReturn {
  const { enabled = true, onAccept, onOutcome } = options;

  const [state, setState] = useState<FollowupState>(INITIAL_FOLLOWUP_STATE);

  // Keep mutable refs so the controller always sees the latest callbacks
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;
  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;

  // Create the controller once — it is stable across renders
  const controller = useMemo(
    () =>
      createFollowupController({
        enabled,
        onStateChange: setState,
        getOnAccept: () => onAcceptRef.current,
        onOutcome: (params) => onOutcomeRef.current?.(params),
      }),
    [enabled],
  );

  // Clear state when disabled; clean up timers on unmount
  useEffect(() => {
    if (!enabled) {
      controller.clear();
    }
    return () => controller.cleanup();
  }, [controller, enabled]);

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
      setSuggestion: controller.setSuggestion,
      accept: controller.accept,
      dismiss: controller.dismiss,
      clear: controller.clear,
    }),
    [state, getPlaceholder, controller],
  );
}
