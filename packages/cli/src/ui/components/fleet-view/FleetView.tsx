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

type FleetSessionState =
  | 'needs_input'
  | 'working'
  | 'completed'
  | 'idle'
  | 'active';

const STATE_ICONS: Record<FleetSessionState, string> = {
  active: '✽',
  working: '✽',
  needs_input: '✻',
  idle: '✻',
  completed: '✻',
};

function formatTimeAgo(mtime: number): string {
  const diff = Date.now() - mtime;
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
  if (home && p.startsWith(home)) {
    p = '~' + p.slice(home.length);
  }
  if (p.length <= maxLen) return p;
  return '...' + p.slice(p.length - maxLen + 3);
}

function getSessionState(entry: FleetSessionEntry): FleetSessionState {
  if (entry.status === 'active') return 'working';
  return 'idle';
}

function getIconColor(state: FleetSessionState): string {
  switch (state) {
    case 'working':
    case 'active':
      return theme.text.accent;
    case 'needs_input':
      return theme.status.warning;
    case 'completed':
      return theme.status.success;
    case 'idle':
      return theme.text.secondary;
    default:
      return theme.text.secondary;
  }
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

  const name =
    entry.displayName.length > nameMaxLen
      ? entry.displayName.slice(0, nameMaxLen - 1) + '…'
      : entry.displayName;

  const summary = entry.prompt
    ? entry.prompt.length > summaryMaxLen
      ? entry.prompt.slice(0, summaryMaxLen - 1) + '…'
      : entry.prompt
    : '';

  return (
    <Box>
      <Text>{selected ? ' ' : ' '}</Text>
      <Text color={iconColor}>{icon} </Text>
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
  selected: boolean;
}

const GroupHeader: React.FC<GroupHeaderProps> = ({ label, selected }) => (
  <Box marginTop={1}>
    <Text color={theme.text.secondary} bold>
      {selected ? ' ' : ' '}
      {label}
    </Text>
  </Box>
);

function groupByState(
  sessions: FleetSessionEntry[],
): Array<{ label: string; entries: FleetSessionEntry[] }> {
  const working: FleetSessionEntry[] = [];
  const completed: FleetSessionEntry[] = [];
  for (const s of sessions) {
    if (s.status === 'active') working.push(s);
    else completed.push(s);
  }
  const groups: Array<{ label: string; entries: FleetSessionEntry[] }> = [];
  if (working.length > 0) groups.push({ label: 'Working', entries: working });
  if (completed.length > 0)
    groups.push({ label: 'Completed', entries: completed });
  return groups;
}

function groupByDirectory(
  sessions: FleetSessionEntry[],
): Array<{ label: string; entries: FleetSessionEntry[] }> {
  const byDir = new Map<string, FleetSessionEntry[]>();
  for (const s of sessions) {
    const key = shortenPath(s.cwd || 'unknown', 60);
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key)!.push(s);
  }
  return Array.from(byDir.entries()).map(([dir, entries]) => ({
    label: dir,
    entries,
  }));
}

type ViewMode = 'list' | 'peek' | 'confirm-stop';

