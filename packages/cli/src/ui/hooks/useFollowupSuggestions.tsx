/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Prompt Suggestion Hook for CLI
 *
 * Thin React wrapper around the framework-agnostic controller from core.
 */

import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  INITIAL_FOLLOWUP_STATE,
  createFollowupController,
  logPromptSuggestion,
  PromptSuggestionEvent,
} from '@qwen-code/qwen-code-core';
import type { FollowupState, Config } from '@qwen-code/qwen-code-core';

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
  /** Config for telemetry logging */
  config?: Config;
  /** Whether the terminal is focused (for telemetry) */
  isFocused?: boolean;
}

/**
 * Result returned by the hook
 */
export interface UseFollowupSuggestionsReturn {
  /** Current state */
  state: FollowupState;
  /** Set suggestion text (called by parent component) */
  setSuggestion: (text: string | null) => void;
  /** Accept the current suggestion */
  accept: (
    method?: 'tab' | 'enter' | 'right',
    options?: { skipOnAccept?: boolean },
  ) => void;
  /** Dismiss the current suggestion */
  dismiss: () => void;
  /** Clear all state */
  clear: () => void;
  /**
   * Notify that the user typed while suggestion was visible.
   * Call from the input handler on first keystroke.
   */
  recordKeystroke: () => void;
}

/**
 * Hook for managing prompt suggestions in CLI.
 *
 * Delegates all timer/debounce/state logic to the shared
 * `createFollowupController` from core.
 */
export function useFollowupSuggestionsCLI(
  options: UseFollowupSuggestionsOptions = {},
): UseFollowupSuggestionsReturn {
  const { enabled = true, onAccept, config, isFocused = true } = options;

  const [state, setState] = useState<FollowupState>(INITIAL_FOLLOWUP_STATE);

  // Keep mutable refs so the controller always sees the latest callbacks
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;
  const configRef = useRef(config);
  configRef.current = config;

  // Engagement tracking refs
  const firstKeystrokeAtRef = useRef(0);
  const prevShownAtRef = useRef(0);
  const wasFocusedWhenShownRef = useRef(true);

  // Track when a new suggestion appears (in useEffect to avoid render-time side effects)
  useEffect(() => {
    if (state.shownAt > 0 && state.shownAt !== prevShownAtRef.current) {
      prevShownAtRef.current = state.shownAt;
      wasFocusedWhenShownRef.current = isFocused;
      firstKeystrokeAtRef.current = 0;
    } else if (state.shownAt === 0) {
      prevShownAtRef.current = 0;
    }
  }, [state.shownAt, isFocused]);

  const recordKeystroke = useCallback(() => {
    if (firstKeystrokeAtRef.current === 0 && state.isVisible) {
      firstKeystrokeAtRef.current = Date.now();
    }
  }, [state.isVisible]);

  // Telemetry callback from controller (accept/dismiss)
  const onOutcome = useCallback(
    (params: {
      outcome: 'accepted' | 'ignored';
      accept_method?: 'tab' | 'enter' | 'right';
      time_ms: number;
      suggestion_length: number;
    }) => {
      const cfg = configRef.current;
      if (!cfg) return;
      logPromptSuggestion(
        cfg,
        new PromptSuggestionEvent({
          outcome: params.outcome,
          accept_method: params.accept_method,
          ...(params.outcome === 'accepted'
            ? { time_to_accept_ms: params.time_ms }
            : { time_to_ignore_ms: params.time_ms }),
          ...(firstKeystrokeAtRef.current > 0 &&
            prevShownAtRef.current > 0 && {
              time_to_first_keystroke_ms:
                firstKeystrokeAtRef.current - prevShownAtRef.current,
            }),
          suggestion_length: params.suggestion_length,
          similarity: params.outcome === 'accepted' ? 1.0 : 0.0,
          was_focused_when_shown: wasFocusedWhenShownRef.current,
        }),
      );
    },
    [],
  );

  // Create the controller once — it is stable across renders
  const controller = useMemo(
    () =>
      createFollowupController({
        enabled,
        onStateChange: setState,
        getOnAccept: () => onAcceptRef.current,
        onOutcome,
      }),
    [enabled, onOutcome],
  );

  // Clear state when disabled; clean up timers on unmount
  useEffect(() => {
    if (!enabled) {
      controller.clear();
    }
    return () => controller.cleanup();
  }, [controller, enabled]);

  return useMemo(
    () => ({
      state,
      setSuggestion: controller.setSuggestion,
      accept: controller.accept,
      dismiss: controller.dismiss,
      clear: controller.clear,
      recordKeystroke,
    }),
    [state, controller, recordKeystroke],
  );
}
