/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopConnectionStatus,
  DesktopGitDiff,
  DesktopProject,
  DesktopSessionSummary,
} from '../../api/client.js';
import { createInitialChatState } from '../../stores/chatStore.js';
import { createInitialModelState } from '../../stores/modelStore.js';
import { createInitialSettingsState } from '../../stores/settingsStore.js';
import { WorkspacePage } from './WorkspacePage.js';
import type { LoadState } from './types.js';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkspacePage', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it('renders stable workbench landmarks for desktop E2E checks', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <WorkspacePage
          activeProject={project}
          activeProjectId={project.id}
          activeSessionId={session.sessionId}
          chatState={createInitialChatState()}
          commitMessage=""
          gitDiff={gitDiff}
          loadState={readyLoadState}
          messageText=""
          modelState={createInitialModelState()}
          isDraftSession={false}
          projects={[project]}
          reviewError={null}
          sessionError={null}
          sessions={[session]}
          settingsState={createInitialSettingsState()}
          statusLabel="Connected"
          terminal={null}
          terminalCommand=""
          terminalError={null}
          terminalInput=""
          terminalNotice={null}
          onAskUserQuestionResponse={vi.fn()}
          onAuthenticate={vi.fn()}
          onChooseWorkspace={vi.fn()}
          onClearTerminal={vi.fn()}
          onCommit={vi.fn()}
          onCommitMessageChange={vi.fn()}
          onCopyTerminalOutput={vi.fn()}
          onCreateSession={vi.fn()}
          onKillTerminal={vi.fn()}
          onMessageTextChange={vi.fn()}
          onModeChange={vi.fn()}
          onModelChange={vi.fn()}
          onPermissionResponse={vi.fn()}
          onRefreshProjectGitStatus={vi.fn()}
          onOpenReviewFile={vi.fn()}
          onRevertReviewTarget={vi.fn()}
          onRunTerminalCommand={vi.fn()}
          onSaveSettings={vi.fn()}
          onSendTerminalOutputToAi={vi.fn()}
          onSelectProject={vi.fn()}
          onSelectSession={vi.fn()}
          onSendMessage={(event) => event.preventDefault()}
          onSettingsDispatch={vi.fn()}
          onStageReviewTarget={vi.fn()}
          onStopGeneration={vi.fn()}
          onTerminalCommandChange={vi.fn()}
          onTerminalInputChange={vi.fn()}
          onWriteTerminalInput={vi.fn()}
        />,
      );
    });

    for (const testId of [
      'desktop-workspace',
      'project-sidebar',
      'workspace-topbar',
      'workspace-grid',
      'chat-thread',
      'review-panel',
      'terminal-drawer',
      'project-list',
      'thread-list',
    ]) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).toBeTruthy();
    }

    expect(container.textContent).toContain('example-workspace');
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('src/index.ts');
    expect(container.textContent).toContain('No terminal output');
  });
});

const project: DesktopProject = {
  id: 'project-1',
  name: 'example-workspace',
  path: '/tmp/example-workspace',
  gitBranch: 'main',
  gitStatus: {
    branch: 'main',
    modified: 1,
    staged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    clean: false,
    isRepository: true,
  },
  lastOpenedAt: 1_774_704_300_000,
};

const session: DesktopSessionSummary = {
  sessionId: 'session-1',
  title: 'Fix parser test',
  cwd: project.path,
};

const gitDiff: DesktopGitDiff = {
  ok: true,
  generatedAt: '2026-04-25T00:00:00.000Z',
  diff: 'diff --git a/src/index.ts b/src/index.ts',
  files: [
    {
      path: 'src/index.ts',
      status: 'modified',
      staged: false,
      unstaged: true,
      untracked: false,
      diff: '@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;',
      hunks: [
        {
          id: 'hunk-1',
          source: 'unstaged',
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-export const value = 1;', '+export const value = 2;'],
        },
      ],
    },
  ],
};

const readyStatus: DesktopConnectionStatus = {
  serverInfo: {
    url: 'http://127.0.0.1:47891',
    token: 'test-token',
  },
  serverUrl: 'http://127.0.0.1:47891',
  health: {
    ok: true,
    service: 'qwen-desktop',
    uptimeMs: 42,
    timestamp: '2026-04-25T00:00:00.000Z',
  },
  runtime: {
    ok: true,
    desktop: {
      version: '0.15.2',
      electronVersion: '41.3.0',
      nodeVersion: '20.19.0',
    },
    cli: {
      path: '/tmp/qwen',
      channel: 'ACP',
      acpReady: true,
    },
    platform: {
      type: 'darwin',
      arch: 'arm64',
      release: '25.0.0',
    },
    auth: {
      status: 'unknown',
      account: null,
    },
  },
};

const readyLoadState: LoadState = {
  state: 'ready',
  status: readyStatus,
};
