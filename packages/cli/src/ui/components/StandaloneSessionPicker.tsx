/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { render, Box, useApp } from 'ink';
import { getGitBranch, SessionService } from '@qwen-code/qwen-code-core';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { SessionPicker } from './SessionPicker.js';

interface StandalonePickerScreenProps {
  sessionService: SessionService;
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
  currentBranch?: string;
}

function StandalonePickerScreen({
  sessionService,
  onSelect,
  onCancel,
  currentBranch,
}: StandalonePickerScreenProps): React.JSX.Element {
  const { exit } = useApp();
  const [isExiting, setIsExiting] = useState(false);
  const handleExit = () => {
    setIsExiting(true);
    exit();
  };

  // Return empty while exiting to prevent visual glitches
  if (isExiting) {
    return <Box />;
  }

  return (
    <SessionPicker
      sessionService={sessionService}
      onSelect={(id) => {
        onSelect(id);
        handleExit();
      }}
      onCancel={() => {
        onCancel();
        handleExit();
      }}
      currentBranch={currentBranch}
      centerSelection={true}
    />
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
      <KeypressProvider
        kittyProtocolEnabled={false}
        pasteWorkaround={
          process.platform === 'win32' ||
          parseInt(process.versions.node.split('.')[0], 10) < 20
        }
      >
        <StandalonePickerScreen
          sessionService={sessionService}
          onSelect={(id) => {
            selectedId = id;
          }}
          onCancel={() => {
            selectedId = undefined;
          }}
          currentBranch={getGitBranch(cwd)}
        />
      </KeypressProvider>,
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
