/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useReducer, useRef } from 'react';
import type { Config, FileSearch } from '@qwen-code/qwen-code-core';
import { FileSearchFactory, escapePath } from '@qwen-code/qwen-code-core';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { MAX_SUGGESTIONS_TO_SHOW } from '../components/SuggestionsDisplay.js';
import { matchMcpServerPrefix, buildMcpResourceRef } from './mcpResourceRef.js';

/**
 * `@server:uri` MCP resource completion. Returns suggestions when `pattern`
 * is of the form `<server>:<partial>` and `<server>` is a configured MCP
 * server (so a plain file path containing ':' is never hijacked); returns
 * `null` otherwise to let the caller fall through to filesystem search.
 *
 * Matching is a case-sensitive substring on the URI (an empty partial matches
 * every resource — `'x'.includes('')` is `true`), with prefix matches ranked
 * above mid-string matches. The resource list comes from the post-discovery
 * `ResourceRegistry`, so an empty result before discovery completes simply
 * shows no suggestions.
 */
function getMcpResourceSuggestions(
  config: Config | undefined,
  pattern: string,
): Suggestion[] | null {
  if (!config) return null;
  // Don't surface resource URIs in an untrusted folder: the read path
  // (`ToolRegistry.readMcpResource`) is blocked there, so completing them
  // would both mislead and leak the existence of a server's resources.
  if (config.isTrustedFolder?.() === false) return null;
  // Shared longest-prefix match (see `matchMcpServerPrefix`) so the
  // completion path and the `@server:uri` injection path stay in lockstep.
  const mcpServers = config.getMcpServers?.() || {};
  const match = matchMcpServerPrefix(pattern, Object.keys(mcpServers));
  if (!match) return null;
  const serverName = match.serverName;
  const partialUri = match.rest;
  const resources =
    config.getResourceRegistry?.()?.getResourcesByServer(serverName) ?? [];
  const matches = resources
    .filter((r) => r.uri.includes(partialUri))
    .sort((a, b) => {
      // Rank URIs that start with the partial above mid-string matches,
      // then alphabetically for a stable order.
      const aPrefix = a.uri.startsWith(partialUri) ? 0 : 1;
      const bPrefix = b.uri.startsWith(partialUri) ? 0 : 1;
      return aPrefix - bPrefix || a.uri.localeCompare(b.uri);
    });
  return matches.slice(0, MAX_SUGGESTIONS_TO_SHOW * 3).map((r) => {
    const ref = buildMcpResourceRef(serverName, r.uri);
    return {
      label: ref,
      value: ref,
      isDirectory: false,
    };
  });
}

export enum AtCompletionStatus {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  SEARCHING = 'searching',
  ERROR = 'error',
}

interface AtCompletionState {
  status: AtCompletionStatus;
  suggestions: Suggestion[];
  isLoading: boolean;
  pattern: string | null;
}

type AtCompletionAction =
  | { type: 'INITIALIZE' }
  | { type: 'INITIALIZE_SUCCESS' }
  | { type: 'SEARCH'; payload: string }
  | { type: 'SEARCH_SUCCESS'; payload: Suggestion[] }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'ERROR' }
  | { type: 'RESET' };

const initialState: AtCompletionState = {
  status: AtCompletionStatus.IDLE,
  suggestions: [],
  isLoading: false,
  pattern: null,
};

