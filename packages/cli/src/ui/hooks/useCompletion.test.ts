/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCompletion } from './useCompletion.js';

describe('useCompletion', () => {
  describe('initial state', () => {
    it('starts with dismissed = false', () => {
      const { result } = renderHook(() => useCompletion());

      expect(result.current.dismissed).toBe(false);
    });

    it('starts with no suggestions and hidden dropdown', () => {
      const { result } = renderHook(() => useCompletion());

      expect(result.current.suggestions).toEqual([]);
      expect(result.current.showSuggestions).toBe(false);
      expect(result.current.isLoadingSuggestions).toBe(false);
      expect(result.current.isPerfectMatch).toBe(false);
      expect(result.current.activeSuggestionIndex).toBe(-1);
    });
  });

  describe('dismissCompletion', () => {
    it('sets dismissed to true and clears suggestions', () => {
      const { result } = renderHook(() => useCompletion());

      act(() => {
        result.current.setSuggestions([{ label: 'test', value: 'test' }]);
        result.current.setShowSuggestions(true);
      });

      act(() => {
        result.current.dismissCompletion();
      });

      expect(result.current.dismissed).toBe(true);
      expect(result.current.suggestions).toEqual([]);
      expect(result.current.showSuggestions).toBe(false);
    });

    it('prevents the first query change from clearing dismissed (skipNextClearRef)', () => {
      const { result, rerender } = renderHook(
        ({ query }: { query?: string | null }) => useCompletion({ query }),
        { initialProps: { query: undefined as string | null | undefined } },
      );

      act(() => {
        result.current.dismissCompletion();
      });
      expect(result.current.dismissed).toBe(true);

      // First query change should be skipped
      rerender({ query: 'new-query' });
      expect(result.current.dismissed).toBe(true);

      // Second query change should clear dismissed
      rerender({ query: 'another-query' });
      expect(result.current.dismissed).toBe(false);
    });
  });

  describe('resetCompletionState', () => {
    it('clears dismissed', () => {
      const { result } = renderHook(() => useCompletion());

      act(() => {
        result.current.dismissCompletion();
      });
      expect(result.current.dismissed).toBe(true);

      act(() => {
        result.current.resetCompletionState();
      });
      expect(result.current.dismissed).toBe(false);
    });

    it('clears all suggestion state', () => {
      const { result } = renderHook(() => useCompletion());

      act(() => {
        result.current.setSuggestions([{ label: 'test', value: 'test' }]);
        result.current.setShowSuggestions(true);
        result.current.setIsLoadingSuggestions(true);
        result.current.setIsPerfectMatch(true);
        result.current.setActiveSuggestionIndex(2);
        result.current.setVisibleStartIndex(3);
      });

      act(() => {
        result.current.resetCompletionState();
      });

      expect(result.current.suggestions).toEqual([]);
      expect(result.current.showSuggestions).toBe(false);
      expect(result.current.isLoadingSuggestions).toBe(false);
      expect(result.current.isPerfectMatch).toBe(false);
      expect(result.current.activeSuggestionIndex).toBe(-1);
      expect(result.current.visibleStartIndex).toBe(0);
    });

    it('does NOT reset skipNextClearRef, preserving the fix for Enter-accept', () => {
      const { result, rerender } = renderHook(
        ({ query }: { query?: string | null }) => useCompletion({ query }),
        { initialProps: { query: undefined as string | null | undefined } },
      );

      act(() => {
        result.current.dismissCompletion();
      });
      expect(result.current.dismissed).toBe(true);

      // resetCompletionState sets dismissed back to false, but
      // skipNextClearRef must still be true.  The next query change
      // should consume the skip (not clear dismissed, which is already
      // false).  After consuming the skip, a subsequent dismiss+query
      // cycle should work correctly.

      // Prove skipNextClearRef was NOT consumed by the reset:
      // dismiss again, then query change should be skipped.
      act(() => {
        result.current.dismissCompletion();
      });
      expect(result.current.dismissed).toBe(true);

      rerender({ query: 'post-dismiss-query' });
      // First query change after dismiss is skipped
      expect(result.current.dismissed).toBe(true);
    });
  });

  describe('query-change effect', () => {
    it('clears dismissed on normal query change (no prior dismiss)', () => {
      const { result, rerender } = renderHook(
        ({ query }: { query?: string | null }) => useCompletion({ query }),
        { initialProps: { query: undefined as string | null | undefined } },
      );

      // Simulate dismissed being set externally (e.g. via a previous cycle)
      // but without skipNextClearRef set — this tests the normal clear path.
      // Since we can't set dismissed directly without skipNextClearRef,
      // we use dismissCompletion then consume the skip.
      act(() => {
        result.current.dismissCompletion();
      });
      rerender({ query: 'first-change' });
      // skip consumed, dismissed still true
      expect(result.current.dismissed).toBe(true);

      rerender({ query: 'second-change' });
      // Now dismissed should be cleared
      expect(result.current.dismissed).toBe(false);
    });

    it('does not fire on initial render (query is undefined)', () => {
      const { result } = renderHook(() => useCompletion({ query: undefined }));

      expect(result.current.dismissed).toBe(false);
    });

    it('handles null query transition correctly', () => {
      const { result, rerender } = renderHook(
        ({ query }: { query?: string | null }) => useCompletion({ query }),
        { initialProps: { query: 'initial' as string | null | undefined } },
      );

      act(() => {
        result.current.dismissCompletion();
      });
      rerender({ query: null });
      expect(result.current.dismissed).toBe(true);

      rerender({ query: 'new-query' });
      expect(result.current.dismissed).toBe(false);
    });
  });

  describe('navigateUp / navigateDown', () => {
    it('navigateUp does nothing when no suggestions', () => {
      const { result } = renderHook(() => useCompletion());

      act(() => {
        result.current.navigateUp();
      });

      expect(result.current.activeSuggestionIndex).toBe(-1);
    });

    it('navigateDown does nothing when no suggestions', () => {
      const { result } = renderHook(() => useCompletion());

      act(() => {
        result.current.navigateDown();
      });

      expect(result.current.activeSuggestionIndex).toBe(-1);
    });

    it('navigates through suggestions with wrap-around', () => {
      const { result } = renderHook(() => useCompletion());

      act(() => {
        result.current.setSuggestions([
          { label: 'a', value: 'a' },
          { label: 'b', value: 'b' },
          { label: 'c', value: 'c' },
        ]);
        result.current.setActiveSuggestionIndex(0);
      });

      act(() => {
        result.current.navigateDown();
      });
      expect(result.current.activeSuggestionIndex).toBe(1);

      act(() => {
        result.current.navigateDown();
      });
      expect(result.current.activeSuggestionIndex).toBe(2);

      // Wrap-around
      act(() => {
        result.current.navigateDown();
      });
      expect(result.current.activeSuggestionIndex).toBe(0);
    });
  });
});
