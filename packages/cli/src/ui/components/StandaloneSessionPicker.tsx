/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { render, Box, Text, useApp } from 'ink';
import { SessionService, getGitBranch } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { useSessionPicker } from '../hooks/useStandaloneSessionPicker.js';
import { SessionListItemView } from './SessionListItem.js';
import { t } from '../../i18n/index.js';

// Exported for testing
export interface SessionPickerProps {
  sessionService: SessionService;
  currentBranch?: string;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

// Prefix characters for standalone fullscreen picker
const STANDALONE_PREFIX_CHARS = {
  selected: '› ',
  scrollUp: '↑ ',
  scrollDown: '↓ ',
  normal: '  ',
};

// Exported for testing
export function SessionPicker({
  sessionService,
  currentBranch,
  onSelect,
  onCancel,
}: SessionPickerProps): React.JSX.Element {
  const { exit } = useApp();
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

  // Calculate visible items
  // Reserved space: header (1), footer (1), separators (2), borders (2)
  const reservedLines = 6;
  // Each item takes 2 lines (prompt + metadata) + 1 line margin between items
  const itemHeight = 3;
  const maxVisibleItems = Math.max(
    1,
    Math.floor((terminalSize.height - reservedLines) / itemHeight),
  );

  const handleExit = () => {
    setIsExiting(true);
    exit();
  };

  const picker = useSessionPicker({
    sessionService,
    currentBranch,
    onSelect,
    onCancel,
    maxVisibleItems,
    centerSelection: true,
    onExit: handleExit,
    isActive: !isExiting,
  });

  // Calculate content width (terminal width minus border padding)
  const contentWidth = terminalSize.width - 4;
  const promptMaxWidth = contentWidth - 4;

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
        <Box paddingX={1}>
          <Text bold color={theme.text.primary}>
            {t('Resume Session')}
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
          {picker.filteredSessions.length === 0 ? (
            <Box paddingY={1} justifyContent="center">
              <Text color={theme.text.secondary}>
                {picker.filterByBranch
                  ? t('No sessions found for branch "{{branch}}"', {
                      branch: currentBranch ?? '',
                    })
                  : t('No sessions found')}
              </Text>
            </Box>
          ) : (
            picker.visibleSessions.map((session, visibleIndex) => {
              const actualIndex = picker.scrollOffset + visibleIndex;
              return (
                <SessionListItemView
                  key={session.sessionId}
                  session={session}
                  isSelected={actualIndex === picker.selectedIndex}
                  isFirst={visibleIndex === 0}
                  isLast={visibleIndex === picker.visibleSessions.length - 1}
                  showScrollUp={picker.showScrollUp}
                  showScrollDown={picker.showScrollDown}
                  maxPromptWidth={promptMaxWidth}
                  prefixChars={STANDALONE_PREFIX_CHARS}
                  boldSelectedPrefix={false}
                />
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
                  bold={picker.filterByBranch}
                  color={picker.filterByBranch ? theme.text.accent : undefined}
                >
                  B
                </Text>
                {t(' to toggle branch') + ' · '}
              </>
            )}
            {t('to navigate · Esc to cancel')}
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
  const hasSession = await sessionService.loadLastSession();
  if (!hasSession) {
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
        sessionService={sessionService}
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
