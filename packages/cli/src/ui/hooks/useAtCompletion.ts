/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  Config,
  FileSearch,
  FileSearchOptions,
} from '@qwen-code/qwen-code-core';
import {
  FileIndexService,
  FileSearchFactory,
  escapePath,
} from '@qwen-code/qwen-code-core';

/**
 * Builds the `FileSearchOptions` object used to key the `FileIndexService`
 * singleton. Shared between `useAtCompletion` (the hot search path) and
 * `AppContainer` (the startup pre-warm). Both sites MUST produce identical
 * option shapes — the key is a sha256 of the JSON of these fields, so a
 * field mismatch silently spawns a second worker that never gets a hit.
 * Keeping the derivation in one place is the guardrail against that drift.
 */
export function buildFileSearchOptions(
  config: Config | undefined,
  projectRoot: string,
): FileSearchOptions {
  return {
    projectRoot,
    ignoreDirs: [],
    useGitignore: config?.getFileFilteringOptions()?.respectGitIgnore ?? true,
    useQwenignore: config?.getFileFilteringOptions()?.respectQwenIgnore ?? true,
    cache: true,
    cacheTtl: 30,
    enableRecursiveFileSearch: config?.getEnableRecursiveFileSearch() ?? true,
    // `!== false` defaults to true when the getter returns undefined.
    enableFuzzySearch: config?.getFileFilteringEnableFuzzySearch() !== false,
  };
}
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import { MAX_SUGGESTIONS_TO_SHOW } from '../components/SuggestionsDisplay.js';

/**
 * Delay before replaying the current query against an updated partial
 * snapshot. Keeps us from burning work when fdir bursts hundreds of chunks
 * per second, but short enough that results feel live.
 */
const PARTIAL_REFRESH_THROTTLE_MS = 80;

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
  // Monotonic counter bumped on every REFRESH so effects depending on state
  // can re-run even when `status` and `pattern` stay the same (e.g. REFRESH
  // hits while we are already in SEARCHING).
  refreshToken: number;
}

type AtCompletionAction =
  | { type: 'INITIALIZE' }
  | { type: 'INITIALIZE_SUCCESS' }
  | { type: 'SEARCH'; payload: string }
  | { type: 'REFRESH' }
  | { type: 'SEARCH_SUCCESS'; payload: Suggestion[] }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'ERROR' }
  | { type: 'RESET' };

const initialState: AtCompletionState = {
  status: AtCompletionStatus.IDLE,
  suggestions: [],
  isLoading: false,
  pattern: null,
  refreshToken: 0,
};

function atCompletionReducer(
  state: AtCompletionState,
  action: AtCompletionAction,
): AtCompletionState {
  switch (action.type) {
    case 'INITIALIZE':
      // Don't flip isLoading here. The Worker effect arms a 200ms timer via
      // SET_LOADING so the "Loading suggestions..." placeholder only appears
      // when initialization is actually slow. For the common case — worker
      // already pre-warmed, first search resolves in <200ms — the picker
      // opens silently and fills in results without any loading flash.
      return { ...state, status: AtCompletionStatus.INITIALIZING };
    case 'INITIALIZE_SUCCESS':
      return { ...state, status: AtCompletionStatus.READY };
    case 'SEARCH':
      // Keep old suggestions, don't set loading immediately
      return {
        ...state,
        status: AtCompletionStatus.SEARCHING,
        pattern: action.payload,
      };
    case 'REFRESH':
      // Re-run the current pattern against a newly-grown snapshot. Only
      // meaningful when a pattern is active and we've finished the initial
      // load. Preserves pattern and isLoading. Bumps `refreshToken` so the
      // Worker effect observes a dep change even when status was already
      // SEARCHING (common: partial arrives while the first search is still
      // in flight, and without this bump the effect would not re-run).
      if (
        state.pattern === null ||
        (state.status !== AtCompletionStatus.READY &&
          state.status !== AtCompletionStatus.SEARCHING)
      ) {
        return state;
      }
      return {
        ...state,
        status: AtCompletionStatus.SEARCHING,
        refreshToken: state.refreshToken + 1,
      };
    case 'SEARCH_SUCCESS':
      return {
        ...state,
        status: AtCompletionStatus.READY,
        suggestions: action.payload,
        isLoading: false,
      };
    case 'SET_LOADING':
      // Only show loading if we are still working (initial crawl or an
      // in-flight search). Covering INITIALIZING lets the 200ms threshold
      // protect the initialization path too, so a genuinely slow cold start
      // still surfaces a spinner after the threshold rather than appearing
      // frozen.
      if (
        state.status === AtCompletionStatus.SEARCHING ||
        state.status === AtCompletionStatus.INITIALIZING
      ) {
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

  // Stable snapshot of the FileSearch options derived from config. The worker
  // effect and the partial-subscription effect below both depend on this;
  // memoising on `[config, cwd]` keeps the object reference stable across
  // renders so it can safely go in effect dependency arrays.
  const fileSearchOptions = useMemo(
    () => buildFileSearchOptions(config, cwd),
    [config, cwd],
  );

  // While the FileIndexService is still crawling, every new chunk expands the
  // searchable snapshot. Subscribing here lets us replay the active pattern
  // against the growing list so the user sees results progressively — similar
  // to Claude Code's behaviour — rather than waiting for the full crawl. The
  // subscription is bound to the project identity (cwd+config) rather than
  // the reducer status so that chunks arriving mid-search still drive a
  // REFRESH once the initial SEARCHING state completes.
  useEffect(() => {
    if (!fileSearchOptions.enableRecursiveFileSearch) return;

    const service = FileIndexService.for(fileSearchOptions);
    if (service.state === 'ready') return; // Nothing will stream anymore.

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = service.onPartial(() => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        dispatch({ type: 'REFRESH' });
      }, PARTIAL_REFRESH_THROTTLE_MS);
    });
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [fileSearchOptions]);

  // The "Worker" that performs async operations based on status.
  useEffect(() => {
    const initialize = async () => {
      // Arm the slow-load indicator for initialization too. In the normal
      // pre-warmed path this timer never fires (crawl completes instantly)
      // and the picker opens silently. On a cold start with a large tree
      // the user sees the spinner after 200ms instead of wondering if @
      // is broken.
      if (slowSearchTimer.current) {
        clearTimeout(slowSearchTimer.current);
      }
      slowSearchTimer.current = setTimeout(() => {
        dispatch({ type: 'SET_LOADING', payload: true });
      }, 200);
      try {
        const searcher = FileSearchFactory.create(fileSearchOptions);
        await searcher.initialize();
        if (slowSearchTimer.current) {
          clearTimeout(slowSearchTimer.current);
        }
        fileSearch.current = searcher;
        dispatch({ type: 'INITIALIZE_SUCCESS' });
        if (state.pattern !== null) {
          dispatch({ type: 'SEARCH', payload: state.pattern });
        }
      } catch (_) {
        if (slowSearchTimer.current) {
          clearTimeout(slowSearchTimer.current);
        }
        dispatch({ type: 'ERROR' });
      }
    };

    const search = async () => {
      if (!fileSearch.current || state.pattern === null) {
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

        const suggestions = results.map((p) => ({
          label: p,
          value: escapePath(p),
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
      searchAbortController.current?.abort();
      if (slowSearchTimer.current) {
        clearTimeout(slowSearchTimer.current);
      }
    };
    // `state.refreshToken` is included so REFRESH re-triggers a search
    // even when `state.status` was already SEARCHING from a previous call.
  }, [state.status, state.pattern, state.refreshToken, fileSearchOptions]);
}
