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
import { t } from '../../i18n/index.js';

/**
 * `@server:uri` MCP resource completion. Returns suggestions when `pattern`
 * is of the form `<server>:<partial>` and `<server>` is a configured MCP
 * server (so a plain file path containing ':' is never hijacked); returns
 * `null` otherwise to let the caller fall through to filesystem search.
 *
 * The partial after the colon is matched case-INsensitively against each
 * resource's URI AND its friendly name/title (the same `title || name` the
 * `/mcp` dialog shows), so a user who only remembers the human-readable name —
 * not the URI — still gets completions. An empty partial matches every
 * resource (`''` is a prefix of every string). Ranking, best first: URI prefix,
 * then name/title prefix, then URI substring, then name/title substring; ties
 * break alphabetically by URI for a stable order.
 *
 * The injected `value` is always the canonical `@server:uri` reference (the
 * friendly name is not a referenceable identifier); the name rides along as the
 * suggestion `description` so a name-only match is self-explanatory. The
 * resource list comes from the post-discovery `ResourceRegistry`, so an empty
 * result before discovery completes simply shows no suggestions.
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
  const query = match.rest.toLowerCase();

  // Lower rank = better match; `Infinity` means no match and is filtered out.
  const rankOf = (uri: string, friendly: string): number => {
    if (uri.startsWith(query)) return 0;
    if (friendly.startsWith(query)) return 1;
    if (uri.includes(query)) return 2;
    if (friendly.includes(query)) return 3;
    return Infinity;
  };

  const resources =
    config.getResourceRegistry?.()?.getResourcesByServer(serverName) ?? [];
  const matches = resources
    .map((resource) => {
      const friendly = resource.title || resource.name || '';
      return {
        resource,
        friendly,
        rank: rankOf(resource.uri.toLowerCase(), friendly.toLowerCase()),
      };
    })
    .filter((m) => m.rank !== Infinity)
    .sort(
      (a, b) => a.rank - b.rank || a.resource.uri.localeCompare(b.resource.uri),
    );

  return matches.slice(0, MAX_SUGGESTIONS_TO_SHOW * 3).map((m) => {
    const ref = buildMcpResourceRef(serverName, m.resource.uri);
    return {
      label: ref,
      value: ref,
      // Only surface the friendly name when it adds information beyond the URI
      // (mirrors the `/mcp` resource list, which dims a redundant name).
      description:
        m.friendly && m.friendly !== m.resource.uri ? m.friendly : undefined,
      isDirectory: false,
    };
  });
}

/**
 * `@<partial>` MCP server discovery. BEFORE any `<server>:` has been typed,
 * surface configured MCP servers that (a) expose at least one resource and
 * (b) whose name starts (case-insensitively) with the partial, so a user who
 * doesn't know a resource URI can drill in without first memorizing the exact
 * server name.
 *
 * Returns `[]` (never `null`): these are PREPENDED to the filesystem results
 * rather than replacing them, so typing `@<partial>` never hides files. The
 * bare `@` trigger (empty partial) is intentionally left as a files-only view
 * — both to keep the common case unchanged and because every name
 * `.startsWith('')`, so an empty partial would otherwise match every server.
 *
 * Each suggestion expands to `@<server>:` and is flagged `isDirectory` so
 * `handleAutocomplete` appends no trailing space, letting completion re-trigger
 * straight into that server's resource list (the `getMcpResourceSuggestions`
 * path above).
 */
function getMcpServerSuggestions(
  config: Config | undefined,
  pattern: string,
): Suggestion[] {
  if (!config) return [];
  if (config.isTrustedFolder?.() === false) return [];
  if (pattern.length === 0) return [];
  const registry = config.getResourceRegistry?.();
  if (!registry) return [];
  const mcpServers = config.getMcpServers?.() || {};
  const query = pattern.toLowerCase();
  return Object.keys(mcpServers)
    .filter(
      (name) =>
        name.toLowerCase().startsWith(query) &&
        (registry.getResourcesByServer(name)?.length ?? 0) > 0,
    )
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      label: `${name}:`,
      value: `${name}:`,
      description: t('MCP resource server'),
      isDirectory: true,
    }));
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
          customIgnoreFiles:
            config?.getFileFilteringOptions()?.customIgnoreFiles,
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

      // No `<server>:` selected yet — offer matching MCP servers (that expose
      // resources) ALONGSIDE the filesystem results so the user can discover a
      // server without knowing a resource URI up front. Computed synchronously
      // and prepended below; never hides files.
      const serverSuggestions = getMcpServerSuggestions(config, state.pattern);

      if (!fileSearch.current) {
        // File index not ready yet; still surface any server matches so
        // discovery doesn't have to wait on the crawler.
        if (serverSuggestions.length > 0) {
          if (slowSearchTimer.current) {
            clearTimeout(slowSearchTimer.current);
          }
          dispatch({ type: 'SEARCH_SUCCESS', payload: serverSuggestions });
        }
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
        const fileSuggestions = results.map((p) => ({
          label: p,
          value: escapePath(p),
          isDirectory: p.endsWith('/'),
        }));
        dispatch({
          type: 'SEARCH_SUCCESS',
          payload: [...serverSuggestions, ...fileSuggestions],
        });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          // A file-search failure shouldn't swallow server matches we already
          // have; show those rather than dropping to an error state.
          if (serverSuggestions.length > 0) {
            dispatch({ type: 'SEARCH_SUCCESS', payload: serverSuggestions });
          } else {
            dispatch({ type: 'ERROR' });
          }
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
