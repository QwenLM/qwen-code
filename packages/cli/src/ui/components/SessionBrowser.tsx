/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react';
import { Box, Text, useApp } from 'ink';
import { theme } from '../semantic-colors.js';
import { Colors } from '../colors.js';
import { figures } from '../utils/figures.js';
import { type ShortcutHint } from '../hooks/useContainerKeyboard.js';
import { Command } from '../key/keyMatchers.js';
import { isSingleLineTextInput } from '../key/textInput.js';
import type { Config } from '@qwen-code/core';
import type {
  SessionInfo,
  SessionScopes,
  SessionSelectionResult,
} from '../../utils/sessionUtils.js';
import {
  formatRelativeTime,
  SessionSelector,
} from '../../utils/sessionUtils.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import type { Key } from '../contexts/KeypressContext.js';
// Note: useRegisterHints is NOT used here because useSessionBrowserInput runs
// in the SessionBrowser parent component, OUTSIDE BaseTabDialog's
// HintRegistryProvider. Instead, hints are returned and passed to
// SessionBrowserView as extraHints prop for BTD.
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useI18nService } from '../i18n/index.js';

/**
 * Props for the main SessionBrowser component.
 */
export interface SessionBrowserProps {
  /** Application configuration object */
  config: Config;
  /** Git branch captured when the browser opens. */
  currentGitBranch?: string;
  /** Optional initial search query when opening the browser */
  initialSearchQuery?: string;
  /** Callback when user selects a session to resume */
  onResumeSession: (
    session: SessionInfo,
    resolvedSession?: SessionSelectionResult,
  ) => void;
  /** Callback when user deletes a session */
  onDeleteSession: (session: SessionInfo) => Promise<void>;
  /** Callback when user exits the session browser */
  onExit: () => void;
}

/**
 * Centralized state interface for SessionBrowser component.
 * Eliminates prop drilling by providing all state in a single object.
 */
export interface SessionBrowserState {
  // Data state
  /** Independently deduplicated current/all worktree sessions */
  sessionScopes: SessionScopes;
  /** Replace both loaded session scopes */
  setSessionScopes: React.Dispatch<React.SetStateAction<SessionScopes>>;
  /** Currently visible worktree scope */
  worktreeScope: WorktreeScope;
  /** Toggle current/all worktree scope and reset selection */
  toggleWorktreeScope: () => void;
  /** Resumable sessions in the active worktree scope */
  sessions: SessionInfo[];
  /** Current repository or all stored transcript projects. */
  projectScope: ProjectScope;
  /** Cached all-project sessions, loaded only after Ctrl+A. */
  allProjectSessions: SessionInfo[] | null;
  /** Update the cached all-project session list. */
  setAllProjectSessions: React.Dispatch<
    React.SetStateAction<SessionInfo[] | null>
  >;
  /** Change project scope and reset list selection. */
  selectProjectScope: (scope: ProjectScope) => void;
  /** Branch used by the current-branch filter. */
  currentGitBranch?: string;
  /** Currently visible branch scope. */
  branchScope: BranchScope;
  /** Toggle all/current branch scope and reset selection. */
  toggleBranchScope: () => void;
  /** Whether any resumable session exists in the same repository */
  hasAnyResumableSessions: boolean;
  /** Whether the all scope contains a resumable cross-worktree session */
  hasCrossWorktreeSessions: boolean;
  /** Sessions after filtering and sorting */
  filteredAndSortedSessions: SessionInfo[];
  /** Lazy-loaded preview for the selected session. */
  preview: SessionPreviewState | null;
  /** Update or close the selected session preview. */
  setPreview: React.Dispatch<React.SetStateAction<SessionPreviewState | null>>;

  // UI state
  /** Whether sessions are currently loading */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** Index of currently selected session */
  activeIndex: number;
  /** Current scroll offset for pagination */
  scrollOffset: number;
  /** Whether secondary session shortcuts are visible in the footer */
  showShortcutHelp: boolean;
  /** Session awaiting explicit deletion confirmation. */
  pendingDeleteSessionId: string | null;
  /** Whether the confirmed session is currently being deleted. */
  isDeletingSession: boolean;
  /** Raw deletion failure detail. */
  deleteError: string | null;

  // Search state
  /** Current search query string */
  searchQuery: string;
  /** Whether user is in search input mode */
  isSearchMode: boolean;
  /** Whether full content has been loaded for search */
  hasLoadedFullContent: boolean;

  // Sort state
  /** Current sort criteria */
  sortOrder: 'date' | 'messages' | 'name';
  /** Whether sort order is reversed */
  sortReverse: boolean;

  // Computed values
  /** Total number of filtered sessions */
  totalSessions: number;
  /** Start index for current page */
  startIndex: number;
  /** End index for current page */
  endIndex: number;
  /** Sessions visible on current page */
  visibleSessions: SessionInfo[];
  /** Number of sessions that fit in the current terminal height */
  sessionsPerPage: number;

  // State setters
  /** Update loading state */
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  /** Update error state */
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  /** Update active session index */
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Update scroll offset */
  setScrollOffset: React.Dispatch<React.SetStateAction<number>>;
  /** Show or hide secondary session shortcuts in the footer */
  setShowShortcutHelp: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingDeleteSessionId: React.Dispatch<
    React.SetStateAction<string | null>
  >;
  setIsDeletingSession: React.Dispatch<React.SetStateAction<boolean>>;
  setDeleteError: React.Dispatch<React.SetStateAction<string | null>>;
  /** Update search query */
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  /** Update search mode state */
  setIsSearchMode: React.Dispatch<React.SetStateAction<boolean>>;
  /** Update sort order */
  setSortOrder: React.Dispatch<
    React.SetStateAction<'date' | 'messages' | 'name'>
  >;
  /** Update sort reverse flag */
  setSortReverse: React.Dispatch<React.SetStateAction<boolean>>;
  setHasLoadedFullContent: React.Dispatch<React.SetStateAction<boolean>>;
}

