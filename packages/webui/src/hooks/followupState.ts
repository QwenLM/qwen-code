/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared Follow-up Suggestions State Logic for WebUI
 *
 * Browser-safe state management for follow-up suggestions.
 */

/**
 * A single follow-up suggestion.
 */
export interface FollowupSuggestion {
  /** The suggested command text */
  text: string;
  /** Optional description shown below the suggestion */
  description?: string;
  /** Priority for ranking (higher = more relevant) */
  priority: number;
}

/**
 * State for follow-up suggestions.
 */
export interface FollowupState {
  /** Current suggestion text */
  suggestion: string | null;
  /** All available suggestions */
  suggestions: FollowupSuggestion[];
  /** Whether to show suggestion */
  isVisible: boolean;
  /** Index of current suggestion (for cycling) */
  currentIndex: number;
}

/** Initial empty state. */
export const INITIAL_FOLLOWUP_STATE: FollowupState = {
  suggestion: null,
  suggestions: [],
  isVisible: false,
  currentIndex: 0,
};

/** Delay before showing suggestion after response completes */
const SUGGESTION_DELAY_MS = 300;
/** Debounce lock duration to prevent rapid-fire accepts */
const ACCEPT_DEBOUNCE_MS = 100;

export interface FollowupControllerOptions {
  /** Whether the feature is enabled (checked when setting suggestions) */
  enabled?: boolean;
  /** Called whenever the internal state changes */
  onStateChange: (state: FollowupState) => void;
  /** Returns the latest accept callback */
  getOnAccept?: () => ((text: string) => void) | undefined;
}

export interface FollowupControllerActions {
  /** Set suggestions (with delayed show). Empty array clears immediately. */
  setSuggestions: (suggestions: FollowupSuggestion[]) => void;
  /** Accept the current suggestion and invoke onAccept callback */
  accept: () => void;
  /** Dismiss/clear suggestions */
  dismiss: () => void;
  /** Cycle to next suggestion */
  next: () => void;
  /** Cycle to previous suggestion */
  previous: () => void;
  /** Hard-clear all state and timers */
  clear: () => void;
  /** Clean up timers — call on unmount */
  cleanup: () => void;
}

function clearState(): FollowupState {
  return INITIAL_FOLLOWUP_STATE;
}

function setSuggestionsState(suggestions: FollowupSuggestion[]): FollowupState {
  if (suggestions.length === 0) {
    return clearState();
  }

  return {
    suggestion: suggestions[0].text,
    suggestions,
    isVisible: true,
    currentIndex: 0,
  };
}

function getAcceptText(state: FollowupState): string | null {
  if (
    state.suggestions.length === 0 ||
    state.currentIndex >= state.suggestions.length
  ) {
    return null;
  }

  return state.suggestions[state.currentIndex].text;
}

function getNextState(state: FollowupState): FollowupState | null {
  if (state.suggestions.length === 0) {
    return null;
  }

  const nextIndex = (state.currentIndex + 1) % state.suggestions.length;
  return {
    ...state,
    currentIndex: nextIndex,
    suggestion: state.suggestions[nextIndex].text,
  };
}

function getPreviousState(state: FollowupState): FollowupState | null {
  if (state.suggestions.length === 0) {
    return null;
  }

  const previousIndex =
    state.currentIndex === 0
      ? state.suggestions.length - 1
      : state.currentIndex - 1;
  return {
    ...state,
    currentIndex: previousIndex,
    suggestion: state.suggestions[previousIndex].text,
  };
}

export function createFollowupController(
  options: FollowupControllerOptions,
): FollowupControllerActions {
  const { enabled = true, onStateChange, getOnAccept } = options;

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

  const setSuggestions = (suggestions: FollowupSuggestion[]): void => {
    if (!enabled) {
      return;
    }

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (suggestions.length === 0) {
      applyState(clearState());
      return;
    }

    timeoutId = setTimeout(() => {
      applyState(setSuggestionsState(suggestions));
    }, SUGGESTION_DELAY_MS);
  };

  const accept = (): void => {
    if (accepting) {
      return;
    }

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    accepting = true;

    const text = getAcceptText(currentState);
    if (text === null) {
      accepting = false;
      return;
    }

    applyState(clearState());

    queueMicrotask(() => {
      getOnAccept?.()?.(text);

      if (acceptTimeoutId) {
        clearTimeout(acceptTimeoutId);
      }
      acceptTimeoutId = setTimeout(() => {
        accepting = false;
      }, ACCEPT_DEBOUNCE_MS);
    });
  };

  const dismiss = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    applyState(clearState());
  };

  const next = (): void => {
    const nextState = getNextState(currentState);
    if (nextState) {
      applyState(nextState);
    }
  };

  const previous = (): void => {
    const previousState = getPreviousState(currentState);
    if (previousState) {
      applyState(previousState);
    }
  };

  const clear = (): void => {
    clearTimers();
    accepting = false;
    applyState(clearState());
  };

  const cleanup = (): void => {
    clearTimers();
  };

  return { setSuggestions, accept, dismiss, next, previous, clear, cleanup };
}