function atCompletionReducer(
  state: AtCompletionState,
  action: AtCompletionAction,
): AtCompletionState {
  switch (action.type) {
    case 'INITIALIZE':
      return {
        ...state,
        status: AtCompletionStatus.INITIALIZING,
        isLoading: true,
      };
    case 'INITIALIZE_SUCCESS':
      return { ...state, status: AtCompletionStatus.READY, isLoading: false };
    case 'SEARCH':
      // Keep old suggestions, don't set loading immediately
      return {
        ...state,
        status: AtCompletionStatus.SEARCHING,
        pattern: action.payload,
      };
    case 'SEARCH_SUCCESS':
      return {
        ...state,
        status: AtCompletionStatus.READY,
        suggestions: action.payload,
        isLoading: false,
      };
    case 'SET_LOADING':
      // Only show loading if we are still in a searching state
      if (state.status === AtCompletionStatus.SEARCHING) {
        return { ...state, isLoading: action.payload, suggestions: [] };
      }
      return state;
    case 'ERROR':
      return {
        ...state,
        status: AtCompletionStatus.ERROR,
        isLoading: false,
        suggestions: [],
      };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

export interface UseAtCompletionProps {
  enabled: boolean;
  pattern: string;
  config: Config | undefined;
  cwd: string;
  setSuggestions: (suggestions: Suggestion[]) => void;
  setIsLoadingSuggestions: (isLoading: boolean) => void;
}

export function useAtCompletion(props: UseAtCompletionProps): void {
  const {
    enabled,
    pattern,
    config,
    cwd,
    setSuggestions,
    setIsLoadingSuggestions,
  } = props;
  const [state, dispatch] = useReducer(atCompletionReducer, initialState);
  const fileSearch = useRef<FileSearch | null>(null);
  const searchAbortController = useRef<AbortController | null>(null);
  const slowSearchTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setSuggestions(state.suggestions);
  }, [state.suggestions, setSuggestions]);

  useEffect(() => {
    setIsLoadingSuggestions(state.isLoading);
  }, [state.isLoading, setIsLoadingSuggestions]);

  useEffect(() => {
    dispatch({ type: 'RESET' });
    return () => {
      void fileSearch.current?.dispose?.();
      fileSearch.current = null;
    };
  }, [cwd, config]);

  // Reacts to user input (`pattern`) ONLY.
  useEffect(() => {
    if (!enabled) {
      // reset when first getting out of completion suggestions
      if (
        state.status === AtCompletionStatus.READY ||
        state.status === AtCompletionStatus.ERROR
      ) {
        dispatch({ type: 'RESET' });
      }
      return;
    }
    if (pattern === null) {
      dispatch({ type: 'RESET' });
      return;
    }

    if (state.status === AtCompletionStatus.IDLE) {
      dispatch({ type: 'INITIALIZE' });
    } else if (
      (state.status === AtCompletionStatus.READY ||
        state.status === AtCompletionStatus.SEARCHING) &&
      pattern !== state.pattern // Only search if the pattern has changed
    ) {
      dispatch({ type: 'SEARCH', payload: pattern });
    }
  }, [enabled, pattern, state.status, state.pattern]);

  // The "Worker" that performs async operations based on status.
  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      try {
        // Dispose previous instance to prevent worker thread leaks on
        // re-initialization (cwd/config change triggers RESET → re-init).
        await fileSearch.current?.dispose?.();
        fileSearch.current = null;

        const searcher = FileSearchFactory.create({
          projectRoot: cwd,
          ignoreDirs: [],
          useGitignore:
            config?.getFileFilteringOptions()?.respectGitIgnore ?? true,
          useQwenignore:
            config?.getFileFilteringOptions()?.respectQwenIgnore ?? true,
          cache: true,
          cacheTtl: 30, // 30 seconds
          enableRecursiveFileSearch:
            config?.getEnableRecursiveFileSearch() ?? true,
          // Use enableFuzzySearch with !== false to default to true when undefined.
          enableFuzzySearch:
            config?.getFileFilteringEnableFuzzySearch() !== false,
        });
        await searcher.initialize();
        // Guard against the effect being cleaned up (unmount / cwd change)
        // or superseded by a newer initialize() while we were awaiting.
        if (cancelled) {
          await searcher.dispose?.();
          return;
        }
        fileSearch.current = searcher;
        dispatch({ type: 'INITIALIZE_SUCCESS' });
        if (state.pattern !== null) {
          dispatch({ type: 'SEARCH', payload: state.pattern });
        }
      } catch (_) {
        if (!cancelled) {
          dispatch({ type: 'ERROR' });
        }
      }
    };

    const search = async () => {
      if (state.pattern === null) {
        return;
      }

      // `@server:uri` MCP resource completion short-circuits filesystem
      // search. Synchronous (in-memory registry), so no abort/slow-timer
      // machinery is needed.
      const resourceSuggestions = getMcpResourceSuggestions(
        config,
        state.pattern,
      );
      if (resourceSuggestions !== null) {
        if (slowSearchTimer.current) {
          clearTimeout(slowSearchTimer.current);
        }
        dispatch({ type: 'SEARCH_SUCCESS', payload: resourceSuggestions });
        return;
      }

      if (!fileSearch.current) {
        return;
      }

      if (slowSearchTimer.current) {
        clearTimeout(slowSearchTimer.current);
      }

      const controller = new AbortController();
      searchAbortController.current = controller;

      slowSearchTimer.current = setTimeout(() => {
        dispatch({ type: 'SET_LOADING', payload: true });
      }, 200);

      try {
        const results = await fileSearch.current.search(state.pattern, {
          signal: controller.signal,
          maxResults: MAX_SUGGESTIONS_TO_SHOW * 3,
        });

        if (slowSearchTimer.current) {
          clearTimeout(slowSearchTimer.current);
        }

        if (controller.signal.aborted) {
          return;
        }

        // isDirectory relies on crawler.ts in @qwen-code/qwen-code-core
        // always normalizing paths with posix '/' via fdir.withPathSeparator('/').
        // If the crawler ever switches to path.sep, this check must be updated.
        const suggestions = results.map((p) => ({
          label: p,
          value: escapePath(p),
          isDirectory: p.endsWith('/'),
        }));
        dispatch({ type: 'SEARCH_SUCCESS', payload: suggestions });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          dispatch({ type: 'ERROR' });
        }
      }
    };

    if (state.status === AtCompletionStatus.INITIALIZING) {
      initialize();
    } else if (state.status === AtCompletionStatus.SEARCHING) {
      search();
    }

    return () => {
      cancelled = true;
      searchAbortController.current?.abort();
      if (slowSearchTimer.current) {
        clearTimeout(slowSearchTimer.current);
      }
    };
  }, [state.status, state.pattern, config, cwd]);
}
