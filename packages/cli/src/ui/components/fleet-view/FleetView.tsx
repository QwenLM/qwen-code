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

const STATUS_ICONS: Record<string, string> = {
  active: '●',
  backgrounded: '○',
  idle: '○',
};

const STATUS_COLORS: Record<string, string> = {
  active: theme.status.success,
  backgrounded: theme.text.secondary,
  idle: theme.text.secondary,
};

function formatTimeAgo(mtime: number): string {
  const diff = Date.now() - mtime;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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

interface SessionRowProps {
  entry: FleetSessionEntry;
  selected: boolean;
  width: number;
  renaming?: boolean;
  renameValue?: string;
}

const SessionRow: React.FC<SessionRowProps> = ({
  entry,
  selected,
  width,
  renaming,
  renameValue,
}) => {
  const icon = STATUS_ICONS[entry.status] ?? '○';
  const iconColor = STATUS_COLORS[entry.status] ?? theme.text.secondary;
  const timeStr = formatTimeAgo(entry.mtime);
  const pathStr = shortenPath(entry.cwd || '', 30);

  const nameMaxLen = Math.max(20, width - 60);

  if (renaming && selected) {
    return (
      <Box>
        <Text color={theme.text.accent}>{'> '}</Text>
        <Text color={iconColor}>{icon} </Text>
        <Text color={theme.text.primary} bold>
          {(renameValue ?? '').padEnd(nameMaxLen)}
        </Text>
        <Text color={theme.text.secondary}> ▏</Text>
      </Box>
    );
  }

  const name =
    entry.displayName.length > nameMaxLen
      ? entry.displayName.slice(0, nameMaxLen - 3) + '...'
      : entry.displayName;

  return (
    <Box>
      <Text color={selected ? theme.text.accent : undefined}>
        {selected ? '> ' : '  '}
      </Text>
      <Text color={iconColor}>{icon} </Text>
      <Text
        color={selected ? theme.text.primary : theme.text.secondary}
        bold={selected}
      >
        {name.padEnd(nameMaxLen)}
      </Text>
      <Text color={theme.text.secondary}> {pathStr.padEnd(32)}</Text>
      <Text color={theme.text.secondary}> {timeStr.padStart(8)}</Text>
    </Box>
  );
};

interface GroupHeaderProps {
  label: string;
}

const GroupHeader: React.FC<GroupHeaderProps> = ({ label }) => (
  <Box marginTop={1}>
    <Text color={theme.text.secondary} bold>
      {'  '}
      {label}
    </Text>
  </Box>
);

function groupSessions(
  sessions: FleetSessionEntry[],
  mode: 'state' | 'directory',
): Array<{ label: string; entries: FleetSessionEntry[] }> {
  if (mode === 'directory') {
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

  const active: FleetSessionEntry[] = [];
  const backgrounded: FleetSessionEntry[] = [];
  const idle: FleetSessionEntry[] = [];
  for (const s of sessions) {
    if (s.status === 'active') active.push(s);
    else if (s.status === 'backgrounded') backgrounded.push(s);
    else idle.push(s);
  }
  const groups: Array<{ label: string; entries: FleetSessionEntry[] }> = [];
  if (active.length > 0) groups.push({ label: 'Running', entries: active });
  if (backgrounded.length > 0)
    groups.push({ label: 'Backgrounded', entries: backgrounded });
  if (idle.length > 0) groups.push({ label: 'Recent', entries: idle });
  return groups;
}

type FleetMode = 'normal' | 'confirm-delete' | 'rename';

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
  workspaceCwd,
  isActive = true,
  sessionService,
  onRefresh,
}) => {
  const { rows, columns } = useTerminalSize();
  const [mode, setMode] = useState<FleetMode>('normal');
  const [renameValue, setRenameValue] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
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
    () => groupSessions(sessions, groupMode),
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

  const handleKeypress = useCallback(
    (key: Key) => {
      // --- Rename mode: capture typed characters ---
      if (mode === 'rename') {
        if (key.name === 'escape') {
          setMode('normal');
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
          setMode('normal');
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

      // --- Delete confirmation ---
      if (mode === 'confirm-delete') {
        if (key.name === 'y' && selectedEntry) {
          onDelete(selectedEntry.sessionId);
          setMode('normal');
        } else {
          setMode('normal');
        }
        return;
      }

      // --- Normal mode ---
      if (key.name === 'up' || key.name === 'k') {
        onSelect(Math.max(0, clampedIndex - 1));
      } else if (key.name === 'down' || key.name === 'j') {
        onSelect(Math.min(flatEntries.length - 1, clampedIndex + 1));
      } else if (key.name === 'return' && selectedEntry) {
        onAttach(selectedEntry.sessionId);
      } else if (key.name === 'escape' || key.name === 'q') {
        onClose();
      } else if (key.name === 'n') {
        onCreateNew();
      } else if (key.name === 'd' && selectedEntry) {
        if (selectedEntry.status === 'active') {
          showStatus('Cannot delete the active session');
          return;
        }
        setMode('confirm-delete');
      } else if (key.name === 'r' && selectedEntry) {
        setMode('rename');
        setRenameValue(selectedEntry.displayName);
      } else if (key.name === 'tab') {
        onCycleGroupMode();
      } else if (key.name === 'x' && selectedEntry) {
        // x = stop (alias for delete for non-active sessions)
        if (selectedEntry.status === 'active') {
          showStatus('Cannot stop the active session');
          return;
        }
        setMode('confirm-delete');
      }
    },
    [
      mode,
      clampedIndex,
      flatEntries.length,
      selectedEntry,
      renameValue,
      onSelect,
      onAttach,
      onClose,
      onDelete,
      onCreateNew,
      onCycleGroupMode,
      sessionService,
      onRefresh,
      showStatus,
    ],
  );

  useKeypress(handleKeypress, { isActive });

  const maxVisibleRows = rows - 6;

  // Compute scroll offset to keep selected item visible.
  // Each group header takes 1 row, each entry takes 1 row.
  const entryRowIndex = useMemo(() => {
    let row = 0;
    for (const group of groups) {
      row++; // group header
      for (const entry of group.entries) {
        if (entry === selectedEntry) return row;
        row++;
      }
    }
    return 0;
  }, [groups, selectedEntry]);

  const scrollOffset = useMemo(() => {
    if (entryRowIndex < maxVisibleRows) return 0;
    return Math.max(0, entryRowIndex - maxVisibleRows + 1);
  }, [entryRowIndex, maxVisibleRows]);

  const footerText =
    mode === 'confirm-delete'
      ? 'Delete this session permanently? y confirm  n cancel'
      : mode === 'rename'
        ? 'Type new name, enter confirm, esc cancel'
        : '↑↓ navigate  enter attach  n new  r rename  d delete  tab group  esc close';

  return (
    <AlternateScreen>
      <Box flexDirection="column" height={rows} width={columns}>
        {/* Header */}
        <Box
          paddingX={2}
          borderStyle="single"
          borderColor={theme.border.default}
          flexShrink={0}
        >
          <Text color={theme.text.accent} bold>
            Fleet View
          </Text>
          {workspaceCwd && (
            <Text color={theme.text.secondary}>
              {'  '}
              {shortenPath(workspaceCwd, 40)}
            </Text>
          )}
          <Box flexGrow={1} />
          <Text color={theme.text.secondary}>
            group: {groupMode}
            {loading ? '  ↻' : ''}
          </Text>
        </Box>

        {/* Status message */}
        {statusMessage && (
          <Box paddingX={2}>
            <Text color={theme.status.warning}>{statusMessage}</Text>
          </Box>
        )}

        {/* Error display */}
        {error && (
          <Box paddingX={2}>
            <Text color={theme.status.error}>Error: {error}</Text>
          </Box>
        )}

        {/* Session list */}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {sessions.length === 0 && !loading ? (
            <Box paddingX={1} paddingY={1}>
              <Text color={theme.text.secondary}>
                No sessions found. Press{' '}
                <Text bold color={theme.text.primary}>
                  n
                </Text>{' '}
                to create a new session.
              </Text>
            </Box>
          ) : (
            (() => {
              let globalIdx = 0;
              const rowNodes: React.ReactNode[] = [];
              for (const group of groups) {
                rowNodes.push(
                  <GroupHeader
                    key={`group-${group.label}`}
                    label={group.label}
                  />,
                );
                for (const entry of group.entries) {
                  const idx = globalIdx;
                  rowNodes.push(
                    <SessionRow
                      key={entry.sessionId}
                      entry={entry}
                      selected={idx === clampedIndex}
                      width={columns}
                      renaming={mode === 'rename' && idx === clampedIndex}
                      renameValue={renameValue}
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

        {/* Footer */}
        <Box
          paddingX={2}
          borderStyle="single"
          borderColor={theme.border.default}
          flexShrink={0}
        >
          <Text color={theme.text.secondary}>{footerText}</Text>
        </Box>
      </Box>
    </AlternateScreen>
  );
};
