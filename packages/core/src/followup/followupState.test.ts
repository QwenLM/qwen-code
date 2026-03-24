/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { INITIAL_FOLLOWUP_STATE, followupReducers } from './followupState.js';
import type { FollowupState } from './followupState.js';

describe('followupReducers', () => {
  describe('setSuggestions', () => {
    it('sets suggestions and makes first one visible', () => {
      const result = followupReducers.setSuggestions([
        { text: 'commit this', priority: 100 },
        { text: 'run tests', priority: 90 },
      ]);
      expect(result.isVisible).toBe(true);
      expect(result.suggestion).toBe('commit this');
      expect(result.suggestions).toHaveLength(2);
      expect(result.currentIndex).toBe(0);
    });

    it('returns initial state for empty suggestions', () => {
      const result = followupReducers.setSuggestions([]);
      expect(result).toEqual(INITIAL_FOLLOWUP_STATE);
    });
  });

  describe('clear', () => {
    it('returns initial state', () => {
      expect(followupReducers.clear()).toEqual(INITIAL_FOLLOWUP_STATE);
    });
  });

  describe('next', () => {
    it('cycles to next suggestion', () => {
      const state: FollowupState = {
        suggestion: 'a',
        suggestions: [
          { text: 'a', priority: 100 },
          { text: 'b', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 0,
      };
      const result = followupReducers.next(state);
      expect(result).not.toBeNull();
      expect(result!.currentIndex).toBe(1);
      expect(result!.suggestion).toBe('b');
    });

    it('wraps around to first suggestion', () => {
      const state: FollowupState = {
        suggestion: 'b',
        suggestions: [
          { text: 'a', priority: 100 },
          { text: 'b', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 1,
      };
      const result = followupReducers.next(state);
      expect(result!.currentIndex).toBe(0);
      expect(result!.suggestion).toBe('a');
    });

    it('returns null for empty suggestions', () => {
      expect(followupReducers.next(INITIAL_FOLLOWUP_STATE)).toBeNull();
    });
  });

  describe('previous', () => {
    it('cycles to previous suggestion', () => {
      const state: FollowupState = {
        suggestion: 'b',
        suggestions: [
          { text: 'a', priority: 100 },
          { text: 'b', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 1,
      };
      const result = followupReducers.previous(state);
      expect(result!.currentIndex).toBe(0);
      expect(result!.suggestion).toBe('a');
    });

    it('wraps around to last suggestion', () => {
      const state: FollowupState = {
        suggestion: 'a',
        suggestions: [
          { text: 'a', priority: 100 },
          { text: 'b', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 0,
      };
      const result = followupReducers.previous(state);
      expect(result!.currentIndex).toBe(1);
      expect(result!.suggestion).toBe('b');
    });

    it('returns null for empty suggestions', () => {
      expect(followupReducers.previous(INITIAL_FOLLOWUP_STATE)).toBeNull();
    });
  });

  describe('getAcceptText', () => {
    it('returns current suggestion text', () => {
      const state: FollowupState = {
        suggestion: 'commit this',
        suggestions: [
          { text: 'commit this', priority: 100 },
          { text: 'run tests', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 0,
      };
      expect(followupReducers.getAcceptText(state)).toBe('commit this');
    });

    it('returns text at current index', () => {
      const state: FollowupState = {
        suggestion: 'run tests',
        suggestions: [
          { text: 'commit this', priority: 100 },
          { text: 'run tests', priority: 90 },
        ],
        isVisible: true,
        currentIndex: 1,
      };
      expect(followupReducers.getAcceptText(state)).toBe('run tests');
    });

    it('returns null for empty suggestions', () => {
      expect(followupReducers.getAcceptText(INITIAL_FOLLOWUP_STATE)).toBeNull();
    });

    it('returns null when index out of bounds', () => {
      const state: FollowupState = {
        suggestion: null,
        suggestions: [{ text: 'a', priority: 100 }],
        isVisible: true,
        currentIndex: 5,
      };
      expect(followupReducers.getAcceptText(state)).toBeNull();
    });
  });
});
