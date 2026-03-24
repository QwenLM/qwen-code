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
