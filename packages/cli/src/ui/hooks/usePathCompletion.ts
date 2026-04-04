/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import {
  getPathCompletions,
  isPathLikeToken,
  clearPathCache,
} from '../utils/directoryCompletion.js';

export interface UsePathCompletionReturn {
  suggestions: Suggestion[];
  isLoading: boolean;
  setSuggestions: (suggestions: Suggestion[]) => void;
  resetCompletionState: () => void;
}

export interface UsePathCompletionProps {
  enabled: boolean;
  query: string | null;
  basePath: string;
  includeFiles?: boolean;
  includeHidden?: boolean;
  setSuggestions: (suggestions: Suggestion[]) => void;
  setIsLoadingSuggestions: (isLoading: boolean) => void;
}

/**
 * Hook for path completion (file/directory paths).
 * Triggers when the query looks like a path (starts with /, ./, ../, ~/).
 */
export function usePathCompletion(
  props: UsePathCompletionProps,
): UsePathCompletionReturn {
  const {
    enabled,
    query,
    basePath,
    includeFiles = true,
    includeHidden = false,
    setSuggestions,
    setIsLoadingSuggestions,
  } = props;

  const [internalSuggestions, setInternalSuggestions] = useState<Suggestion[]>(
    [],
  );
  const [isLoading, setIsLoading] = useState(false);
  const searchAbortController = useRef<AbortController | null>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  // Track whether we are the active completion source
  const isActiveRef = useRef(false);

  const resetCompletionState = useCallback(() => {
    setInternalSuggestions([]);
    setIsLoading(false);
    // Only clear global suggestions if we are the active source
    if (isActiveRef.current) {
      setSuggestions([]);
      isActiveRef.current = false;
    }
    setIsLoadingSuggestions(false);
    if (searchAbortController.current) {
      searchAbortController.current.abort();
      searchAbortController.current = null;
    }
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
  }, [setSuggestions, setIsLoadingSuggestions]);

  // Perform path completion search
  useEffect(() => {
    if (!enabled || query === null || query === '') {
      resetCompletionState();
      return;
    }

    // Only trigger for path-like tokens
    if (!isPathLikeToken(query)) {
      resetCompletionState();
      return;
    }

    // Debounce to avoid excessive I/O
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    setIsLoading(true);
    setIsLoadingSuggestions(true);

    debounceTimer.current = setTimeout(async () => {
      const controller = new AbortController();
      searchAbortController.current = controller;

      try {
        const results = await getPathCompletions(query, {
          basePath,
          maxResults: 24, // MAX_SUGGESTIONS_TO_SHOW * 3
          includeFiles,
          includeHidden,
        });

        if (!controller.signal.aborted) {
          isActiveRef.current = true;
          setInternalSuggestions(results);
          setSuggestions(results);
          setIsLoading(false);
          setIsLoadingSuggestions(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          isActiveRef.current = false;
          setInternalSuggestions([]);
          setSuggestions([]);
          setIsLoading(false);
          setIsLoadingSuggestions(false);
        }
      }
    }, 100); // 100ms debounce

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      if (searchAbortController.current) {
        searchAbortController.current.abort();
        searchAbortController.current = null;
      }
    };
  }, [
    enabled,
    query,
    basePath,
    includeFiles,
    includeHidden,
    setSuggestions,
    setIsLoadingSuggestions,
    resetCompletionState,
  ]);

  // Clear cache when basePath changes (skip initial mount since caches are already empty)
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    clearPathCache();
  }, [basePath]);

  return {
    suggestions: internalSuggestions,
    isLoading,
    setSuggestions: setInternalSuggestions,
    resetCompletionState,
  };
}
