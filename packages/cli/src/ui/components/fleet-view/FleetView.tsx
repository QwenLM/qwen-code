/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { AlternateScreen } from '../AlternateScreen.js';
import { theme } from '../../semantic-colors.js';
import type { FleetSessionEntry } from '../../contexts/FleetViewContext.js';
import type { SessionService } from '@qwen-code/qwen-code-core';
import { sanitizeDisplayText } from '../../../utils/extension-mention.js';

type FleetSessionState = 'current' | 'idle';

const STATE_ICONS: Record<FleetSessionState, string> = {
  current: '❯',
  idle: '✻',
};

function formatTimeAgo(mtime: number): string {
  const diff = Math.max(0, Date.now() - mtime);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function shortenPath(fullPath: string, maxLen: number): string {
  if (fullPath.length <= maxLen) return fullPath;
  const home = process.env['HOME'] || '';
  let p = fullPath;
  if (home && (p === home || p.startsWith(home + '/'))) {
    p = '~' + p.slice(home.length);
  }
  if (p.length <= maxLen) return p;
  return '...' + p.slice(p.length - maxLen + 3);
}

function getSessionState(entry: FleetSessionEntry): FleetSessionState {
  if (entry.status === 'current') return 'current';
  return 'idle';
}

function getIconColor(state: FleetSessionState): string {
  if (state === 'current') return theme.text.accent;
  return theme.text.secondary;
}

function safeText(raw: string, fallback: string): string {
  return sanitizeDisplayText(raw) || fallback;
}

interface SessionRowProps {
  entry: FleetSessionEntry;
  selected: boolean;
  width: number;
}

const SessionRow: React.FC<SessionRowProps> = ({ entry, selected, width }) => {
  const state = getSessionState(entry);
  const icon = STATE_ICONS[state];
  const iconColor = getIconColor(state);
  const timeStr = formatTimeAgo(entry.mtime);

  const nameMaxLen = Math.max(15, Math.floor(width * 0.25));
  const summaryMaxLen = Math.max(20, width - nameMaxLen - 15);

  const rawName = safeText(entry.displayName, entry.sessionId.slice(0, 8));
  const name =
    rawName.length > nameMaxLen
      ? rawName.slice(0, nameMaxLen - 1) + '…'
      : rawName;

  const rawPrompt = entry.prompt ? safeText(entry.prompt, '') : '';
  const summary = rawPrompt
    ? rawPrompt.length > summaryMaxLen
      ? rawPrompt.slice(0, summaryMaxLen - 1) + '…'
      : rawPrompt
    : '';

  return (
    <Box>
      <Text color={selected ? theme.text.accent : iconColor}>
        {selected ? '❯ ' : `${icon} `}
      </Text>
      <Text
        color={selected ? theme.text.primary : theme.text.secondary}
        bold={selected}
      >
        {name.padEnd(nameMaxLen)}
      </Text>
      <Text color={theme.text.secondary}>
        {'  '}
        {summary.padEnd(summaryMaxLen)}
      </Text>
      <Text color={theme.text.secondary}>{timeStr.padStart(5)}</Text>
    </Box>
  );
};

interface GroupHeaderProps {
  label: string;
}

const GroupHeader: React.FC<GroupHeaderProps> = ({ label }) => (
  <Box marginTop={1}>
    <Text color={theme.text.secondary} bold>
      {label}
    </Text>
  </Box>
);

function groupByState(
  sessions: FleetSessionEntry[],
): Array<{ label: string; entries: FleetSessionEntry[] }> {
  const current: FleetSessionEntry[] = [];
  const idle: FleetSessionEntry[] = [];
  for (const s of sessions) {
    if (s.status === 'current') current.push(s);
    else idle.push(s);
  }
  const groups: Array<{ label: string; entries: FleetSessionEntry[] }> = [];
  if (current.length > 0) groups.push({ label: 'Current', entries: current });
  if (idle.length > 0) groups.push({ label: 'Idle', entries: idle });
  return groups;
}

function groupByDirectory(
  sessions: FleetSessionEntry[],
): Array<{ label: string; entries: FleetSessionEntry[] }> {
  const byDir = new Map<string, FleetSessionEntry[]>();
  for (const s of sessions) {
    const key = s.cwd || 'unknown';
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(s);
  }
  return Array.from(byDir.entries()).map(([dir, entries]) => ({
    label: shortenPath(dir, 60),
    entries,
  }));
}

type ViewMode = 'list' | 'peek';

export interface FleetViewProps {
  sessions: FleetSessionEntry[];
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  groupMode: 'state' | 'directory';
  onSelect: (index: number) => void;
  onAttach: (sessionId: string) => void;
  onClose: () => void;
  onDelete: (sessionId: string) => boolean;
  onCreateNew: () => void;
  onCycleGroupMode: () => void;
  onDispatch?: (prompt: string) => void;
  workspaceCwd?: string;
  isActive?: boolean;
  sessionService?: SessionService;
  onRefresh?: () => void;
  /** Skip AlternateScreen escapes when the parent already owns the alt screen (VP mode). */
  disableAlternateScreen?: boolean;
}

export const FleetView: React.FC<FleetViewProps> = ({
  sessions,
  selectedIndex,
  loading,
  error,
  groupMode,
  onSelect,
  onAttach,
  onClose,
  onDelete,
  onCreateNew,
  onCycleGroupMode,
  onDispatch,
  workspaceCwd,
  isActive = true,
  sessionService,
  onRefresh,
  disableAlternateScreen,
}) => {
  const { rows, columns } = useTerminalSize();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [inputValue, setInputValue] = useState('');
  const [deletePendingId, setDeletePendingId] = useState<string | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    },
    [],
  );

  const showStatus = useCallback((msg: string) => {
    setStatusMessage(msg);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setStatusMessage(null);
      statusTimerRef.current = null;
    }, 3000);
  }, []);

  const deletePendingIdRef = useRef(deletePendingId);
  deletePendingIdRef.current = deletePendingId;
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;

  const handleDeleteRequest = useCallback(
    (entry: FleetSessionEntry, fromPeek: boolean) => {
      if (deletePendingIdRef.current === entry.sessionId) {
        if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
        setDeletePendingId(null);
        const deleted = onDeleteRef.current(entry.sessionId);
        if (deleted && fromPeek) setViewMode('list');
        showStatus(
          deleted ? 'Session deleted' : 'Cannot delete the active session',
        );
      } else {
        setDeletePendingId(entry.sessionId);
        showStatus('Press Ctrl+X again to confirm deletion');
        if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = setTimeout(() => {
          setDeletePendingId(null);
          deleteTimerRef.current = null;
        }, 2000);
      }
    },
    [showStatus],
  );

  const groups = useMemo(
    () =>
      groupMode === 'directory'
        ? groupByDirectory(sessions)
        : groupByState(sessions),
    [sessions, groupMode],
  );

  const flatEntries = useMemo(() => groups.flatMap((g) => g.entries), [groups]);

  const clampedIndex = Math.max(
    0,
    Math.min(selectedIndex, flatEntries.length - 1),
  );
  useEffect(() => {
    if (clampedIndex !== selectedIndex && flatEntries.length > 0) {
      onSelect(clampedIndex);
    }
  }, [clampedIndex, selectedIndex, flatEntries.length, onSelect]);
  const selectedEntry = flatEntries[clampedIndex];

  // Clear pending delete when selection changes
  useEffect(() => {
    if (deletePendingId && selectedEntry?.sessionId !== deletePendingId) {
      setDeletePendingId(null);
      if (deleteTimerRef.current) {
        clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
    }
  }, [deletePendingId, selectedEntry?.sessionId]);

  // Count stats
  const currentCount = sessions.filter((s) => s.status === 'current').length;
  const idleCount = sessions.length - currentCount;

  const handleKeypress = useCallback(
    (key: Key) => {
      // --- Rename mode ---
      if (renaming) {
        if (key.name === 'escape') {
          setRenaming(false);
          setRenameValue('');
          return;
        }
        if (key.name === 'return') {
          const trimmed = renameValue.trim();
          if (trimmed && selectedEntry && sessionService) {
            void sessionService
              .renameSession(selectedEntry.sessionId, trimmed)
              .then((ok) => {
                if (ok) {
                  showStatus(`Renamed to "${trimmed}"`);
                  onRefresh?.();
                } else {
                  showStatus('Rename failed');
                }
              })
              .catch(() => showStatus('Rename failed'));
          }
          setRenaming(false);
          setRenameValue('');
          return;
        }
        if (key.name === 'backspace' || key.name === 'delete') {
          setRenameValue((prev) => prev.slice(0, -1));
          return;
        }
        if (key.paste) {
          setRenameValue((prev) => prev + key.sequence);
          return;
        }
        if (
          key.sequence &&
          key.sequence.length === 1 &&
          !key.ctrl &&
          !key.meta &&
          key.name !== 'tab'
        ) {
          setRenameValue((prev) => prev + key.sequence);
          return;
        }
        return;
      }

      // --- Peek mode (before dispatch input so printable chars don't leak) ---
      if (viewMode === 'peek') {
        if (key.name === 'space' || key.name === 'escape') {
          setViewMode('list');
          return;
        }
        if (key.name === 'up') {
          onSelect(Math.max(0, clampedIndex - 1));
          return;
        }
        if (key.name === 'down') {
          onSelect(Math.min(flatEntries.length - 1, clampedIndex + 1));
          return;
        }
        if ((key.name === 'return' || key.name === 'right') && selectedEntry) {
          onAttach(selectedEntry.sessionId);
          return;
        }
        if (key.ctrl && key.name === 'x' && selectedEntry) {
          handleDeleteRequest(selectedEntry, true);
          return;
        }
        return;
      }

      // --- Input has text: dispatch on Enter ---
      if (key.name === 'return' && inputValue.length > 0) {
        if (onDispatch) {
          onDispatch(inputValue);
        } else {
          onCreateNew();
        }
        setInputValue('');
        return;
      }

      // Handle bracketed paste in dispatch input
      if (onDispatch && key.paste && key.sequence) {
        setInputValue((prev) => prev + key.sequence);
        return;
      }

      // Printable chars go to dispatch input (only when dispatch is available)
      if (
        onDispatch &&
        key.sequence &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        key.name !== 'escape' &&
        key.name !== 'return' &&
        key.name !== 'up' &&
        key.name !== 'down' &&
        key.name !== 'left' &&
        key.name !== 'right' &&
        !(key.name === 'space' && inputValue.length === 0) &&
        key.name !== 'backspace' &&
        key.name !== 'delete' &&
        key.name !== 'tab'
      ) {
        setInputValue((prev) => prev + key.sequence);
        return;
      }

      if (
        (key.name === 'backspace' || key.name === 'delete') &&
        inputValue.length > 0
      ) {
        setInputValue((prev) => prev.slice(0, -1));
        return;
      }

      // --- List mode shortcuts ---
      if (key.name === 'up') {
        onSelect(Math.max(0, clampedIndex - 1));
      } else if (key.name === 'down') {
        onSelect(Math.min(flatEntries.length - 1, clampedIndex + 1));
      } else if (
        (key.name === 'return' || key.name === 'right') &&
        selectedEntry
      ) {
        onAttach(selectedEntry.sessionId);
      } else if (key.name === 'space' && selectedEntry) {
        setViewMode('peek');
      } else if (key.name === 'escape') {
        if (inputValue.length > 0) {
          setInputValue('');
        } else {
          onClose();
        }
      } else if (key.ctrl && key.name === 'c') {
        if (inputValue.length > 0) {
          setInputValue('');
        } else {
          onClose();
        }
      } else if (key.ctrl && key.name === 'x' && selectedEntry) {
        handleDeleteRequest(selectedEntry, false);
      } else if (key.ctrl && key.name === 's') {
        onCycleGroupMode();
      } else if (key.ctrl && key.name === 'r') {
        if (selectedEntry) {
          setRenaming(true);
          setRenameValue(
            selectedEntry.customTitle ?? selectedEntry.prompt ?? '',
          );
        }
      }
    },
    [
      renaming,
      renameValue,
      viewMode,
      inputValue,
      clampedIndex,
      flatEntries.length,
      selectedEntry,
      onSelect,
      onAttach,
      onClose,
      onCreateNew,
      onCycleGroupMode,
      onDispatch,
      sessionService,
      onRefresh,
      showStatus,
      handleDeleteRequest,
    ],
  );

  useKeypress(handleKeypress, { isActive });

  // Scroll offset — computed in array-index space to match rowNodes slicing
  const selectedArrayIndex = useMemo(() => {
    let idx = 0;
    for (const group of groups) {
      idx++; // group header node
      for (const entry of group.entries) {
        if (entry === selectedEntry) return idx;
        idx++;
      }
    }
    return 0;
  }, [groups, selectedEntry]);

  const showInputArea = renaming || !!onDispatch;
  const maxVisibleRows = Math.max(
    3,
    rows -
      5 -
      (error ? 1 : 0) -
      (showInputArea ? 3 : 0) -
      (viewMode === 'peek' ? 6 : 0),
  );
  const scrollOffset = useMemo(() => {
    if (selectedArrayIndex < maxVisibleRows) return 0;
    return Math.max(0, selectedArrayIndex - maxVisibleRows + 1);
  }, [selectedArrayIndex, maxVisibleRows]);

  // Context-aware footer hints
  const footerHint = useMemo(() => {
    if (renaming) return 'enter to save · esc to cancel';
    if (viewMode === 'peek')
      return 'enter to open · space to close · ctrl+x to delete';
    if (selectedEntry)
      return 'enter to open · space to preview · ctrl+x to delete';
    return '';
  }, [renaming, viewMode, selectedEntry]);

  return (
    <AlternateScreen disabled={disableAlternateScreen}>
      <Box flexDirection="column" height={rows} width={columns}>
        {/* Header — no border, plain text like Claude Code */}
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          <Text color={theme.text.accent} bold>
            Qwen Code
          </Text>
          <Text color={theme.text.secondary}>
            {workspaceCwd ? shortenPath(workspaceCwd, 60) : ''}
          </Text>
          <Text color={theme.text.secondary}>
            {currentCount} current · {idleCount} idle
            {loading ? ' · ↻' : ''}
            {sessions.length >= 100 ? ' · +' : ''}
          </Text>
        </Box>

        {/* Status message — fixed height to avoid list shift */}
        <Box paddingX={1} height={1}>
          {statusMessage && (
            <Text color={theme.status.warning}>{statusMessage}</Text>
          )}
        </Box>

        {/* Error display */}
        {error && (
          <Box paddingX={1}>
            <Text color={theme.status.error}>Error: {error}</Text>
          </Box>
        )}

        {/* Session list */}
        <Box flexDirection="column" flexGrow={1} paddingX={0}>
          {sessions.length === 0 && !loading ? (
            <Box paddingX={1} paddingY={1}>
              <Text color={theme.text.secondary}>
                {onDispatch
                  ? 'No sessions found. Type a message below and press Enter to send.'
                  : 'No sessions found.'}
              </Text>
            </Box>
          ) : (
            (() => {
              const rowNodes: React.ReactNode[] = [];
              let globalIdx = 0;
              for (const group of groups) {
                rowNodes.push(
                  <GroupHeader key={`g-${group.label}`} label={group.label} />,
                );
                for (const entry of group.entries) {
                  rowNodes.push(
                    <SessionRow
                      key={entry.sessionId}
                      entry={entry}
                      selected={globalIdx === clampedIndex}
                      width={columns}
                    />,
                  );
                  globalIdx++;
                }
              }
              return rowNodes.slice(
                scrollOffset,
                scrollOffset + maxVisibleRows,
              );
            })()
          )}
        </Box>

        {/* Peek panel */}
        {viewMode === 'peek' && selectedEntry && (
          <Box
            flexDirection="column"
            paddingX={1}
            borderStyle="round"
            borderColor={theme.border.default}
            flexShrink={0}
            height={6}
          >
            <Text color={theme.text.primary} bold>
              {safeText(
                selectedEntry.displayName,
                selectedEntry.sessionId.slice(0, 8),
              )}
            </Text>
            <Text color={theme.text.secondary}>
              {(selectedEntry.prompt
                ? safeText(selectedEntry.prompt, 'No prompt')
                : 'No prompt'
              ).slice(0, 200)}
            </Text>
          </Box>
        )}

        {/* Bottom input — shown when renaming or dispatch is available */}
        {showInputArea && (
          <Box flexDirection="column" flexShrink={0}>
            <Box paddingX={0}>
              <Text color={theme.text.secondary}>{'─'.repeat(columns)}</Text>
            </Box>
            <Box paddingX={1}>
              <Text color={theme.text.accent}>❯ </Text>
              {renaming ? (
                <Text color={theme.text.primary}>{renameValue}▏</Text>
              ) : (
                <Text
                  color={inputValue ? theme.text.primary : theme.text.secondary}
                >
                  {inputValue || 'type a message to send'}
                </Text>
              )}
            </Box>
            <Box paddingX={0}>
              <Text color={theme.text.secondary}>{'─'.repeat(columns)}</Text>
            </Box>
          </Box>
        )}

        {/* Context-aware footer shortcuts */}
        {footerHint ? (
          <Box paddingX={1}>
            <Text color={theme.text.secondary}>{footerHint}</Text>
          </Box>
        ) : null}
      </Box>
    </AlternateScreen>
  );
};
