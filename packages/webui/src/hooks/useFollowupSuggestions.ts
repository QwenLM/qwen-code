/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { FollowupState } from '../types/followup.js';
import { INITIAL_FOLLOWUP_STATE } from '../types/followup.js';

export type { FollowupState } from '../types/followup.js';

// ---------------------------------------------------------------------------
// Controller (framework-agnostic)
// ---------------------------------------------------------------------------

/** Delay before showing suggestion after response completes */
const SUGGESTION_DELAY_MS = 300;
/** Debounce lock duration to prevent rapid-fire accepts */
const ACCEPT_DEBOUNCE_MS = 100;

interface FollowupControllerOptions {
  enabled?: boolean;
  onStateChange: (state: FollowupState) => void;
  getOnAccept?: () => ((text: string) => void) | undefined;
  onOutcome?: (params: {
    outcome: 'accepted' | 'ignored';
    accept_method?: 'tab' | 'enter' | 'right';
    time_ms: number;
    suggestion_length: number;
  }) => void;
}

interface FollowupControllerActions {
  setSuggestion: (text: string | null) => void;
  accept: (method?: 'tab' | 'enter' | 'right') => void;
  dismiss: () => void;
  clear: () => void;
  cleanup: () => void;
}

function createFollowupController(
  options: FollowupControllerOptions,
): FollowupControllerActions {
  const { enabled = true, onStateChange, getOnAccept, onOutcome } = options;

  let currentState: FollowupState = INITIAL_FOLLOWUP_STATE;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let accepting = false;
  let acceptTimeoutId: ReturnType<typeof setTimeout> | null = null;

  function applyState(next: FollowupState): void {
    currentState = next;
    onStateChange(next);
  }

  function clearTimers(): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (acceptTimeoutId) {
      clearTimeout(acceptTimeoutId);
      acceptTimeoutId = null;
    }
  }

  const setSuggestion = (text: string | null): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (!text) {
      applyState(INITIAL_FOLLOWUP_STATE);
      return;
    }

    if (!enabled) {
      return;
    }

    timeoutId = setTimeout(() => {
      applyState({ suggestion: text, isVisible: true, shownAt: Date.now() });
    }, SUGGESTION_DELAY_MS);
  };

  const accept = (method?: 'tab' | 'enter' | 'right'): void => {
    if (accepting) {
      return;
    }

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    accepting = true;

    const text = currentState.suggestion;
    const { shownAt } = currentState;
    if (!text) {
      accepting = false;
      return;
    }

    try {
      onOutcome?.({
        outcome: 'accepted',
        accept_method: method,
        time_ms: shownAt > 0 ? Date.now() - shownAt : 0,
        suggestion_length: text.length,
      });
    } catch (e: unknown) {
       
      console.error('[followup] onOutcome callback threw:', e);
    }

    applyState(INITIAL_FOLLOWUP_STATE);

    queueMicrotask(() => {
      try {
        getOnAccept?.()?.(text);
      } catch (error: unknown) {
         
        console.error('[followup] onAccept callback threw:', error);
      } finally {
        if (acceptTimeoutId) {
          clearTimeout(acceptTimeoutId);
        }
        acceptTimeoutId = setTimeout(() => {
          accepting = false;
        }, ACCEPT_DEBOUNCE_MS);
      }
    });
  };

  const dismiss = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (!currentState.isVisible && !currentState.suggestion) {
      return;
    }

    if (currentState.isVisible && currentState.suggestion) {
      try {
        onOutcome?.({
          outcome: 'ignored',
          time_ms:
            currentState.shownAt > 0 ? Date.now() - currentState.shownAt : 0,
          suggestion_length: currentState.suggestion.length,
        });
      } catch (e: unknown) {
         
        console.error('[followup] onOutcome callback threw:', e);
      }
    }

    applyState(INITIAL_FOLLOWUP_STATE);
  };

  const clear = (): void => {
    clearTimers();
    accepting = false;
    applyState(INITIAL_FOLLOWUP_STATE);
  };

  const cleanup = (): void => {
    clearTimers();
    accepting = false;
  };

  return { setSuggestion, accept, dismiss, clear, cleanup };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface UseFollowupSuggestionsOptions {
  enabled?: boolean;
  onAccept?: (suggestion: string) => void;
  onOutcome?: (params: {
    outcome: 'accepted' | 'ignored';
    accept_method?: 'tab' | 'enter' | 'right';
    time_ms: number;
    suggestion_length: number;
  }) => void;
}

export interface UseFollowupSuggestionsReturn {
  state: FollowupState;
  getPlaceholder: (defaultPlaceholder: string) => string;
  setSuggestion: (text: string | null) => void;
  accept: (method?: 'tab' | 'enter' | 'right') => void;
  dismiss: () => void;
  clear: () => void;
}

export function useFollowupSuggestions(
  options: UseFollowupSuggestionsOptions = {},
): UseFollowupSuggestionsReturn {
  const { enabled = true, onAccept, onOutcome } = options;

  const [state, setState] = useState<FollowupState>(INITIAL_FOLLOWUP_STATE);

  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;
  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;

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

  useEffect(() => {
    if (!enabled) {
      controller.clear();
    }
    return () => controller.cleanup();
  }, [controller, enabled]);

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
