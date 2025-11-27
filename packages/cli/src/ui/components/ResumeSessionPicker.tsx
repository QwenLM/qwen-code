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

interface SessionPickerProps {
  sessions: SessionListItem[];
  currentBranch?: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

/**
 * Formats a timestamp into a human-readable relative time string.
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);

  if (months > 0) {
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
  if (weeks > 0) {
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  if (days > 0) {
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }
  if (hours > 0) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (minutes > 0) {
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }
  return 'just now';
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

  // Calculate visible items - reserve space for header (1), footer (1), separators (2), borders (2)
  const reservedLines = 6;
  const itemHeight = 2;
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
    if (key.escape) {
      onCancel();
      exit();
      return;
    }

    if (key.return) {
      const session = filteredSessions[selectedIndex];
      if (session) {
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

  return (
    <Box
      flexDirection="column"
      width={terminalSize.width}
      height={terminalSize.height}
    >
      {/* Main container with single border */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        width={terminalSize.width}
        minHeight={terminalSize.height - 1}
      >
        {/* Header row */}
        <Box justifyContent="space-between" paddingX={1}>
          <Text bold color="white">
            Resume Session
          </Text>
          <Text dimColor>
            {filteredSessions.length}{' '}
            {filteredSessions.length === 1 ? 'session' : 'sessions'}
            {filterByBranch && currentBranch && (
              <Text color="cyan"> ({currentBranch})</Text>
            )}
          </Text>
        </Box>

        {/* Separator line */}
        <Box>
          <Text dimColor>{'─'.repeat(terminalSize.width - 2)}</Text>
        </Box>

        {/* Session list */}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {showScrollUp && (
            <Box justifyContent="center" width="100%">
              <Text dimColor>↑ more</Text>
            </Box>
          )}

          {filteredSessions.length === 0 ? (
            <Box paddingY={1} justifyContent="center">
              <Text dimColor>
                {filterByBranch
                  ? `No sessions found for branch "${currentBranch}"`
                  : 'No sessions found'}
              </Text>
            </Box>
          ) : (
            visibleSessions.map((session, visibleIndex) => {
              const actualIndex = scrollOffset + visibleIndex;
              const isSelected = actualIndex === selectedIndex;
              const timeAgo = formatRelativeTime(session.mtime);
              const messageText =
                session.messageCount === 1
                  ? '1 message'
                  : `${session.messageCount} messages`;

              return (
                <Box key={session.sessionId} flexDirection="column">
                  {/* First line: selector + prompt text */}
                  <Box>
                    <Text color={isSelected ? 'green' : undefined}>
                      {isSelected ? '› ' : '  '}
                    </Text>
                    <Text
                      bold={isSelected}
                      color={isSelected ? 'white' : undefined}
                      wrap="truncate"
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
                    <Text dimColor>
                      {timeAgo} · {messageText}
                      {session.gitBranch && (
                        <>
                          {' · '}
                          <Text color="magenta">{session.gitBranch}</Text>
                        </>
                      )}
                    </Text>
                  </Box>
                </Box>
              );
            })
          )}

          {showScrollDown && (
            <Box justifyContent="center" width="100%">
              <Text dimColor>↓ more</Text>
            </Box>
          )}
        </Box>

        {/* Separator line */}
        <Box>
          <Text dimColor>{'─'.repeat(terminalSize.width - 2)}</Text>
        </Box>

        {/* Footer with keyboard shortcuts */}
        <Box justifyContent="center" paddingX={1}>
          <Text dimColor>
            {currentBranch && (
              <>
                <Text
                  bold={filterByBranch}
                  color={filterByBranch ? 'cyan' : undefined}
                >
                  B
                </Text>
                {' to toggle branch · '}
              </>
            )}
            {'↑↓ to navigate · Enter to select · Esc to cancel'}
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

  // Enable raw mode for keyboard input
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
      // Clear screen after picker closes
      clearScreen();
      // Restore raw mode state
      if (process.stdin.isTTY && !wasRaw) {
        process.stdin.setRawMode(false);
      }
      resolve(selectedId);
    });
  });
}
