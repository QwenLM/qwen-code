/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import {
  getPathCompletions,
  isPathLikeToken,
  clearPathCache,
} from '../utils/directoryCompletion.js';

export interface UsePathCompletionProps {
  enabled: boolean;
  query: string | null;
  basePath: string;
  includeFiles?: boolean;
  includeHidden?: boolean;
  setSuggestions: (suggestions: Suggestion[]) => void;
  setIsLoadingSuggestions: (isLoading: boolean) => void;
}

const DEBOUNCE_MS = 100;

/**
 * Hook for path completion (file/directory paths).
 * Triggers when the query looks like a path (starts with /, ./, ../, ~/).
 */
export function usePathCompletion(props: UsePathCompletionProps): void {
  const {
    enabled,
    query,
    basePath,
    includeFiles = true,
    includeHidden = false,
    setSuggestions,
    setIsLoadingSuggestions,
  } = props;

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Perform path completion search
  useEffect(() => {
    if (!enabled || query === null || query === '' || !isPathLikeToken(query)) {
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    setIsLoadingSuggestions(true);

    timerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const results = await getPathCompletions(query, {
          basePath,
          maxResults: 24,
          includeFiles,
          includeHidden,
        });

        if (!controller.signal.aborted) {
          setSuggestions(results);
          setIsLoadingSuggestions(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setSuggestions([]);
          setIsLoadingSuggestions(false);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
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
  ]);

  // Clear cache when basePath changes (skip initial mount)
  const isFirstMount = useRef(true);
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    clearPathCache();
  }, [basePath]);
}
