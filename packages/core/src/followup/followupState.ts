/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared Follow-up Suggestions State Logic
 *
 * Framework-agnostic state management for prompt suggestions,
 * shared between CLI (Ink) and WebUI (React) hooks.
 */

/**
 * State for prompt suggestion display.
 */
export interface FollowupState {
  /** Current suggestion text */
  suggestion: string | null;
  /** Whether to show suggestion */
  isVisible: boolean;
  /** Timestamp when suggestion was shown (for telemetry) */
  shownAt: number;
}

/** Initial empty state */
export const INITIAL_FOLLOWUP_STATE: Readonly<FollowupState> = Object.freeze({
  suggestion: null,
  isVisible: false,
  shownAt: 0,
});

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
  /** Whether the feature is enabled (checked when setting suggestion) */
  enabled?: boolean;
  /** Called whenever the internal state changes */
  onStateChange: (state: FollowupState) => void;
  /**
   * Returns the current onAccept callback.
   * A getter is used so the controller always invokes the latest callback
   * without requiring re-creation when the callback reference changes.
   */
  getOnAccept?: () => ((text: string) => void) | undefined;
  /**
   * Called when a suggestion outcome is determined (accepted, ignored, suppressed).
   * Used for telemetry.
   */
  onOutcome?: (params: {
    outcome: 'accepted' | 'ignored';
    accept_method?: 'tab' | 'enter' | 'right';
    time_ms: number;
    suggestion_length: number;
  }) => void;
}

/**
 * Actions returned by createFollowupController.
 * These are stable (never change identity) and safe to call from any context.
 */
export interface FollowupControllerActions {
  /** Set suggestion text (with delayed show). Null clears immediately. */
  setSuggestion: (text: string | null) => void;
  /** Accept the current suggestion and invoke onAccept callback */
  accept: (method?: 'tab' | 'enter' | 'right') => void;
  /** Dismiss/clear suggestion */
  dismiss: () => void;
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
 */
export function createFollowupController(
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
    if (!enabled) {
      return;
    }

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (!text) {
      applyState(INITIAL_FOLLOWUP_STATE);
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
      // eslint-disable-next-line no-console
      console.error('[followup] onOutcome callback threw:', e);
    }

    applyState(INITIAL_FOLLOWUP_STATE);

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

    // Skip if already cleared (e.g., accept already ran)
    if (!currentState.isVisible && !currentState.suggestion) {
      return;
    }

    // Log ignored outcome if a suggestion was visible
    if (currentState.isVisible && currentState.suggestion) {
      try {
        onOutcome?.({
          outcome: 'ignored',
          time_ms:
            currentState.shownAt > 0 ? Date.now() - currentState.shownAt : 0,
          suggestion_length: currentState.suggestion.length,
        });
      } catch (e: unknown) {
        // eslint-disable-next-line no-console
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
