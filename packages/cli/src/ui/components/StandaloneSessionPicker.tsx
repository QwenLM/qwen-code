/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { render, Box, useApp } from 'ink';
import {
  getGitBranch,
  SessionService,
  type Config,
  type SessionListItem,
} from '@qwen-code/qwen-code-core';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import { SessionPicker } from './SessionPicker.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { listManagedAgentViewResumeSessions } from '../../startup/agent-view-resume-sessions.js';

/**
 * `--resume` runs this picker BEFORE `loadCliConfig`, so no real Config /
 * LoadedSettings exist yet. But the preview render tree (HistoryItemDisplay
 * → ToolGroupMessage → ToolMessage) calls `useConfig()` / `useSettings()`,
 * which throw without a Provider mounted.
 *
 * These stubs satisfy the Context consumers. Every downstream access of
 * Config/Settings in the preview path is either optional-chained or gated
 * on states (Confirming / Executing) that never occur in resumed session
 * data, so the stubbed methods are only read, never invoked for real work.
 * Tool descriptions fall back to the raw function-call name (see
 * `buildResumedHistoryItems` handling when the registry returns undefined).
 */
const PREVIEW_CONFIG_STUB = {
  getShouldUseNodePtyShell: () => false,
  getIdeMode: () => false,
  isTrustedFolder: () => false,
  getToolRegistry: () => ({ getTool: () => undefined }),
  getContentGenerator: () => ({ useSummarizedThinking: () => false }),
} as unknown as Config;

const PREVIEW_SETTINGS_STUB = {
  merged: { ui: {} },
} as unknown as LoadedSettings;

interface StandalonePickerScreenProps {
  sessionService: SessionService;
  onSelect: (session: SessionListItem) => void;
  onCancel: () => void;
  currentBranch?: string;
  initialSessions?: SessionListItem[];
  excludeSessionIds?: readonly string[];
  includeAgentViewSessions?: boolean;
  allowManagedAgentViewSelection?: boolean;
}

function StandalonePickerScreen({
  sessionService,
  onSelect,
  onCancel,
  currentBranch,
  initialSessions,
  excludeSessionIds,
  includeAgentViewSessions = true,
  allowManagedAgentViewSelection,
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
    <ConfigContext.Provider value={PREVIEW_CONFIG_STUB}>
      <SettingsContext.Provider value={PREVIEW_SETTINGS_STUB}>
        <SessionPicker
          sessionService={sessionService}
          onSelect={(id, session) => {
            onSelect(session ?? makeFallbackSessionItem(id, sessionService));
            handleExit();
          }}
          onCancel={() => {
            onCancel();
            handleExit();
          }}
          currentBranch={currentBranch}
          centerSelection={true}
          initialSessions={initialSessions}
          excludeSessionIds={excludeSessionIds}
          enablePreview
          includeAgentViewSessions={
            includeAgentViewSessions && initialSessions === undefined
          }
          allowManagedAgentViewSelection={allowManagedAgentViewSelection}
        />
      </SettingsContext.Provider>
    </ConfigContext.Provider>
  );
}

/**
 * Clears the terminal screen.
 */
function clearScreen(): void {
  // Reset terminal state before fullscreen picker rendering. The explicit
  // alt-screen exit prevents stale alternate-buffer content from surfacing
  // when Agent View hands off between Ink apps.
  process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l\x1b[2J\x1b[H');
}

/**
 * Shows an interactive session picker and returns the selected session ID.
 * Returns undefined if the user cancels or no sessions are available.
 */
export async function showResumeSessionPicker(
  cwd: string = process.cwd(),
  initialSessions?: SessionListItem[],
  options: {
    includeAgentViewSessions?: boolean;
    allowManagedAgentViewSelection?: boolean;
  } = {},
): Promise<string | undefined> {
  return (await showResumeSessionPickerItem(cwd, initialSessions, options))
    ?.sessionId;
}

export async function showResumeSessionPickerItem(
  cwd: string = process.cwd(),
  initialSessions?: SessionListItem[],
  options: {
    includeAgentViewSessions?: boolean;
    allowManagedAgentViewSelection?: boolean;
  } = {},
): Promise<SessionListItem | undefined> {
  const sessionService = new SessionService(cwd);
  const hasSession = await hasResumeSession(sessionService, initialSessions);
  const includeAgentViewSessions = options.includeAgentViewSessions ?? true;
  const managedSessions = includeAgentViewSessions
    ? await listManagedAgentViewResumeSessions().catch(() => [])
    : [];
  const displayManagedSessions = includeAgentViewSessions
    ? managedSessions
    : [];
  if (!hasSession && displayManagedSessions.length === 0) {
    writeStdoutLine('No sessions found. Start a new session with `qwen`.');
    return undefined;
  }

  // Clear the screen before showing the picker for a clean fullscreen experience
  clearScreen();

  // Enable raw mode for keyboard input if not already enabled
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY && !wasRaw) {
    process.stdin.setRawMode(true);
  }

  return new Promise<SessionListItem | undefined>((resolve) => {
    let selectedSession: SessionListItem | undefined;

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
          onSelect={(session) => {
            selectedSession = session;
          }}
          onCancel={() => {
            selectedSession = undefined;
          }}
          currentBranch={getGitBranch(cwd)}
          initialSessions={initialSessions}
          excludeSessionIds={
            includeAgentViewSessions
              ? undefined
              : managedSessions.map((session) => session.sessionId)
          }
          includeAgentViewSessions={includeAgentViewSessions}
          allowManagedAgentViewSelection={
            options.allowManagedAgentViewSelection
          }
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

      // Restore raw mode state if this standalone picker changed it.
      if (process.stdin.isTTY && !wasRaw) {
        process.stdin.setRawMode(false);
      }

      resolve(selectedSession);
    });
  });
}

async function hasResumeSession(
  sessionService: SessionService,
  initialSessions: SessionListItem[] | undefined,
): Promise<boolean> {
  if (initialSessions) {
    return initialSessions.length > 0;
  }
  return (await sessionService.listSessions({ size: 1 })).items.length > 0;
}

function makeFallbackSessionItem(
  sessionId: string,
  sessionService: SessionService,
): SessionListItem {
  return {
    sessionId,
    cwd: sessionService.getProjectRoot(),
    startTime: new Date().toISOString(),
    mtime: Date.now(),
    prompt: sessionId,
    filePath: '',
  };
}
