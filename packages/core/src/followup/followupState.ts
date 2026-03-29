/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared Follow-up Suggestions State Logic
 *
 * Framework-agnostic state management for follow-up suggestions,
 * shared between CLI (Ink) and WebUI (React) hooks.
 */

import type { FollowupSuggestion } from './types.js';

/**
 * State for follow-up suggestions
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

/** Initial empty state */
export const INITIAL_FOLLOWUP_STATE: FollowupState = {
  suggestion: null,
  suggestions: [],
  isVisible: false,
  currentIndex: 0,
};

/**
 * Pure state reducers for follow-up suggestion state transitions.
 * These are safe to use inside React setState updaters.
 */
export const followupReducers = {
  /** Set new suggestions */
  setSuggestions(suggestions: FollowupSuggestion[]): FollowupState {
    if (suggestions.length > 0) {
      return {
        suggestion: suggestions[0].text,
        suggestions,
        isVisible: true,
        currentIndex: 0,
      };
    }
    return INITIAL_FOLLOWUP_STATE;
  },

  /** Clear state (dismiss / clear) */
  clear(): FollowupState {
    return INITIAL_FOLLOWUP_STATE;
  },

  /** Cycle to next suggestion. Returns null if no change needed. */
  next(prev: FollowupState): FollowupState | null {
    if (prev.suggestions.length === 0) {
      return null;
    }
    const nextIndex = (prev.currentIndex + 1) % prev.suggestions.length;
    return {
      ...prev,
      currentIndex: nextIndex,
      suggestion: prev.suggestions[nextIndex].text,
    };
  },

  /** Cycle to previous suggestion. Returns null if no change needed. */
  previous(prev: FollowupState): FollowupState | null {
    if (prev.suggestions.length === 0) {
      return null;
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
  },

  /** Get current suggestion text for accept. Returns null if nothing to accept. */
  getAcceptText(state: FollowupState): string | null {
    if (
      state.suggestions.length === 0 ||
      state.currentIndex >= state.suggestions.length
    ) {
      return null;
    }
    return state.suggestions[state.currentIndex].text;
  },
};

// ---------------------------------------------------------------------------
// Framework-agnostic controller
// ---------------------------------------------------------------------------

/** Delay before showing suggestion after response completes */
const SUGGESTION_DELAY_MS = 300;
/** Debounce lock duration to prevent rapid-fire accepts */
const ACCEPT_DEBOUNCE_MS = 100;

/**
 * Options for creating a followup controller
 */
export interface FollowupControllerOptions {
  /** Whether the feature is enabled (checked when setting suggestions) */
  enabled?: boolean;
  /** Called whenever the internal state changes */
  onStateChange: (state: FollowupState) => void;
  /**
   * Returns the current onAccept callback.
   * A getter is used so the controller always invokes the latest callback
   * without requiring re-creation when the callback reference changes.
   */
  getOnAccept?: () => ((text: string) => void) | undefined;
}

/**
 * Actions returned by createFollowupController.
 * These are stable (never change identity) and safe to call from any context.
 */
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

/**
 * Creates a framework-agnostic followup suggestion controller.
 *
 * Encapsulates timer management, accept debounce, and state transitions so
 * that React hooks (CLI and WebUI) only need thin wrappers around
 * `useState` + this controller.
 *
 * @param options - Controller configuration
 * @returns Stable action functions and a cleanup function
 */
export function createFollowupController(
  options: FollowupControllerOptions,
): FollowupControllerActions {
  const { enabled = true, onStateChange, getOnAccept } = options;

  let currentState: FollowupState = INITIAL_FOLLOWUP_STATE;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let accepting = false;
  let acceptTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Apply a new state and notify the consumer */
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
      applyState(followupReducers.clear());
      return;
    }

    timeoutId = setTimeout(() => {
      applyState(followupReducers.setSuggestions(suggestions));
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

    const text = followupReducers.getAcceptText(currentState);
    if (text === null) {
      accepting = false;
      return;
    }

    applyState(followupReducers.clear());

    // Fire the callback asynchronously to avoid side-effects in state updates.
    // Use finally to guarantee the debounce lock is always released even if the
    // callback throws. Errors are logged rather than swallowed so bugs in
    // onAccept remain visible during development.
    queueMicrotask(() => {
      try {
        getOnAccept?.()?.(text);
      } catch (error: unknown) {
        // eslint-disable-next-line no-console
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
    applyState(followupReducers.clear());
  };

  const next = (): void => {
    const nextState = followupReducers.next(currentState);
    if (nextState) {
      applyState(nextState);
    }
  };

  const previous = (): void => {
    const prevState = followupReducers.previous(currentState);
    if (prevState) {
      applyState(prevState);
    }
  };

  const clear = (): void => {
    clearTimers();
    accepting = false;
    applyState(followupReducers.clear());
  };

  const cleanup = (): void => {
    clearTimers();
  };

  return { setSuggestions, accept, dismiss, next, previous, clear, cleanup };
}