export interface FleetViewProps {
  sessions: FleetSessionEntry[];
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  groupMode: 'state' | 'directory';
  onSelect: (index: number) => void;
  onAttach: (sessionId: string) => void;
  onClose: () => void;
  onDelete: (sessionId: string) => void;
  onCreateNew: () => void;
  onCycleGroupMode: () => void;
  onDispatch?: (prompt: string) => void;
  workspaceCwd?: string;
  isActive?: boolean;
  sessionService?: SessionService;
  onRefresh?: () => void;
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
}) => {
  const { rows, columns } = useTerminalSize();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [inputValue, setInputValue] = useState('');
  const [stopPendingId, setStopPendingId] = useState<string | null>(null);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
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

  // Count stats
  const workingCount = sessions.filter((s) => s.status === 'active').length;
  const completedCount = sessions.length - workingCount;

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
        if (
          key.sequence &&
          key.sequence.length === 1 &&
          !key.ctrl &&
          !key.meta
        ) {
          setRenameValue((prev) => prev + key.sequence);
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

      // Printable chars go to dispatch input
      if (
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
        key.name !== 'space' &&
        key.name !== 'backspace' &&
        key.name !== 'delete' &&
        key.name !== 'tab'
      ) {
        setInputValue((prev) => prev + key.sequence);
        return;
      }

      if (key.name === 'backspace' && inputValue.length > 0) {
        setInputValue((prev) => prev.slice(0, -1));
        return;
      }

      // --- Peek mode ---
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
        // Ctrl+X: stop, then delete on second press within 2s
        if (stopPendingId === selectedEntry.sessionId) {
          // Second press — delete
          clearTimeout(stopTimerRef.current!);
          setStopPendingId(null);
          onDelete(selectedEntry.sessionId);
          showStatus('Session deleted');
        } else {
          // First press — stop
          setStopPendingId(selectedEntry.sessionId);
          showStatus('Press Ctrl+X again to delete');
          if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
          stopTimerRef.current = setTimeout(() => {
            setStopPendingId(null);
            stopTimerRef.current = null;
          }, 2000);
        }
      } else if (key.ctrl && key.name === 's') {
        onCycleGroupMode();
      } else if (key.ctrl && key.name === 'r') {
        if (selectedEntry) {
          setRenaming(true);
          setRenameValue(selectedEntry.displayName);
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
      stopPendingId,
      onSelect,
      onAttach,
      onClose,
      onDelete,
      onCreateNew,
      onCycleGroupMode,
      onDispatch,
      sessionService,
      onRefresh,
      showStatus,
    ],
  );

  useKeypress(handleKeypress, { isActive });

  // Scroll offset
  const entryRowIndex = useMemo(() => {
    let row = 0;
    for (const group of groups) {
      row++;
      for (const entry of group.entries) {
        if (entry === selectedEntry) return row;
        row++;
      }
    }
    return 0;
  }, [groups, selectedEntry]);

  const maxVisibleRows = rows - 8; // header + stats + footer + input
  const scrollOffset = useMemo(() => {
    if (entryRowIndex < maxVisibleRows) return 0;
    return Math.max(0, entryRowIndex - maxVisibleRows + 1);
  }, [entryRowIndex, maxVisibleRows]);

  // Context-aware footer hints
  const footerHint = useMemo(() => {
    if (renaming) return 'enter to save · esc to cancel';
    if (viewMode === 'peek')
      return 'enter to open · space to close · ctrl+x to delete';
    if (selectedEntry)
      return 'enter to open · space to reply · ctrl+x to delete · ? for shortcuts';
    return '? for shortcuts';
  }, [renaming, viewMode, selectedEntry]);

  return (
    <AlternateScreen>
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
            {workingCount} working · {completedCount} completed
            {loading ? ' · ↻' : ''}
          </Text>
        </Box>

        {/* Status message */}
        {statusMessage && (
          <Box paddingX={1}>
            <Text color={theme.status.warning}>{statusMessage}</Text>
          </Box>
        )}

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
                No sessions. Type a task below and press Enter to start one.
              </Text>
            </Box>
          ) : (
            (() => {
              const rowNodes: React.ReactNode[] = [];
              let globalIdx = 0;
              for (const group of groups) {
                rowNodes.push(
                  <GroupHeader
                    key={`g-${group.label}`}
                    label={group.label}
                    selected={false}
                  />,
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
              {selectedEntry.displayName}
            </Text>
            <Text color={theme.text.secondary}>
              {selectedEntry.prompt || 'No recent output'}
            </Text>
          </Box>
        )}

        {/* Bottom input — the core interaction, like Claude Code */}
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
                {inputValue || 'describe a task for a new session'}
              </Text>
            )}
          </Box>
          <Box paddingX={0}>
            <Text color={theme.text.secondary}>{'─'.repeat(columns)}</Text>
          </Box>

          {/* Context-aware footer shortcuts */}
          <Box paddingX={1}>
            <Text color={theme.text.secondary}>{footerHint}</Text>
          </Box>
        </Box>
      </Box>
    </AlternateScreen>
  );
};
