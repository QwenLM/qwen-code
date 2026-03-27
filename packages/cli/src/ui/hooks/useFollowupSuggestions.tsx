/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Follow-up Suggestions Hook for CLI
 *
 * Thin React wrapper around the framework-agnostic controller from core.
 */

import { useState, useMemo, useRef, useEffect } from 'react';
import {
  INITIAL_FOLLOWUP_STATE,
  createFollowupController,
} from '@qwen-code/qwen-code-core';
import type {
  FollowupSuggestion,
  FollowupState,
} from '@qwen-code/qwen-code-core';

// Re-export for consumers that import from here
export type { FollowupState } from '@qwen-code/qwen-code-core';

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
 * Hook for managing follow-up suggestions in CLI.
 *
 * Delegates all timer/debounce/state logic to the shared
 * `createFollowupController` from core.
 *
 * @example
 * ```tsx
 * const { state, accept, dismiss, next, previous, setSuggestions } = useFollowupSuggestionsCLI({
 *   onAccept: (suggestion) => buffer.insert(suggestion),
 * });
 *
 * // After streaming completes:
 * setSuggestions([{ text: 'commit this', priority: 100 }]);
 * ```
 */
export function useFollowupSuggestionsCLI(
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

  return useMemo(
    () => ({
      state,
      setSuggestions: controller.setSuggestions,
      accept: controller.accept,
      dismiss: controller.dismiss,
      next: controller.next,
      previous: controller.previous,
      clear: controller.clear,
    }),
    [state, controller],
  );
}
