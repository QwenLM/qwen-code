/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI port of the ink `SessionPicker`, shared by `/resume` and `/delete`
 * exactly as ink shares one component between them.
 *
 * The renderer-independent halves are ink's own modules — `filterSessions` and
 * `SESSION_PAGE_SIZE` for the list, `formatRelativeTime` / `formatMessageCount`
 * / `truncateText` for the row text, `useSessionSearchInput` for the query
 * buffer — so filtering and search editing cannot drift between backends. Only
 * the layout and the key dispatch are ported here, against `useKeyboard`.
 *
 * Space-to-preview is ink's `SessionPreview`: a separate borderless tree that
 * replaces the list, Enter resumes it and Esc comes back with the cursor, the
 * checks and the query untouched.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type {
  ListSessionsResult,
  ResumedSessionData,
  SessionListItem,
  SessionService,
} from '@qwen-code/qwen-code-core/services/sessionService.js';
import { AGENT_HOST_SESSION_SOURCE_TYPE } from '../../runtime/agent-session-source.js';
import { t } from '../../i18n/index.js';
import {
  filterSessions,
  formatMessageCount,
  SESSION_PAGE_SIZE,
  truncateText,
  type SessionState,
} from '../utils/sessionPickerUtils.js';
import { formatRelativeTime } from '../utils/formatters.js';
import {
  isPrintableSearchChar,
  useSessionSearchInput,
} from '../hooks/useSessionSearchInput.js';
import { toOriginalKey } from './key-map.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { useBatchSafeCursor, useBatchSafeState } from './batch-cursor.js';
import { OpenTuiTranscriptView } from './transcript-view.js';
import { resumeEventsFromSession } from './resume-session.js';
import { foldLiveEvent, type LiveHistoryItem } from './live-session-model.js';
import { C } from './theme.js';

export interface OpenTuiSessionPickerProps {
  sessionService: SessionService | null;
  currentBranch?: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  /** Header title; ink defaults to "Resume Session". */
  title?: string;
  /** Pre-filtered sessions (`/resume <title>` with several matches). */
  initialSessions?: SessionListItem[];
  /**
   * Enable Space-to-preview. Off by default, exactly like ink: the preview's
   * Enter forwards to `onSelect`, which resumes for `/resume` but would
   * commit a destructive flow. Multi-select owns Space, so it also disables
   * the preview and its footer hint.
   */
  enablePreview?: boolean;
  enableMultiSelect?: boolean;
  onConfirmMulti?: (sessionIds: string[]) => void;
  /** Rows the user may not check or Enter — the live session, for /delete. */
  disabledIds?: readonly string[];
}

/** Header/search/list/footers/separators/borders, in ink's own accounting. */
const RESERVED_LINES = 7;
/** Prompt row + metadata row + the margin between items. */
const ITEM_HEIGHT = 3;

/** The three bodies ink's `SessionPreview` renders before/after its load. */
type PreviewLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      items: readonly LiveHistoryItem[];
      messageCount: number;
    };

/** Folded into a list of its own: the live transcript is never touched. No
 * config is passed, so tool groups degrade to name-only exactly as ink's
 * preview does (it passes `null`); Enter resumes for full fidelity. */
function foldPreviewItems(
  data: ResumedSessionData,
): readonly LiveHistoryItem[] {
  let items: readonly LiveHistoryItem[] = [];
  for (const event of resumeEventsFromSession(data)) {
    items = foldLiveEvent(items, event);
  }
  return items;
}

/** `listSessions` omits the count, so ink counts the unique user/assistant
 * uuids of the conversation it just loaded. */
function countPreviewMessages(data: ResumedSessionData): number {
  const seen = new Set<string>();
  for (const message of data.conversation.messages) {
    if (message.type === 'user' || message.type === 'assistant') {
      seen.add(message.uuid);
    }
  }
  return seen.size;
}