export type WorktreeScope = 'current' | 'all';
export type BranchScope = 'all' | 'current';
export type ProjectScope = 'current-repo' | 'all-projects';

export interface SessionPreviewState {
  session: SessionInfo;
  loading: boolean;
  resolved?: SessionSelectionResult;
  error?: string;
}

const MAX_SESSIONS_PER_PAGE = 20;
const SESSION_BROWSER_RESERVED_ROWS = 13;
const SESSION_ITEM_ROW_HEIGHT = 3;
const SEARCH_SESSION_ITEM_ROW_HEIGHT = 4;
const PREFIX_COLUMN_WIDTH = 2;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(1).replace(/\.0$/, '')} KB`;
  }
  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(1).replace(/\.0$/, '')} MB`;
}

import {
  SearchModeDisplay,
  NoResultsDisplay,
} from './SessionBrowser/SessionBrowserNav.js';
import { SessionListHeader } from './SessionBrowser/SessionListHeader.js';
import { SessionBrowserLoading } from './SessionBrowser/SessionBrowserLoading.js';
import { SessionBrowserError } from './SessionBrowser/SessionBrowserError.js';
import { SessionBrowserEmpty } from './SessionBrowser/SessionBrowserEmpty.js';
import { SessionPreview } from './SessionBrowser/SessionPreview.js';
import {
  sortSessions,
  filterSessions,
  splitTextMatches,
} from './SessionBrowser/utils.js';

/**
 * Match snippet display component for search results.
 */
