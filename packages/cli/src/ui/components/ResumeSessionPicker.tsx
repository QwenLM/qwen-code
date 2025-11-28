/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import {
  SessionService,
  type SessionListItem,
  getGitBranch,
} from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { formatRelativeTime } from '../utils/formatters.js';

interface SessionPickerProps {
  sessions: SessionListItem[];
  currentBranch?: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

/**
 * Truncates text to fit within a given width, adding ellipsis if needed.
 */
function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 3) + '...';
}

function SessionPicker({
  sessions,
  currentBranch,
  onSelect,
  onCancel,
}: SessionPickerProps): React.JSX.Element {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filterByBranch, setFilterByBranch] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const [terminalSize, setTerminalSize] = useState({
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24,
  });

  // Update terminal size on resize
  useEffect(() => {
    const handleResize = () => {
      setTerminalSize({
        width: process.stdout.columns || 80,
        height: process.stdout.rows || 24,
      });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  // Filter sessions by current branch if filter is enabled
  const filteredSessions =
    filterByBranch && currentBranch
      ? sessions.filter((session) => session.gitBranch === currentBranch)
      : sessions;

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filterByBranch]);

  // Calculate visible items
  // Reserved space: header (1), footer (1), separators (2), borders (2)
  const reservedLines = 6;
  // Each item takes 2 lines (prompt + metadata) + 1 line margin between items
  // On average, this is ~3 lines per item, but the last item has no margin
  const itemHeight = 3;
  const maxVisibleItems = Math.max(
    1,
    Math.floor((terminalSize.height - reservedLines) / itemHeight),
  );

  // Calculate scroll offset
  const scrollOffset = (() => {
    if (filteredSessions.length <= maxVisibleItems) return 0;
    const halfVisible = Math.floor(maxVisibleItems / 2);
    let offset = selectedIndex - halfVisible;
    offset = Math.max(0, offset);
    offset = Math.min(filteredSessions.length - maxVisibleItems, offset);
    return offset;
  })();

  const visibleSessions = filteredSessions.slice(
    scrollOffset,
    scrollOffset + maxVisibleItems,
  );
  const showScrollUp = scrollOffset > 0;
  const showScrollDown =
    scrollOffset + maxVisibleItems < filteredSessions.length;

  // Handle keyboard input
  useInput((input, key) => {
    // Ignore input if already exiting
    if (isExiting) {
      return;
    }

    // Escape or Ctrl+C to cancel
    if (key.escape || (key.ctrl && input === 'c')) {
      setIsExiting(true);
      onCancel();
      exit();
      return;
    }

    if (key.return) {
      const session = filteredSessions[selectedIndex];
      if (session) {
        setIsExiting(true);
        onSelect(session.sessionId);
        exit();
      }
      return;
    }

    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) =>
        Math.min(filteredSessions.length - 1, prev + 1),
      );
      return;
    }

    if (input === 'b' || input === 'B') {
      if (currentBranch) {
        setFilterByBranch((prev) => !prev);
      }
      return;
    }
  });

  // Filtered sessions may have changed, ensure selectedIndex is valid
  useEffect(() => {
    if (
      selectedIndex >= filteredSessions.length &&
      filteredSessions.length > 0
    ) {
      setSelectedIndex(filteredSessions.length - 1);
    }
  }, [filteredSessions.length, selectedIndex]);

  // Calculate content width (terminal width minus border padding)
  const contentWidth = terminalSize.width - 4;
  const promptMaxWidth = contentWidth - 4; // Account for "› " prefix

  // Return empty while exiting to prevent visual glitches
  if (isExiting) {
    return <Box />;
  }

  return (
    <Box
      flexDirection="column"
      width={terminalSize.width}
      height={terminalSize.height - 1}
      overflow="hidden"
    >
      {/* Main container with single border */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.border.default}
        width={terminalSize.width}
        height={terminalSize.height - 1}
        overflow="hidden"
      >
        {/* Header row */}
        <Box justifyContent="space-between" paddingX={1}>
          <Text bold color={theme.text.primary}>
            Resume Session
          </Text>
          <Text color={theme.text.secondary}>
            {filteredSessions.length}{' '}
            {filteredSessions.length === 1 ? 'session' : 'sessions'}
            {filterByBranch && currentBranch && (
              <Text color={theme.text.accent}> ({currentBranch})</Text>
            )}
          </Text>
        </Box>

        {/* Separator line */}
        <Box>
          <Text color={theme.border.default}>
            {'─'.repeat(terminalSize.width - 2)}
          </Text>
        </Box>

        {/* Session list with auto-scrolling */}
        <Box flexDirection="column" flexGrow={1} paddingX={1} overflow="hidden">
          {filteredSessions.length === 0 ? (
            <Box paddingY={1} justifyContent="center">
              <Text color={theme.text.secondary}>
                {filterByBranch
                  ? `No sessions found for branch "${currentBranch}"`
                  : 'No sessions found'}
              </Text>
            </Box>
          ) : (
            visibleSessions.map((session, visibleIndex) => {
              const actualIndex = scrollOffset + visibleIndex;
              const isSelected = actualIndex === selectedIndex;
              const isFirst = visibleIndex === 0;
              const isLast = visibleIndex === visibleSessions.length - 1;
              const timeAgo = formatRelativeTime(session.mtime);
              const messageText =
                session.messageCount === 1
                  ? '1 message'
                  : `${session.messageCount} messages`;

              // Show scroll indicator on first/last visible items
              const showUpIndicator = isFirst && showScrollUp;
              const showDownIndicator = isLast && showScrollDown;

              // Determine the prefix: selector takes priority over scroll indicator
              const prefix = isSelected
                ? '› '
                : showUpIndicator
                  ? '↑ '
                  : showDownIndicator
                    ? '↓ '
                    : '  ';

              return (
                <Box
                  key={session.sessionId}
                  flexDirection="column"
                  marginBottom={isLast ? 0 : 1}
                >
                  {/* First line: prefix (selector or scroll indicator) + prompt text */}
                  <Box>
                    <Text
                      color={
                        isSelected
                          ? theme.text.accent
                          : showUpIndicator || showDownIndicator
                            ? theme.text.secondary
                            : undefined
                      }
                    >
                      {prefix}
                    </Text>
                    <Text
                      bold={isSelected}
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                    >
                      {truncateText(
                        session.prompt || '(empty prompt)',
                        promptMaxWidth,
                      )}
                    </Text>
                  </Box>

                  {/* Second line: metadata (aligned with prompt text) */}
                  <Box>
                    <Text>{'  '}</Text>
                    <Text color={theme.text.secondary}>
                      {timeAgo} · {messageText}
                      {session.gitBranch && ` · ${session.gitBranch}`}
                    </Text>
                  </Box>
                </Box>
              );
            })
          )}
        </Box>

        {/* Separator line */}
        <Box>
          <Text color={theme.border.default}>
            {'─'.repeat(terminalSize.width - 2)}
          </Text>
        </Box>

        {/* Footer with keyboard shortcuts */}
        <Box paddingX={1}>
          <Text color={theme.text.secondary}>
            {currentBranch && (
              <>
                <Text
                  bold={filterByBranch}
                  color={filterByBranch ? theme.text.accent : undefined}
                >
                  B
                </Text>
                {' to toggle branch · '}
              </>
            )}
            {'↑↓ to navigate · Esc to cancel'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Clears the terminal screen.
 */
function clearScreen(): void {
  // Move cursor to home position and clear screen
  process.stdout.write('\x1b[2J\x1b[H');
}

/**
 * Shows an interactive session picker and returns the selected session ID.
 * Returns undefined if the user cancels or no sessions are available.
 */
export async function showResumeSessionPicker(
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  const sessionService = new SessionService(cwd);
  const result = await sessionService.listSessions({ size: 100 });

  if (result.items.length === 0) {
    console.log('No sessions found. Start a new session with `qwen`.');
    return undefined;
  }

  const currentBranch = getGitBranch(cwd);

  // Clear the screen before showing the picker for a clean fullscreen experience
  clearScreen();

  // Enable raw mode for keyboard input if not already enabled
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY && !wasRaw) {
    process.stdin.setRawMode(true);
  }

  return new Promise<string | undefined>((resolve) => {
    let selectedId: string | undefined;

    const { unmount, waitUntilExit } = render(
      <SessionPicker
        sessions={result.items}
        currentBranch={currentBranch}
        onSelect={(id) => {
          selectedId = id;
        }}
        onCancel={() => {
          selectedId = undefined;
        }}
      />,
      {
        exitOnCtrlC: false,
      },
    );

    waitUntilExit().then(() => {
      unmount();

      // Clear the screen after the picker closes for a clean fullscreen experience
      clearScreen();

      // Restore raw mode state only if we changed it and user cancelled
      // (if user selected a session, main app will handle raw mode)
      if (process.stdin.isTTY && !wasRaw && !selectedId) {
        process.stdin.setRawMode(false);
      }

      resolve(selectedId);
    });
  });
}