export function OpenTuiSessionPicker(props: OpenTuiSessionPickerProps) {
  const {
    sessionService,
    currentBranch,
    onSelect,
    onCancel,
    title,
    initialSessions,
    enablePreview = false,
    enableMultiSelect = false,
    onConfirmMulti,
    disabledIds,
  } = props;

  const { width, height } = useTerminalDimensions();
  const boxWidth = Math.max(0, width - 4);
  const maxVisibleItems = Math.max(
    1,
    Math.floor((height - RESERVED_LINES) / ITEM_HEIGHT),
  );

  const hasInitialSessions = initialSessions !== undefined;
  const {
    cursor: selectedIndex,
    cursorRef: selectedIndexRef,
    setCursor: setSelectedIndex,
  } = useBatchSafeCursor(0);
  const [sessionState, setSessionState] = useState<SessionState>(() =>
    hasInitialSessions
      ? { sessions: initialSessions, hasMore: false, nextCursor: undefined }
      : { sessions: [], hasMore: true, nextCursor: undefined },
  );
  const [filterByBranch, setFilterByBranch] = useState(false);
  const [isLoading, setIsLoading] = useState(!hasInitialSessions);
  const {
    value: viewModeValue,
    ref: viewModeRef,
    setValue: setViewMode,
  } = useBatchSafeState<'list' | 'search'>('list');
  const {
    value: checkedIds,
    ref: checkedIdsRef,
    setValue: setCheckedIds,
  } = useBatchSafeState<ReadonlySet<string>>(new Set());
  // Space binds either the checkbox or the preview, never both, so the hint
  // can't advertise a binding multi-select already took.
  const previewEnabled = enablePreview && !enableMultiSelect;
  const {
    value: previewSessionId,
    ref: previewSessionIdRef,
    setValue: setPreviewSessionId,
  } = useBatchSafeState<string | null>(null);
  const [previewLoad, setPreviewLoad] = useState<PreviewLoad>({
    status: 'loading',
  });

  const disabledIdSet = useMemo(
    () => new Set(disabledIds ?? []),
    [disabledIds],
  );

  const toggleChecked = useCallback(
    (sessionId: string) => {
      if (disabledIdSet.has(sessionId)) return;
      const next = new Set(checkedIdsRef.current);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      setCheckedIds(next);
    },
    [checkedIdsRef, setCheckedIds, disabledIdSet],
  );

  const exitToList = useCallback(() => setViewMode('list'), [setViewMode]);
  const { searchQuery, setSearchQuery, handleSearchKey } =
    useSessionSearchInput({ onExitToList: exitToList });

  const isLoadingMoreRef = useRef(false);

  const filteredSessions = useMemo(
    () =>
      filterSessions(
        sessionState.sessions,
        filterByBranch,
        currentBranch,
        searchQuery,
      ),
    [sessionState.sessions, filterByBranch, currentBranch, searchQuery],
  );

  const scrollOffset = useMemo(() => {
    if (filteredSessions.length <= maxVisibleItems) return 0;
    const halfVisible = Math.floor(maxVisibleItems / 2);
    return Math.min(
      filteredSessions.length - maxVisibleItems,
      Math.max(0, selectedIndex - halfVisible),
    );
  }, [filteredSessions.length, maxVisibleItems, selectedIndex]);

  const visibleSessions = useMemo(
    () => filteredSessions.slice(scrollOffset, scrollOffset + maxVisibleItems),
    [filteredSessions, maxVisibleItems, scrollOffset],
  );
  const showScrollUp = scrollOffset > 0;
  const showScrollDown =
    scrollOffset + maxVisibleItems < filteredSessions.length;

  useEffect(() => {
    if (!sessionService || hasInitialSessions) return;
    let alive = true;
    void (async () => {
      try {
        const result: ListSessionsResult = await sessionService.listSessions({
          size: SESSION_PAGE_SIZE,
          excludeSourceType: AGENT_HOST_SESSION_SOURCE_TYPE,
        });
        if (!alive) return;
        setSessionState({
          sessions: result.items,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
        });
      } finally {
        if (alive) setIsLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionService, hasInitialSessions]);

  const loadMoreSessions = useCallback(async () => {
    if (!sessionService || !sessionState.hasMore || isLoadingMoreRef.current) {
      return;
    }
    isLoadingMoreRef.current = true;
    try {
      const result: ListSessionsResult = await sessionService.listSessions({
        size: SESSION_PAGE_SIZE,
        cursor: sessionState.nextCursor,
        excludeSourceType: AGENT_HOST_SESSION_SOURCE_TYPE,
      });
      setSessionState((prev) => ({
        sessions: [...prev.sessions, ...result.items],
        hasMore: result.hasMore && result.nextCursor !== undefined,
        nextCursor: result.nextCursor,
      }));
    } finally {
      isLoadingMoreRef.current = false;
    }
  }, [sessionService, sessionState.hasMore, sessionState.nextCursor]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filterByBranch, searchQuery, setSelectedIndex]);

  useEffect(() => {
    if (
      selectedIndex >= filteredSessions.length &&
      filteredSessions.length > 0
    ) {
      setSelectedIndex(filteredSessions.length - 1);
    }
  }, [filteredSessions.length, selectedIndex, setSelectedIndex]);

  useEffect(() => {
    if (isLoading || !sessionState.hasMore || isLoadingMoreRef.current) return;
    const sentinelVisible =
      scrollOffset + maxVisibleItems >= filteredSessions.length;
    if (filteredSessions.length === 0 || sentinelVisible) {
      void loadMoreSessions();
    }
  }, [
    filteredSessions.length,
    isLoading,
    loadMoreSessions,
    maxVisibleItems,
    scrollOffset,
    sessionState.hasMore,
  ]);

  // ink SessionPreview: load on entry and drop whatever resolves after the
  // user left, so Esc can't be followed by a stale transcript painting over
  // the list.
  useEffect(() => {
    if (previewSessionId === null || !sessionService) return;
    let alive = true;
    setPreviewLoad({ status: 'loading' });
    void (async () => {
      try {
        const data = await sessionService.loadSession(previewSessionId);
        if (!alive) return;
        if (!data) {
          setPreviewLoad({ status: 'error', message: 'Session not found' });
          return;
        }
        setPreviewLoad({
          status: 'ready',
          items: foldPreviewItems(data),
          messageCount: countPreviewMessages(data),
        });
      } catch (error) {
        if (!alive) return;
        setPreviewLoad({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [previewSessionId, sessionService]);

  const moveSelection = useCallback(
    (delta: -1 | 1) => {
      const length = filteredSessions.length;
      if (length === 0) return;
      setSelectedIndex(
        Math.min(length - 1, Math.max(0, selectedIndexRef.current + delta)),
      );
    },
    [filteredSessions.length, selectedIndexRef, setSelectedIndex],
  );

  useKeyboard((raw) => {
    const key = toOriginalKey(raw);
    const { name, sequence, ctrl } = key;

    // ink hands the whole keyboard to SessionPreview while it is up (the
    // picker's own handler is deactivated), so only back and resume exist
    // here and ctrl+c backs out instead of cancelling the dialog.
    const previewId = previewSessionIdRef.current;
    if (previewId !== null) {
      if (name === 'escape' || (ctrl && name === 'c')) {
        setPreviewSessionId(null);
      } else if (name === 'return' || name === 'enter') {
        onSelect(previewId);
      }
      return;
    }

    if (ctrl && name === 'c') {
      onCancel();
      return;
    }

    if (name === 'return' || name === 'enter') {
      if (viewModeRef.current === 'search') {
        // Nothing to commit to — keep editing.
        if (filteredSessions.length === 0) return;
        setViewMode('list');
        return;
      }
      if (
        enableMultiSelect &&
        checkedIdsRef.current.size > 0 &&
        onConfirmMulti
      ) {
        // Commit every checked id, not just the filtered-in ones: a search
        // is a navigation aid, and intersecting with it would silently drop
        // checks the user made before typing. Ordered by the full list so the
        // receiver reports deletions in display order.
        const orderedIds = sessionState.sessions
          .map((session) => session.sessionId)
          .filter(
            (id) => checkedIdsRef.current.has(id) && !disabledIdSet.has(id),
          );
        if (orderedIds.length > 0) onConfirmMulti(orderedIds);
        return;
      }
      const session = filteredSessions[selectedIndexRef.current];
      if (session && !disabledIdSet.has(session.sessionId)) {
        onSelect(session.sessionId);
      }
      return;
    }

    const isNavUp = name === 'up' || (ctrl && name === 'p');
    const isNavDown = name === 'down' || (ctrl && name === 'n');
    if (isNavUp || isNavDown) {
      if (viewModeRef.current === 'search') {
        if (filteredSessions.length === 0) return;
        setViewMode('list');
        return;
      }
      if (
        isNavUp &&
        filteredSessions.length > 0 &&
        selectedIndexRef.current === 0
      ) {
        setViewMode('search');
        return;
      }
      moveSelection(isNavUp ? -1 : +1);
      return;
    }

    // While the query is focused it owns the keyboard: anything
    // `handleSearchKey` doesn't claim is swallowed, and the mode-independent
    // shortcuts above are the only way out.
    if (viewModeRef.current === 'search') {
      handleSearchKey(key);
      return;
    }

    if (name === 'escape') {
      if (searchQuery !== '') {
        setSearchQuery('');
      } else {
        onCancel();
      }
      return;
    }

    if (name === 'k') {
      moveSelection(-1);
      return;
    }
    if (name === 'j') {
      moveSelection(+1);
      return;
    }

    if (name === 'space' || sequence === ' ') {
      const session = filteredSessions[selectedIndexRef.current];
      if (!session) return;
      if (enableMultiSelect) toggleChecked(session.sessionId);
      else if (previewEnabled) setPreviewSessionId(session.sessionId);
      return;
    }

    if (ctrl && (name === 'b' || name === 'B')) {
      if (currentBranch) setFilterByBranch((prev) => !prev);
      return;
    }

    if (sequence === '/') {
      setViewMode('search');
      return;
    }

    // Typing a letter in list mode enters search with that letter already in
    // the buffer; release events are dropped so a key isn't inserted twice.
    if (isPrintableSearchChar(key) && isPrintableKeyInput(raw)) {
      setViewMode('search');
      setSearchQuery((query) => query + sequence);
    }
  });

  const maxPromptWidth = Math.max(0, boxWidth - 6);
  const checkboxWidth = enableMultiSelect ? 4 : 0;
  const isSearchActive = viewModeValue === 'search';

  const committableCheckedCount = useMemo(() => {
    let count = 0;
    for (const id of checkedIds) {
      if (!disabledIdSet.has(id)) count++;
    }
    return count;
  }, [checkedIds, disabledIdSet]);

  const headerSuffix = [
    filterByBranch && currentBranch
      ? t('(branch: {{branch}})', { branch: currentBranch })
      : '',
    searchQuery !== ''
      ? t('({{count}} matches)', {
          count: String(filteredSessions.length),
        })
      : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  const previewed = filteredSessions.find(
    (session) => session.sessionId === previewSessionId,
  );
  const previewTitle =
    previewed?.customTitle ||
    previewed?.prompt ||
    previewed?.goalObjective ||
    t('Session Preview');
  // ink's preview meta line: the list entry's count when it has one, else the
  // count taken off the loaded conversation, then time and branch.
  const previewCount =
    previewed?.messageCount ??
    (previewLoad.status === 'ready' ? previewLoad.messageCount : undefined);
  const previewMeta = [
    previewCount === undefined ? '' : formatMessageCount(previewCount),
    previewed ? formatRelativeTime(previewed.mtime) : '',
    previewed?.gitBranch ?? '',
  ]
    .filter((part) => part !== '')
    .join(' · ');

  const footerTail = `${currentBranch ? t(' to toggle branch · ') : ''}${
    previewEnabled ? t('Space to preview · ') : ''
  }${
    enableMultiSelect
      ? committableCheckedCount > 0
        ? t('Space to toggle · {{count}} selected · ', {
            count: String(committableCheckedCount),
          })
        : t('Space to select multiple · ')
      : ''
  }${t('↑↓ to navigate · Type to search · Esc to cancel')}`;

  // ink returns a separate `SessionPreview` tree here rather than swapping the
  // body of the list: the preview has no border and its transcript spans the
  // full inner width. All picker state lives above, so the list comes back with
  // the cursor, the checks and the query untouched.
  if (previewSessionId !== null) {
    return (
      <box
        key="preview"
        flexDirection="column"
        width={boxWidth}
        height={Math.max(0, height - 1)}
        overflow="hidden"
        marginTop={1}
        flexShrink={0}
      >
        <box paddingLeft={1} paddingRight={1}>
          <text fg={C.text} attributes={1}>
            {previewTitle}
          </text>
        </box>

        <Rule width={boxWidth} />

        <box flexDirection="column" flexGrow={1} overflow="hidden">
          {previewLoad.status === 'ready' ? (
            <OpenTuiTranscriptView
              items={previewLoad.items}
              availableWidth={boxWidth}
              availableTerminalHeight={height}
              thoughtsExpanded
            />
          ) : previewLoad.status === 'error' ? (
            <CenteredNotice text={previewLoad.message} color={C.red} />
          ) : (
            <CenteredNotice text={t('Loading session preview...')} />
          )}
        </box>

        <Rule width={boxWidth} />

        {previewMeta !== '' ? (
          <box paddingLeft={1} paddingRight={1}>
            <text fg={C.dim}>{previewMeta}</text>
          </box>
        ) : null}

        <box paddingLeft={1} paddingRight={1}>
          <text fg={C.dim}>{t('Enter to resume · Esc to back')}</text>
        </box>
      </box>
    );
  }

  const headerTitle = title ?? t('Resume Session');

  return (
    <box
      key="list"
      flexDirection="column"
      borderStyle="rounded"
      borderColor={C.borderDefault}
      width={boxWidth}
      height={Math.max(0, height - 1)}
      overflow="hidden"
      marginTop={1}
      flexShrink={0}
    >
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <text fg={C.text} attributes={1}>
          {headerTitle}
          {headerSuffix ? ' ' : ''}
        </text>
        {headerSuffix ? <text fg={C.dim}>{headerSuffix}</text> : null}
      </box>

      {/* Two states share this row at constant height so the visible-item
          count doesn't shift between them. */}
      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        {isSearchActive ? (
          <text fg={C.dim}>
            {t('Search: ')}
            <span fg={C.text}>{searchQuery}</span>
            <span fg={C.dim}>{'▌'}</span>
          </text>
        ) : searchQuery !== '' ? (
          <text fg={C.dim}>
            {t('Filter: ')}
            <span fg={C.text}>{searchQuery}</span>
          </text>
        ) : (
          <text fg={C.dim}>{t('Press / to search')}</text>
        )}
      </box>

      <Rule width={boxWidth} />

      <box
        flexDirection="column"
        flexGrow={1}
        paddingLeft={1}
        paddingRight={1}
        overflow="hidden"
      >
        {!sessionService || isLoading ? (
          <CenteredNotice text={t('Loading sessions...')} />
        ) : filteredSessions.length === 0 ? (
          <CenteredNotice
            text={
              searchQuery !== ''
                ? t('No sessions match "{{query}}"', { query: searchQuery })
                : filterByBranch
                  ? t('No sessions found for branch "{{branch}}"', {
                      branch: currentBranch ?? '',
                    })
                  : t('No sessions found')
            }
          />
        ) : (
          visibleSessions.map((session, visibleIndex) => {
            const isDisabled = disabledIdSet.has(session.sessionId);
            return (
              <SessionRow
                key={session.sessionId}
                session={session}
                isSelected={
                  !isSearchActive &&
                  selectedIndex === scrollOffset + visibleIndex
                }
                isFirst={visibleIndex === 0}
                isLast={visibleIndex === visibleSessions.length - 1}
                showScrollUp={showScrollUp}
                showScrollDown={showScrollDown}
                promptWidth={Math.max(1, maxPromptWidth - checkboxWidth)}
                isChecked={
                  enableMultiSelect
                    ? checkedIds.has(session.sessionId)
                    : undefined
                }
                isDisabled={enableMultiSelect && isDisabled}
                disabledHint={
                  enableMultiSelect && isDisabled
                    ? t('current — cannot delete')
                    : undefined
                }
              />
            );
          })
        )}
      </box>

      <Rule width={boxWidth} />

      <box flexDirection="row" paddingLeft={1} paddingRight={1}>
        {isSearchActive ? (
          <text fg={C.dim}>
            {t('Type to search · Enter to commit · Esc to clear')}
          </text>
        ) : (
          <text fg={C.dim}>
            {currentBranch ? (
              <span
                fg={filterByBranch ? C.accent : C.dim}
                attributes={filterByBranch ? 1 : undefined}
              >
                {'Ctrl+B'}
              </span>
            ) : null}
            {footerTail}
          </text>
        )}
      </box>
    </box>
  );
}

function Rule({ width }: { width: number }) {
  return (
    <box>
      <text fg={C.borderDefault}>{'─'.repeat(Math.max(0, width - 2))}</text>
    </box>
  );
}

function CenteredNotice({ text, color }: { text: string; color?: string }) {
  return (
    <box flexDirection="row" justifyContent="center" paddingY={1}>
      <text fg={color ?? C.dim}>{text}</text>
    </box>
  );
}

interface SessionRowProps {
  session: SessionListItem;
  isSelected: boolean;
  isFirst: boolean;
  isLast: boolean;
  showScrollUp: boolean;
  showScrollDown: boolean;
  promptWidth: number;
  /** `undefined` renders no checkbox column at all. */
  isChecked?: boolean;
  isDisabled: boolean;
  disabledHint?: string;
}

function SessionRow({
  session,
  isSelected,
  isFirst,
  isLast,
  showScrollUp,
  showScrollDown,
  promptWidth,
  isChecked,
  isDisabled,
  disabledHint,
}: SessionRowProps) {
  const showUpIndicator = isFirst && showScrollUp;
  const showDownIndicator = isLast && showScrollDown;
  const marker = isSelected
    ? '› '
    : showUpIndicator
      ? '↑ '
      : showDownIndicator
        ? '↓ '
        : '  ';
  const markerColor = isSelected
    ? C.accent
    : showUpIndicator || showDownIndicator
      ? C.dim
      : C.text;

  const promptText =
    session.customTitle ||
    session.prompt ||
    session.goalObjective ||
    '(empty prompt)';
  // Dim auto-generated titles so a model guess is distinguishable from a title
  // the user chose with /rename. The focused row keeps the accent color —
  // legibility of the selection wins over source hinting.
  const isAutoTitle =
    session.titleSource === 'auto' && Boolean(session.customTitle);
  const titleColor = isDisabled
    ? C.dim
    : isSelected
      ? C.accent
      : isAutoTitle
        ? C.dim
        : C.text;

  // `messageCount` is optional on the list entry because counting needs a full
  // pass over the JSONL; the row omits the segment when it isn't known.
  const messageText =
    typeof session.messageCount === 'number'
      ? formatMessageCount(session.messageCount)
      : undefined;
  const meta = `${formatRelativeTime(session.mtime)}${
    messageText !== undefined ? ` · ${messageText}` : ''
  }${session.gitBranch ? ` · ${session.gitBranch}` : ''}${
    isDisabled && disabledHint ? ` · ${disabledHint}` : ''
  }`;

  return (
    <box flexDirection="column" marginBottom={isLast ? 0 : 1}>
      <box flexDirection="row">
        <box width={2} flexShrink={0}>
          <text fg={markerColor}>{marker}</text>
        </box>
        {isChecked !== undefined && (
          <box width={4} flexShrink={0}>
            <text
              fg={
                isDisabled ? C.dim : isChecked || isSelected ? C.accent : C.dim
              }
              attributes={isChecked ? 1 : undefined}
            >
              {isChecked ? '[x] ' : '[ ] '}
            </text>
          </box>
        )}
        <box flexGrow={1}>
          <text
            fg={titleColor}
            attributes={isSelected && !isDisabled ? 1 : undefined}
          >
            {truncateText(promptText, promptWidth)}
          </text>
        </box>
      </box>
      <box paddingLeft={2}>
        <text fg={C.dim}>{meta}</text>
      </box>
    </box>
  );
}