const MatchSnippetDisplay = ({
  session,
  textColor,
}: {
  session: SessionInfo;
  textColor: (color?: string) => string;
}): React.JSX.Element | null => {
  const i18n = useI18nService();
  if (!session.matchSnippets || session.matchSnippets.length === 0) {
    return null;
  }

  const firstMatch = session.matchSnippets[0];
  const rolePrefix =
    firstMatch.role === 'user'
      ? i18n.get('session.role.you')
      : i18n.get('session.role.model');
  const roleColor = textColor(
    firstMatch.role === 'user' ? Colors.AccentGreen : Colors.AccentBlue,
  );

  return (
    <Box
      flexDirection="row"
      flexWrap="nowrap"
      width="100%"
      height={1}
      overflow="hidden"
    >
      <Box
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        height={1}
        overflow="hidden"
      >
        <Text wrap="truncate-end">
          <Text color={roleColor} bold>
            {rolePrefix}{' '}
          </Text>
          {firstMatch.before}
          <Text color={textColor(Colors.AccentRed)} bold>
            {firstMatch.match}
          </Text>
          {firstMatch.after}
          {session.matchCount && session.matchCount > 1 && (
            <Text color={textColor(Colors.Gray)} bold={false}>
              {i18n.get('session.matches.more', {
                count: session.matchCount - 1,
              })}
            </Text>
          )}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Individual session row component.
 */
const SessionItem = ({
  session,
  state,
  formatRelativeTime,
}: {
  session: SessionInfo;
  state: SessionBrowserState;
  formatRelativeTime: (dateString: string, style: 'short' | 'long') => string;
}): React.JSX.Element => {
  const i18n = useI18nService();
  const originalIndex =
    state.startIndex + state.visibleSessions.indexOf(session);
  const isActive = originalIndex === state.activeIndex;
  const isDisabled = session.isCurrentSession;
  const textColor = (c: string = Colors.Foreground) => {
    if (isDisabled) {
      return Colors.Gray;
    }
    return isActive ? theme.ui.focus : c;
  };

  const prefix = isActive ? `${figures.pointer} ` : '  ';
  let titleSuffix = '';

  // Add "(current)" label for the current session
  if (session.isCurrentSession) {
    titleSuffix = ` ${i18n.get('session.current')}`;
  }

  // Mark loop sessions (CC behavior: isLoopSession)
  if (session.isLoopSession || session.firstUserMessage?.startsWith('/loop')) {
    titleSuffix += ` ${i18n.get('session.loop')}`;
  }

  const age = formatRelativeTime(session.lastUpdated, 'short');
  const size =
    session.fileSize === undefined
      ? i18n.get(
          session.messageCount === 1
            ? 'session.messageCount.one'
            : 'session.messageCount.other',
          { count: session.messageCount },
        )
      : formatFileSize(session.fileSize);
  const metadata = [age, session.gitBranch, size].filter(
    (value): value is string => Boolean(value),
  );

  // Show match snippets if searching and matches exist.
  // Keep the session title visible so body hits don't hide which session matched.
  const hasMatchSnippet =
    state.searchQuery &&
    session.matchSnippets &&
    session.matchSnippets.length > 0;

  return (
    <Box flexDirection="column" width="100%" overflow="hidden">
      <Box
        flexDirection="column"
        width="100%"
        overflow="hidden"
        backgroundColor={isActive ? theme.background.focus : undefined}
      >
        <Box
          flexDirection="row"
          flexWrap="nowrap"
          width="100%"
          height={1}
          overflow="hidden"
        >
          <Box width={PREFIX_COLUMN_WIDTH} flexShrink={0}>
            <Text color={textColor()} dimColor={isDisabled}>
              {prefix}
            </Text>
          </Box>
          <Box
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            minWidth={0}
            height={1}
            overflow="hidden"
          >
            <Text
              color={textColor(Colors.Comment)}
              dimColor={isDisabled}
              wrap="truncate-end"
            >
              {session.displayName.length === 0 ? (
                <Text color={textColor(Colors.Gray)} dimColor>
                  {i18n.get('session.noMessages')}
                </Text>
              ) : (
                splitTextMatches(session.displayName, state.searchQuery).map(
                  (segment, index) => (
                    <Text
                      key={`${session.displayName}-${index}-${segment.text}`}
                      color={
                        segment.isMatch
                          ? textColor(Colors.AccentRed)
                          : textColor(Colors.Comment)
                      }
                      bold={segment.isMatch}
                    >
                      {segment.text}
                    </Text>
                  ),
                )
              )}
              {titleSuffix && (
                <Text color={textColor(Colors.Gray)} dimColor bold={false}>
                  {titleSuffix}
                </Text>
              )}
            </Text>
          </Box>
        </Box>

        <Box
          flexDirection="row"
          flexWrap="nowrap"
          width="100%"
          height={1}
          overflow="hidden"
        >
          <Box width={PREFIX_COLUMN_WIDTH} flexShrink={0}>
            <Text color={textColor(Colors.Gray)} dimColor={isDisabled}>
              {' '.repeat(PREFIX_COLUMN_WIDTH)}
            </Text>
          </Box>
          <Text
            color={textColor(Colors.Gray)}
            dimColor={isDisabled}
            wrap="truncate-end"
          >
            {metadata.join(' · ')}
          </Text>
        </Box>

        {hasMatchSnippet && (
          <Box
            flexDirection="row"
            flexWrap="nowrap"
            width="100%"
            height={1}
            overflow="hidden"
          >
            <Box width={PREFIX_COLUMN_WIDTH} flexShrink={0}>
              <Text color={textColor(Colors.Gray)} dimColor={isDisabled}>
                {' '.repeat(PREFIX_COLUMN_WIDTH)}
              </Text>
            </Box>
            <MatchSnippetDisplay session={session} textColor={textColor} />
          </Box>
        )}
      </Box>

      <Text> </Text>
    </Box>
  );
};

/**
 * Session list container component.
 */
const SessionList = ({
  state,
  formatRelativeTime,
}: {
  state: SessionBrowserState;
  formatRelativeTime: (dateString: string, style: 'short' | 'long') => string;
}): React.JSX.Element => {
  const i18n = useI18nService();
  const selectedSession =
    state.filteredAndSortedSessions[state.activeIndex] ?? null;
  const selectedPath =
    selectedSession?.displayProjectPath ??
    selectedSession?.transcriptProjectRoot ??
    selectedSession?.sourceWorktreePath;

  return (
    <Box flexDirection="column">
      {(state.projectScope === 'all-projects' ||
        state.worktreeScope === 'all') &&
        selectedPath && (
          <Box flexDirection="row" width="100%">
            <Box flexShrink={0}>
              <Text color={Colors.AccentPurple}>
                {i18n.get('session.path')}{' '}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              <Text color={Colors.Foreground} wrap="truncate-start">
                {selectedPath}
              </Text>
            </Box>
          </Box>
        )}

      {state.scrollOffset > 0 && <Text color={Colors.Gray}>▲</Text>}

      <Text> </Text>

      {state.visibleSessions.map((session) => (
        <SessionItem
          key={session.id}
          session={session}
          state={state}
          formatRelativeTime={formatRelativeTime}
        />
      ))}

      <Text color={Colors.Gray}>
        {state.endIndex < state.totalSessions ? (
          <>▼</>
        ) : (
          <Text dimColor>▼</Text>
        )}
      </Text>
    </Box>
  );
};

/**
 * Hook to manage all SessionBrowser state.
 */
export const useSessionBrowserState = (
  initialSessions: SessionInfo[] = [],
  initialLoading = true,
  initialError: string | null = null,
  initialSearchQuery = '',
  initialAllSessions: SessionInfo[] = initialSessions,
  currentGitBranch?: string,
  initialAllProjectSessions: SessionInfo[] | null = null,
): SessionBrowserState => {
  const [sessionScopes, setSessionScopes] = useState<SessionScopes>({
    current: initialSessions,
    all: initialAllSessions,
  });
  const [worktreeScope, setWorktreeScope] = useState<WorktreeScope>('current');
  const [projectScope, setProjectScope] =
    useState<ProjectScope>('current-repo');
  const [allProjectSessions, setAllProjectSessions] = useState<
    SessionInfo[] | null
  >(initialAllProjectSessions);
  const [branchFilter] = useState(currentGitBranch);
  const [branchScope, setBranchScope] = useState<BranchScope>('all');
  const [loading, setLoading] = useState(initialLoading);
  const [error, setError] = useState<string | null>(initialError);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [sortOrder, setSortOrder] = useState<'date' | 'messages' | 'name'>(
    'date',
  );
  const [sortReverse, setSortReverse] = useState(false);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<
    string | null
  >(null);
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [hasLoadedFullContent, setHasLoadedFullContent] = useState(false);
  const [preview, setPreview] = useState<SessionPreviewState | null>(null);
  const { rows: terminalRows } = useTerminalSize();

  const resumableSessionScopes = useMemo<SessionScopes>(
    () => ({
      current: sessionScopes.current.filter(
        (session) => !session.isCurrentSession,
      ),
      all: sessionScopes.all.filter((session) => !session.isCurrentSession),
    }),
    [sessionScopes],
  );
  const resumableAllProjectSessions = useMemo(
    () =>
      (allProjectSessions ?? []).filter((session) => !session.isCurrentSession),
    [allProjectSessions],
  );
  const sessions =
    projectScope === 'all-projects'
      ? resumableAllProjectSessions
      : resumableSessionScopes[worktreeScope];
  const hasAnyResumableSessions =
    resumableSessionScopes.all.length > 0 ||
    resumableAllProjectSessions.length > 0;
  const hasCrossWorktreeSessions = resumableSessionScopes.all.some(
    (session) => session.sourceWorktreePath,
  );

  const toggleWorktreeScope = useCallback(() => {
    if (!hasCrossWorktreeSessions) return;
    setWorktreeScope((scope) => (scope === 'current' ? 'all' : 'current'));
    setActiveIndex(0);
    setScrollOffset(0);
  }, [hasCrossWorktreeSessions]);

  const selectProjectScope = useCallback((scope: ProjectScope) => {
    setProjectScope(scope);
    setActiveIndex(0);
    setScrollOffset(0);
  }, []);

  const toggleBranchScope = useCallback(() => {
    if (!branchFilter) return;
    setBranchScope((scope) => (scope === 'all' ? 'current' : 'all'));
    setActiveIndex(0);
    setScrollOffset(0);
  }, [branchFilter]);

  const filteredAndSortedSessions = useMemo(() => {
    const branchFilteredSessions =
      branchScope === 'current' && branchFilter
        ? sessions.filter((session) => session.gitBranch === branchFilter)
        : sessions;
    const filtered = filterSessions(branchFilteredSessions, searchQuery);
    return sortSessions(filtered, sortOrder, sortReverse);
  }, [
    sessions,
    branchScope,
    branchFilter,
    searchQuery,
    sortOrder,
    sortReverse,
  ]);

  // Reset full content flag when search is cleared
  useEffect(() => {
    if (!searchQuery) {
      setHasLoadedFullContent(false);
    }
  }, [searchQuery]);

  const totalSessions = filteredAndSortedSessions.length;
  const sessionItemRowHeight = searchQuery
    ? SEARCH_SESSION_ITEM_ROW_HEIGHT
    : SESSION_ITEM_ROW_HEIGHT;
  const sessionsPerPage = Math.max(
    1,
    Math.min(
      MAX_SESSIONS_PER_PAGE,
      Math.floor(
        (terminalRows - SESSION_BROWSER_RESERVED_ROWS) / sessionItemRowHeight,
      ),
    ),
  );

  useEffect(() => {
    setActiveIndex((currentIndex) =>
      Math.max(0, Math.min(currentIndex, totalSessions - 1)),
    );
  }, [totalSessions]);

  useEffect(() => {
    setScrollOffset((currentOffset) => {
      const maxOffset = Math.max(0, totalSessions - sessionsPerPage);
      let nextOffset = Math.min(currentOffset, maxOffset);

      if (activeIndex < nextOffset) {
        nextOffset = activeIndex;
      } else if (activeIndex >= nextOffset + sessionsPerPage) {
        nextOffset = activeIndex - sessionsPerPage + 1;
      }

      return Math.max(0, nextOffset);
    });
  }, [activeIndex, sessionsPerPage, totalSessions]);

  const startIndex = scrollOffset;
  const endIndex = Math.min(scrollOffset + sessionsPerPage, totalSessions);
  const visibleSessions = filteredAndSortedSessions.slice(startIndex, endIndex);

  const state: SessionBrowserState = {
    sessionScopes,
    setSessionScopes,
    worktreeScope,
    toggleWorktreeScope,
    sessions,
    projectScope,
    allProjectSessions,
    setAllProjectSessions,
    selectProjectScope,
    currentGitBranch: branchFilter,
    branchScope,
    toggleBranchScope,
    hasAnyResumableSessions,
    hasCrossWorktreeSessions,
    loading,
    setLoading,
    error,
    setError,
    activeIndex,
    setActiveIndex,
    scrollOffset,
    setScrollOffset,
    showShortcutHelp,
    setShowShortcutHelp,
    pendingDeleteSessionId,
    setPendingDeleteSessionId,
    isDeletingSession,
    setIsDeletingSession,
    deleteError,
    setDeleteError,
    searchQuery,
    setSearchQuery,
    isSearchMode,
    setIsSearchMode,
    hasLoadedFullContent,
    setHasLoadedFullContent,
    sortOrder,
    setSortOrder,
    sortReverse,
    setSortReverse,
    filteredAndSortedSessions,
    preview,
    setPreview,
    totalSessions,
    startIndex,
    endIndex,
    visibleSessions,
    sessionsPerPage,
  };

  return state;
};

/**
 * Hook to load sessions on mount.
 */
const useLoadSessions = (
  config: Config,
  state: SessionBrowserState,
): {
  reloadVisibleSessions: () => Promise<void>;
  toggleProjectScope: () => Promise<void>;
} => {
  const {
    setSessionScopes,
    projectScope,
    allProjectSessions,
    setAllProjectSessions,
    selectProjectScope,
    setLoading,
    setError,
    searchQuery,
    sortOrder,
    hasLoadedFullContent,
    setHasLoadedFullContent,
  } = state;

  const loadSessionScopes = useCallback(
    async (includeFullContent: boolean) => {
      const sessionSelector = new SessionSelector(config);
      const scopes = await sessionSelector.listSessionScopes({
        includeFullContent,
      });
      setSessionScopes(scopes);
    },
    [config, setSessionScopes],
  );

  const loadAllProjectSessions = useCallback(
    async (includeFullContent: boolean) => {
      const sessions = await new SessionSelector(config).listAllProjectSessions(
        { includeFullContent },
      );
      setAllProjectSessions(sessions);
    },
    [config, setAllProjectSessions],
  );

  const loadVisibleSessions = useCallback(
    async (includeFullContent: boolean) => {
      if (projectScope === 'all-projects') {
        await loadAllProjectSessions(includeFullContent);
      } else {
        await loadSessionScopes(includeFullContent);
      }
    },
    [projectScope, loadAllProjectSessions, loadSessionScopes],
  );

  useEffect(() => {
    const loadSessions = async () => {
      try {
        await loadSessionScopes(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    loadSessions();
  }, [loadSessionScopes, setLoading, setError]);

  useEffect(() => {
    const loadFullContent = async () => {
      const needsFullSessionDetails =
        searchQuery.trim().length > 0 || sortOrder === 'messages';
      if (needsFullSessionDetails && !hasLoadedFullContent) {
        try {
          await loadVisibleSessions(true);
          setHasLoadedFullContent(true);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    loadFullContent();
  }, [
    searchQuery,
    sortOrder,
    hasLoadedFullContent,
    loadVisibleSessions,
    setHasLoadedFullContent,
    setError,
  ]);

  const reloadVisibleSessions = useCallback(async () => {
    try {
      await loadVisibleSessions(hasLoadedFullContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [hasLoadedFullContent, loadVisibleSessions, setError]);

  const toggleProjectScope = useCallback(async () => {
    if (projectScope === 'all-projects') {
      selectProjectScope('current-repo');
      setHasLoadedFullContent(false);
      return;
    }

    const includeFullContent = searchQuery.trim().length > 0;
    setLoading(true);
    setError(null);
    try {
      if (allProjectSessions === null || includeFullContent) {
        await loadAllProjectSessions(includeFullContent);
      }
      selectProjectScope('all-projects');
      setHasLoadedFullContent(includeFullContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [
    projectScope,
    searchQuery,
    allProjectSessions,
    loadAllProjectSessions,
    selectProjectScope,
    setHasLoadedFullContent,
    setLoading,
    setError,
  ]);

  return { reloadVisibleSessions, toggleProjectScope };
};

/**
 * Hook to handle selection movement.
 */
export const useMoveSelection = (state: SessionBrowserState) => {
  const {
    totalSessions,
    activeIndex,
    scrollOffset,
    sessionsPerPage,
    setActiveIndex,
    setScrollOffset,
  } = state;

  return useCallback(
    (delta: number) => {
      const newIndex = Math.max(
        0,
        Math.min(totalSessions - 1, activeIndex + delta),
      );
      setActiveIndex(newIndex);

      // Adjust scroll offset if needed
      if (newIndex < scrollOffset) {
        setScrollOffset(newIndex);
      } else if (newIndex >= scrollOffset + sessionsPerPage) {
        setScrollOffset(newIndex - sessionsPerPage + 1);
      }
    },
    [
      totalSessions,
      activeIndex,
      scrollOffset,
      sessionsPerPage,
      setActiveIndex,
      setScrollOffset,
    ],
  );
};

/**
 * Hook to handle sort order cycling.
 */
export const useCycleSortOrder = (state: SessionBrowserState) => {
  const { sortOrder, setSortOrder } = state;

  return useCallback(() => {
    const orders: Array<'date' | 'messages' | 'name'> = [
      'date',
      'messages',
      'name',
    ];
    const currentIndex = orders.indexOf(sortOrder);
    const nextIndex = (currentIndex + 1) % orders.length;
    setSortOrder(orders[nextIndex]);
  }, [sortOrder, setSortOrder]);
};

/**
 * Hook to handle SessionBrowser input.
 *
 * Registers action handlers and fallback handlers on the Dialog context
 * directly via context routing.
 *
 * Returns the active hints array so the caller can pass it to
 * SessionBrowserView (which forwards it as BTD's `extraHints` prop).
 * We can't use useRegisterHints here because this hook runs OUTSIDE
 * BaseTabDialog's HintRegistryProvider.
 */
export const useSessionBrowserInput = (
  state: SessionBrowserState,
  moveSelection: (delta: number) => void,
  cycleSortOrder: () => void,
  onResumeSession: (
    session: SessionInfo,
    resolvedSession?: SessionSelectionResult,
  ) => void,
  onDeleteSession: (session: SessionInfo) => Promise<void>,
  reloadVisibleSessions: () => Promise<void>,
  toggleProjectScope: () => Promise<void>,
  resolveSelectedSession: (
    session: SessionInfo,
    signal?: AbortSignal,
  ) => Promise<SessionSelectionResult>,
  onExit: () => void,
): ShortcutHint[] => {
  const keyMatchers = useKeyMatchers();
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const deleteInFlightRef = useRef(false);
  /** 预览解析代次：关闭/切换/确认后，迟到结果不再接管，并归还其恢复租约。 */
  const previewRequestRef = useRef(0);
  const previewOwnerRef = useRef<{
    controller: AbortController;
    resolved?: SessionSelectionResult;
  } | null>(null);
  const cancelPreview = useCallback(() => {
    previewRequestRef.current++;
    const owner = previewOwnerRef.current;
    previewOwnerRef.current = null;
    owner?.controller.abort();
    owner?.resolved?.resumeAttempt?.finish();
  }, []);
  useEffect(() => cancelPreview, [cancelPreview]);

  const confirmDelete = useCallback(() => {
    if (!state.pendingDeleteSessionId || deleteInFlightRef.current) return;
    const selectedSession = state.filteredAndSortedSessions.find(
      (session) => session.id === state.pendingDeleteSessionId,
    );
    if (!selectedSession || selectedSession.isCurrentSession) {
      state.setPendingDeleteSessionId(null);
      return;
    }

    deleteInFlightRef.current = true;
    state.setIsDeletingSession(true);
    state.setDeleteError(null);
    void onDeleteSession(selectedSession)
      .then(async () => {
        await reloadVisibleSessions();
        state.setPendingDeleteSessionId(null);
      })
      .catch((error) => {
        state.setDeleteError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        deleteInFlightRef.current = false;
        state.setIsDeletingSession(false);
      });
  }, [state, onDeleteSession, reloadVisibleSessions]);

  const previewHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'dialog:confirm': () => {
        if (state.preview?.resolved) {
          const { session, resolved } = state.preview;
          previewRequestRef.current++;
          // 确认后由恢复流程持有租约，卸载预览不能再取消它。
          previewOwnerRef.current = null;
          // 预览租约超过恢复时限会自行失效；此时重新解析，不能把已结束的 attempt
          // 当作仍可接管的候选交给恢复流程。
          if (resolved.resumeAttempt?.signal.aborted) {
            onResumeSession(session);
          } else {
            onResumeSession(session, resolved);
          }
        }
        return true;
      },
      'dialog:escape': () => {
        cancelPreview();
        state.setPreview(null);
        return true;
      },
    }),
    [state, onResumeSession, cancelPreview],
  );

  useRegisterActionHandlers('Dialog', previewHandlers, !!state.preview);

  // ---- Search mode action handlers ----
  const searchHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'dialog:confirm': () => {
        const selectedSession =
          state.filteredAndSortedSessions[state.activeIndex];
        if (selectedSession && !selectedSession.isCurrentSession) {
          onResumeSession(selectedSession);
        }
        return true;
      },
      'dialog:escape': () => {
        state.setIsSearchMode(false);
        state.setSearchQuery('');
        state.setActiveIndex(0);
        state.setScrollOffset(0);
        return true;
      },
      'dialog:navigate:up': () => {
        moveSelection(-1);
        return true;
      },
      'dialog:navigate:down': () => {
        moveSelection(1);
        return true;
      },
      'scroll:pageUp': () => {
        moveSelection(-state.sessionsPerPage);
        return true;
      },
      'scroll:pageDown': () => {
        moveSelection(state.sessionsPerPage);
        return true;
      },
    }),
    [state, moveSelection, onResumeSession],
  );

  useRegisterActionHandlers(
    'Dialog',
    searchHandlers,
    state.isSearchMode && !state.preview,
  );

  // Search mode rawHandlers → fallback
  const searchFallback = useCallback(
    (key: Key) => {
      if (key.name === 'backspace') {
        state.setSearchQuery((prev) => prev.slice(0, -1));
        state.setActiveIndex(0);
        state.setScrollOffset(0);
        return true;
      }
      if (isSingleLineTextInput(key)) {
        state.setSearchQuery((prev) => prev + key.sequence);
        state.setActiveIndex(0);
        state.setScrollOffset(0);
        return true;
      }
      return false;
    },
    [state],
  );

  useRegisterFallbackHandler(
    'Dialog',
    searchFallback,
    state.isSearchMode && !state.preview,
  );

  // Search mode hints
  const searchHints = useMemo(
    (): ShortcutHint[] => [
      {
        label: getUiText('session.hint.navigate'),
        order: 10,
        command: Command.DIALOG_NAVIGATION_UP,
      },
      {
        label: getUiText('session.hint.select'),
        order: 20,
        command: Command.RETURN,
      },
      {
        label: getUiText('session.search.cancel'),
        order: 100,
        command: Command.ESCAPE,
      },
    ],
    [getUiText],
  );

  // (searchHints will be returned below — not registered via useRegisterHints
  // because this hook runs outside BTD's HintRegistryProvider)

  // ---- Navigation mode action handlers ----
  const navHandlers = useMemo<Record<string, ActionHandler>>(
    () => ({
      'dialog:escape': () => {
        if (state.pendingDeleteSessionId) {
          if (deleteInFlightRef.current) return true;
          state.setPendingDeleteSessionId(null);
          state.setDeleteError(null);
          return true;
        }
        onExit();
        return true;
      },
      'dialog:confirm': () => {
        if (state.pendingDeleteSessionId) {
          confirmDelete();
          return true;
        }
        const selectedSession =
          state.filteredAndSortedSessions[state.activeIndex];
        if (selectedSession && !selectedSession.isCurrentSession) {
          onResumeSession(selectedSession);
        }
        return true;
      },
      'dialog:navigate:up': () => {
        moveSelection(-1);
        return true;
      },
      'dialog:navigate:down': () => {
        moveSelection(1);
        return true;
      },
      'scroll:pageUp': () => {
        moveSelection(-state.sessionsPerPage);
        return true;
      },
      'scroll:pageDown': () => {
        moveSelection(state.sessionsPerPage);
        return true;
      },
    }),
    [state, moveSelection, onResumeSession, onExit, confirmDelete],
  );

  useRegisterActionHandlers(
    'Dialog',
    navHandlers,
    !state.isSearchMode && !state.preview,
  );

  // Navigation mode rawHandlers → fallback (letter shortcuts)
  const navFallback = useCallback(
    (key: Key) => {
      if (state.pendingDeleteSessionId || state.isDeletingSession) {
        return true;
      }
      if (keyMatchers[Command.SESSION_TOGGLE_PROJECT_SCOPE](key)) {
        void toggleProjectScope();
        return true;
      }
      if (
        state.currentGitBranch &&
        keyMatchers[Command.SESSION_TOGGLE_BRANCH_SCOPE](key)
      ) {
        state.toggleBranchScope();
        return true;
      }
      if (keyMatchers[Command.SESSION_PREVIEW](key)) {
        const selectedSession =
          state.filteredAndSortedSessions[state.activeIndex];
        if (!selectedSession) return true;

        // 换预览前归还上一次解析结果占用的恢复名额。
        cancelPreview();
        const owner: NonNullable<typeof previewOwnerRef.current> = {
          controller: new AbortController(),
        };
        previewOwnerRef.current = owner;
        const request = ++previewRequestRef.current;
        state.setPreview({ session: selectedSession, loading: true });
        void resolveSelectedSession(selectedSession, owner.controller.signal)
          .then((resolved) => {
            if (previewRequestRef.current !== request) {
              resolved.resumeAttempt?.finish();
              return;
            }
            owner.resolved = resolved;
            state.setPreview({
              session: selectedSession,
              loading: false,
              resolved,
            });
          })
          .catch((error) => {
            if (previewRequestRef.current !== request) return;
            state.setPreview({
              session: selectedSession,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return true;
      }
      if (
        state.hasCrossWorktreeSessions &&
        keyMatchers[Command.SESSION_TOGGLE_WORKTREE_SCOPE](key)
      ) {
        state.toggleWorktreeScope();
        return true;
      }
      if (
        state.sessions.length > 0 &&
        keyMatchers[Command.SESSION_TOGGLE_SHORTCUT_HELP](key)
      ) {
        state.setShowShortcutHelp((visible) => !visible);
        return true;
      }
      if (key.sequence === 'g') {
        state.setActiveIndex(0);
        state.setScrollOffset(0);
        return true;
      }
      if (key.sequence === 'G') {
        state.setActiveIndex(Math.max(0, state.totalSessions - 1));
        state.setScrollOffset(
          Math.max(0, state.totalSessions - state.sessionsPerPage),
        );
        return true;
      }
      if (key.sequence === 's') {
        cycleSortOrder();
        return true;
      }
      if (key.sequence === 'r') {
        state.setSortReverse(!state.sortReverse);
        return true;
      }
      if (key.sequence === '/') {
        state.setIsSearchMode(true);
        return true;
      }
      if (key.sequence === 'q' || key.sequence === 'Q') {
        onExit();
        return true;
      }
      if (key.sequence === 'x' || key.sequence === 'X') {
        const selectedSession =
          state.filteredAndSortedSessions[state.activeIndex];
        if (selectedSession && !selectedSession.isCurrentSession) {
          state.setPendingDeleteSessionId(selectedSession.id);
          state.setDeleteError(null);
        }
        return true;
      }
      if (key.sequence === 'u') {
        moveSelection(-Math.round(state.sessionsPerPage / 2));
        return true;
      }
      if (key.sequence === 'd') {
        moveSelection(Math.round(state.sessionsPerPage / 2));
        return true;
      }
      return false;
    },
    [
      state,
      moveSelection,
      cycleSortOrder,
      toggleProjectScope,
      resolveSelectedSession,
      cancelPreview,
      onExit,
      keyMatchers,
    ],
  );

  useRegisterFallbackHandler(
    'Dialog',
    navFallback,
    !state.isSearchMode && !state.preview,
  );

  // Navigation mode hints
  const navHints = useMemo((): ShortcutHint[] => {
    const hints: ShortcutHint[] =
      state.sessions.length > 0
        ? state.showShortcutHelp
          ? [
              {
                label: getUiText('session.hint.sortReverse'),
                order: 10,
              },
              { label: getUiText('session.hint.delete'), order: 20 },
              {
                label: getUiText('session.hint.firstLast'),
                order: 30,
              },
              {
                label: getUiText('session.hint.halfPage'),
                order: 40,
              },
              {
                label: getUiText('session.hint.hideShortcuts'),
                order: 50,
                command: Command.SESSION_TOGGLE_SHORTCUT_HELP,
              },
            ]
          : [
              {
                label: getUiText('session.hint.navigate'),
                order: 50,
                command: Command.DIALOG_NAVIGATION_UP,
              },
              {
                label: getUiText('session.hint.select'),
                order: 60,
                command: Command.RETURN,
              },
              { label: getUiText('session.hint.search'), order: 70 },
              {
                label: getUiText('session.hint.shortcuts'),
                order: 80,
                command: Command.SESSION_TOGGLE_SHORTCUT_HELP,
              },
            ]
        : [];

    if (!state.showShortcutHelp) {
      hints.push({
        label:
          state.projectScope === 'current-repo'
            ? getUiText('session.hint.allProjects')
            : getUiText('session.hint.currentRepo'),
        order: 10,
        command: Command.SESSION_TOGGLE_PROJECT_SCOPE,
      });
    }

    if (state.hasCrossWorktreeSessions && !state.showShortcutHelp) {
      hints.push({
        label:
          state.worktreeScope === 'current'
            ? getUiText('session.hint.allWorktrees')
            : getUiText('session.hint.currentWorktree'),
        order: 30,
        command: Command.SESSION_TOGGLE_WORKTREE_SCOPE,
      });
    }

    if (state.currentGitBranch && !state.showShortcutHelp) {
      hints.push({
        label:
          state.branchScope === 'all'
            ? getUiText('session.hint.currentBranch')
            : getUiText('session.hint.allBranches'),
        order: 20,
        command: Command.SESSION_TOGGLE_BRANCH_SCOPE,
      });
    }

    if (state.sessions.length > 0 && !state.showShortcutHelp) {
      hints.push({
        label: getUiText('session.hint.preview'),
        order: 40,
        command: Command.SESSION_PREVIEW,
      });
    }

    hints.push({
      label: getUiText('session.hint.close'),
      order: 100,
      command: Command.ESCAPE,
    });

    return hints;
  }, [
    state.hasCrossWorktreeSessions,
    state.projectScope,
    state.currentGitBranch,
    state.branchScope,
    state.sessions.length,
    state.showShortcutHelp,
    state.worktreeScope,
    getUiText,
  ]);

  // (navHints returned below — not registered via useRegisterHints
  // because this hook runs outside BTD's HintRegistryProvider)

  const previewHints = useMemo((): ShortcutHint[] => {
    const hints: ShortcutHint[] = [];
    if (state.preview?.resolved) {
      hints.push({
        label: getUiText('session.hint.resume'),
        order: 10,
        command: Command.RETURN,
      });
    }
    hints.push({
      label: state.preview?.error
        ? getUiText('session.hint.goBack')
        : getUiText('session.hint.cancel'),
      order: 100,
      command: Command.ESCAPE,
    });
    return hints;
  }, [state.preview, getUiText]);

  if (state.pendingDeleteSessionId) {
    if (state.isDeletingSession) return [];
    return [
      {
        label: i18n.get('session.hint.confirmDelete'),
        order: 10,
        command: Command.RETURN,
      },
      {
        label: i18n.get('session.hint.cancelDelete'),
        order: 100,
        command: Command.ESCAPE,
      },
    ];
  }

  return state.preview
    ? previewHints
    : state.isSearchMode
      ? searchHints
      : navHints;
};

export function SessionBrowserView({
  state,
  onExit,
  extraHints,
}: {
  state: SessionBrowserState;
  onExit?: () => void;
  extraHints?: ShortcutHint[];
}): React.JSX.Element {
  const { requestTranscriptReplacement } = useApp();
  const i18n = useI18nService();
  const { locale } = i18n;
  const isPreviewVisible = state.preview !== null;
  const previousPreviewVisibleRef = useRef(isPreviewVisible);

  useLayoutEffect(() => {
    if (previousPreviewVisibleRef.current === isPreviewVisible) return;
    previousPreviewVisibleRef.current = isPreviewVisible;
    requestTranscriptReplacement?.();
  }, [isPreviewVisible, requestTranscriptReplacement]);

  if (state.preview) {
    return (
      <BaseTabDialog
        title={i18n.get('session.preview.title')}
        tabs={[]}
        activeKey=""
        onTabChange={() => {}}
        extraHints={extraHints}
      >
        <SessionPreview {...state.preview} />
      </BaseTabDialog>
    );
  }

  if (state.loading) {
    return (
      <BaseTabDialog
        title={i18n.get('session.title')}
        tabs={[]}
        activeKey=""
        onTabChange={() => {}}
        onClose={onExit}
        extraHints={extraHints}
        defaultHintLabels={{ goBack: i18n.get('session.hint.close') }}
      >
        <SessionBrowserLoading />
      </BaseTabDialog>
    );
  }

  if (state.error) {
    return (
      <BaseTabDialog
        title={i18n.get('session.title')}
        tabs={[]}
        activeKey=""
        onTabChange={() => {}}
        onClose={onExit}
        extraHints={extraHints}
        defaultHintLabels={{ goBack: i18n.get('session.hint.close') }}
      >
        <SessionBrowserError state={state} />
      </BaseTabDialog>
    );
  }

  if (!state.hasAnyResumableSessions) {
    return (
      <BaseTabDialog
        title={i18n.get('session.title')}
        tabs={[]}
        activeKey=""
        onTabChange={() => {}}
        onClose={onExit}
        extraHints={extraHints}
        defaultHintLabels={{ goBack: i18n.get('session.hint.close') }}
      >
        <SessionBrowserEmpty />
      </BaseTabDialog>
    );
  }

  return (
    <BaseTabDialog
      title={i18n.get('session.title')}
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      extraHints={extraHints}
    >
      <SessionListHeader state={state} />

      {state.pendingDeleteSessionId &&
        (() => {
          const pendingSession = state.filteredAndSortedSessions.find(
            (session) => session.id === state.pendingDeleteSessionId,
          );
          const displayName =
            pendingSession?.displayName ||
            pendingSession?.id ||
            state.pendingDeleteSessionId;
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text color={Colors.AccentRed}>
                {i18n.get('session.delete.confirm', { session: displayName })}
              </Text>
              {state.isDeletingSession && (
                <Text color={Colors.Gray}>
                  {i18n.get('session.delete.deleting')}
                </Text>
              )}
              {state.deleteError && (
                <Text color={Colors.AccentRed}>
                  {i18n.get('session.delete.failed')} {state.deleteError}
                </Text>
              )}
            </Box>
          );
        })()}

      {state.isSearchMode && <SearchModeDisplay state={state} />}

      {state.totalSessions === 0 ? (
        state.searchQuery ? (
          <NoResultsDisplay state={state} />
        ) : (
          <SessionBrowserEmpty
            canShowAllWorktrees={
              state.worktreeScope === 'current' &&
              state.hasCrossWorktreeSessions
            }
          />
        )
      ) : (
        <SessionList
          state={state}
          formatRelativeTime={(timestamp, style) =>
            formatRelativeTime(timestamp, style, locale)
          }
        />
      )}
    </BaseTabDialog>
  );
}

export function SessionBrowser({
  config,
  currentGitBranch,
  initialSearchQuery,
  onResumeSession,
  onDeleteSession,
  onExit,
}: SessionBrowserProps): React.JSX.Element {
  // Use all our custom hooks
  const state = useSessionBrowserState(
    [],
    true,
    null,
    initialSearchQuery,
    [],
    currentGitBranch,
  );
  const { reloadVisibleSessions, toggleProjectScope } = useLoadSessions(
    config,
    state,
  );
  const moveSelection = useMoveSelection(state);
  const cycleSortOrder = useCycleSortOrder(state);
  const resolveSelectedSession = useCallback(
    (session: SessionInfo, signal?: AbortSignal) =>
      new SessionSelector(config).resolveSelectedSession(session, signal),
    [config],
  );
  const hints = useSessionBrowserInput(
    state,
    moveSelection,
    cycleSortOrder,
    onResumeSession,
    onDeleteSession,
    reloadVisibleSessions,
    toggleProjectScope,
    resolveSelectedSession,
    onExit,
  );

  return (
    <SessionBrowserView state={state} onExit={onExit} extraHints={hints} />
  );
}
