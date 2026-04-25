/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type FormEvent } from 'react';
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe('WorkspacePage', () => {
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
    const renderedContainer = renderWorkspace();

    for (const testId of [
      'desktop-workspace',
      'project-sidebar',
      'workspace-topbar',
      'workspace-grid',
      'chat-thread',
      'terminal-drawer',
      'project-list',
      'thread-list',
    ]) {
      expect(
        renderedContainer.querySelector(`[data-testid="${testId}"]`),
      ).toBeTruthy();
    }
    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="settings-page"]'),
    ).toBeNull();

    expect(renderedContainer.textContent).toContain('example-workspace');
    expect(renderedContainer.textContent).toContain('main');
    expect(renderedContainer.textContent).not.toContain('src/index.ts');
    expect(renderedContainer.textContent).toContain('No terminal output');

    act(() => {
      clickButton(renderedContainer, 'Changes');
    });

    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="chat-thread"]'),
    ).toBeNull();
    expect(renderedContainer.textContent).toContain('src/index.ts');

    act(() => {
      clickButton(renderedContainer, 'Settings');
    });

    expect(
      renderedContainer.querySelector('[data-testid="settings-page"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="model-config"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="terminal-drawer"]'),
    ).toBeNull();
  });

  it('keeps the composer enabled for an active project with no thread', () => {
    const renderedContainer = renderWorkspace({
      activeSessionId: null,
      isDraftSession: false,
      sessions: [],
    });
    const textarea = getMessageTextArea(renderedContainer);
    const permissionMode = renderedContainer.querySelector(
      'select[aria-label="Permission mode"]',
    );
    const model = renderedContainer.querySelector('select[aria-label="Model"]');

    expect(textarea.disabled).toBe(false);
    expect(textarea.placeholder).toBe('Ask Qwen Code about example-workspace');
    expect(renderedContainer.textContent).toContain(
      'Start a task in example-workspace',
    );
    expect(renderedContainer.textContent).toContain('New thread');
    expect(permissionMode).toBeInstanceOf(HTMLSelectElement);
    expect((permissionMode as HTMLSelectElement).disabled).toBe(true);
    expect(model).toBeInstanceOf(HTMLSelectElement);
    expect((model as HTMLSelectElement).disabled).toBe(true);
  });

  it('shows a clear disabled composer reason with no active project', () => {
    const renderedContainer = renderWorkspace({
      activeProject: null,
      activeProjectId: null,
      activeSessionId: null,
      isDraftSession: false,
      projects: [],
      sessions: [],
    });
    const textarea = getMessageTextArea(renderedContainer);

    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe('Open a project to start');
    expect(renderedContainer.textContent).toContain('Open a project to start');
  });

  it('submits on Enter and keeps Shift+Enter as a newline path', () => {
    const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement) {
      this.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    };
    const onSendMessage = vi.fn((event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });

    try {
      const renderedContainer = renderWorkspace({
        activeSessionId: null,
        isDraftSession: false,
        messageText: 'hello from keyboard',
        sessions: [],
        onSendMessage,
      });
      const textarea = getMessageTextArea(renderedContainer);

      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
            shiftKey: true,
          }),
        );
      });

      expect(onSendMessage).not.toHaveBeenCalled();

      act(() => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', {
            bubbles: true,
            cancelable: true,
            key: 'Enter',
          }),
        );
      });

      expect(onSendMessage).toHaveBeenCalledTimes(1);
    } finally {
      HTMLFormElement.prototype.requestSubmit = originalRequestSubmit;
    }
  });
});

type WorkspacePageProps = Parameters<typeof WorkspacePage>[0];

function renderWorkspace(
  overrides: Partial<WorkspacePageProps> = {},
): HTMLElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  const props: WorkspacePageProps = {
    activeProject: project,
    activeProjectId: project.id,
    activeSessionId: session.sessionId,
    chatState: createInitialChatState(),
    commitMessage: '',
    gitDiff,
    loadState: readyLoadState,
    messageText: '',
    modelState: createInitialModelState(),
    isDraftSession: false,
    projects: [project],
    reviewError: null,
    sessionError: null,
    sessions: [session],
    settingsState: createInitialSettingsState(),
    statusLabel: 'Connected',
    terminal: null,
    terminalCommand: '',
    terminalError: null,
    terminalInput: '',
    terminalNotice: null,
    onAskUserQuestionResponse: vi.fn(),
    onAuthenticate: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onClearTerminal: vi.fn(),
    onCommit: vi.fn(),
    onCommitMessageChange: vi.fn(),
    onCopyTerminalOutput: vi.fn(),
    onCreateSession: vi.fn(),
    onKillTerminal: vi.fn(),
    onMessageTextChange: vi.fn(),
    onModeChange: vi.fn(),
    onModelChange: vi.fn(),
    onPermissionResponse: vi.fn(),
    onRefreshProjectGitStatus: vi.fn(),
    onOpenReviewFile: vi.fn(),
    onRevertReviewTarget: vi.fn(),
    onRunTerminalCommand: vi.fn(),
    onSaveSettings: vi.fn(),
    onSendTerminalOutputToAi: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onSendMessage: (event) => event.preventDefault(),
    onSettingsDispatch: vi.fn(),
    onStageReviewTarget: vi.fn(),
    onStopGeneration: vi.fn(),
    onTerminalCommandChange: vi.fn(),
    onTerminalInputChange: vi.fn(),
    onWriteTerminalInput: vi.fn(),
    ...overrides,
  };

  act(() => {
    root?.render(<WorkspacePage {...props} />);
  });

  if (!container) {
    throw new Error('WorkspacePage test container was not created.');
  }

  return container;
}

function getMessageTextArea(
  renderedContainer: HTMLElement,
): HTMLTextAreaElement {
  const textarea = renderedContainer.querySelector(
    'textarea[aria-label="Message"]',
  );
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error('Message textarea was not rendered.');
  }

  return textarea;
}

function clickButton(container: HTMLElement, text: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }

  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

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
