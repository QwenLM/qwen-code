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
  DesktopTerminal,
} from '../../api/client.js';
import { chatReducer, createInitialChatState } from '../../stores/chatStore.js';
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
      'sidebar-app-actions',
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
    expect(renderedContainer.querySelector('.sidebar-toolbar')).toBeNull();
    expect(
      renderedContainer.querySelector(
        '[data-testid="sidebar-footer-settings"]',
      ),
    ).toBeTruthy();

    expect(renderedContainer.textContent).toContain('example-workspace');
    expect(renderedContainer.textContent).toContain('main');
    expect(renderedContainer.textContent).toContain('New Thread');
    expect(renderedContainer.textContent).toContain('Open Project');
    expect(renderedContainer.textContent).toContain('Models');
    expect(
      renderedContainer.querySelector('[data-testid="project-sidebar"]')
        ?.textContent,
    ).not.toContain('src/index.ts');
    expect(renderedContainer.textContent).toContain('Terminal');
    expect(renderedContainer.textContent).toContain('Idle');
    expect(renderedContainer.textContent).toContain('No recent command');
    expect(renderedContainer.textContent).not.toContain('No terminal output');
    const topbar = renderedContainer.querySelector(
      '[data-testid="workspace-topbar"]',
    );
    const topbarContext = renderedContainer.querySelector(
      '[data-testid="topbar-context"]',
    );
    expect(topbar).toBeTruthy();
    expect(topbarContext).toBeTruthy();
    expect(topbar?.querySelector('.topbar-meta')).toBeNull();
    expect(
      topbarContext?.querySelectorAll('.topbar-context-item'),
    ).toHaveLength(3);
    expect(topbarContext?.textContent).toContain('Connected');
    expect(topbarContext?.textContent).toContain('main');
    expect(topbarContext?.textContent).toContain('1 modified');
    expect(
      topbar?.querySelector('[data-testid="topbar-runtime-status"]')
        ?.textContent,
    ).toContain('Ready');
    expect(
      renderedContainer.querySelector('[data-testid="terminal-body"]'),
    ).toBeNull();
    expect(
      renderedContainer
        .querySelector('button[aria-label="Expand Terminal"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(renderedContainer.querySelector('.topbar-nav')).toBeNull();
    expect(
      renderedContainer.querySelector('button[aria-label="Open Changes"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector(
        '[data-testid="conversation-changes-summary"]',
      ),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain('1 file changed');
    expect(renderedContainer.textContent).toContain('+1');
    expect(renderedContainer.textContent).toContain('-1');

    act(() => {
      clickButton(renderedContainer, 'Review Changes');
    });

    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="chat-thread"]'),
    ).toBeTruthy();

    act(() => {
      clickButton(renderedContainer, 'Conversation');
    });

    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Expand Terminal');
    });

    expect(
      renderedContainer.querySelector('[data-testid="terminal-body"]'),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain('No terminal output');
    expect(
      renderedContainer.querySelector('button[aria-label="Copy Output"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('button[aria-label="Attach Output"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('button[aria-label="Send to AI"]'),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Open Changes');
    });

    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="chat-thread"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('button[aria-label="Close Changes"]'),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain('src/index.ts');
    expect(renderedContainer.textContent).toContain('Fix parser test');
    expect(renderedContainer.textContent).toContain('Stage Hunk');
    expect(renderedContainer.textContent).toContain('Discard Hunk');
    expect(renderedContainer.textContent).not.toContain('Accept');
    expect(renderedContainer.textContent).not.toContain('Revert');

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
      renderedContainer.querySelector('[data-testid="permissions-config"]'),
    ).toBeTruthy();
    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeNull();
    expect(
      renderedContainer.querySelector('[data-testid="terminal-drawer"]'),
    ).toBeNull();
    const settingsText =
      renderedContainer.querySelector('[data-testid="settings-page"]')
        ?.textContent ?? '';
    for (const section of [
      'Account',
      'Model Providers',
      'Permissions',
      'Tools & MCP',
      'Terminal',
      'Appearance',
      'Advanced',
    ]) {
      expect(settingsText).toContain(section);
    }
    expect(settingsText).not.toContain(readyStatus.serverUrl);
    expect(settingsText).not.toContain(readyStatus.runtime.desktop.nodeVersion);
    expect(settingsText).not.toContain('ACP');
    expect(settingsText).not.toContain(session.sessionId);
    expect(
      renderedContainer.querySelector('[data-testid="runtime-diagnostics"]'),
    ).toBeNull();

    act(() => {
      clickButton(renderedContainer, 'Advanced Diagnostics');
    });

    const advancedDiagnostics = renderedContainer.querySelector(
      '[data-testid="advanced-diagnostics"]',
    );
    expect(advancedDiagnostics).toBeTruthy();
    expect(advancedDiagnostics?.textContent).toContain(readyStatus.serverUrl);
    expect(advancedDiagnostics?.textContent).toContain(
      readyStatus.runtime.desktop.nodeVersion,
    );
    expect(advancedDiagnostics?.textContent).toContain('ACP');
    expect(advancedDiagnostics?.textContent).toContain(session.sessionId);
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

  it('renders command approvals inline in the conversation timeline', () => {
    const onPermissionResponse = vi.fn();
    const chatState = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'permission_request',
        requestId: 'permission-1',
        request: {
          sessionId: session.sessionId,
          toolCall: {
            toolCallId: 'tool-1',
            kind: 'execute',
            title: 'Run tests',
            status: 'pending',
            rawInput: 'npm test',
          },
          options: [
            {
              optionId: 'approve_once',
              name: 'Approve Once',
              kind: 'allow_once',
            },
            {
              optionId: 'deny',
              name: 'Deny',
              kind: 'reject_once',
            },
          ],
        },
      },
    });

    const renderedContainer = renderWorkspace({
      chatState,
      onPermissionResponse,
    });
    const approvalCard = renderedContainer.querySelector(
      '[data-testid="conversation-approval-card"]',
    );

    expect(approvalCard).toBeTruthy();
    expect(approvalCard?.textContent).toContain('Run tests');
    expect(approvalCard?.textContent).toContain('npm test');
    expect(renderedContainer.querySelector('.permission-strip')).toBeNull();
    expect(renderedContainer.textContent).not.toContain('Permission requested');

    act(() => {
      clickButton(renderedContainer, 'Approve Once');
    });

    expect(onPermissionResponse).toHaveBeenCalledWith(
      'permission-1',
      'approve_once',
    );
  });

  it('renders rich tool activity cards with file references', () => {
    const chatState = chatReducer(createInitialChatState(), {
      type: 'server_message',
      message: {
        type: 'tool_call',
        data: {
          toolCallId: 'internal-tool-123',
          kind: 'execute',
          title: 'Run focused tests',
          status: 'completed',
          rawInput: {
            command: 'npm test -- WorkspacePage.test.tsx',
            sessionId: 'session-should-stay-hidden',
          },
          rawOutput: 'tests passed',
          locations: [{ path: 'src/renderer/WorkspacePage.tsx', line: 42 }],
        },
      },
    });

    const renderedContainer = renderWorkspace({ chatState });
    const toolCard = renderedContainer.querySelector(
      '[data-testid="conversation-tool-card"]',
    );
    const toolText = toolCard?.textContent ?? '';

    expect(toolCard).toBeTruthy();
    expect(toolText).toContain('execute');
    expect(toolText).toContain('Run focused tests');
    expect(toolText).toContain('completed');
    expect(toolText).toContain('npm test -- WorkspacePage.test.tsx');
    expect(toolText).toContain('tests passed');
    expect(toolText).toContain('src/renderer/WorkspacePage.tsx:42');
    expect(toolText).not.toContain('internal-tool-123');
    expect(toolText).not.toContain('session-should-stay-hidden');
    expect(renderedContainer.querySelector('.chat-tool')).toBeNull();
  });

  it('renders assistant message actions and clickable file reference chips', () => {
    const onCopyMessage = vi.fn();
    const onOpenReviewFile = vi.fn();
    const onRetryMessage = vi.fn();
    let chatState = chatReducer(createInitialChatState(), {
      type: 'append_user_message',
      content: 'Summarize the project changes',
    });
    chatState = chatReducer(chatState, {
      type: 'server_message',
      message: {
        type: 'message_delta',
        role: 'assistant',
        text: 'Updated README.md:1 and packages/desktop/src/renderer/App.tsx:12.',
      },
    });
    chatState = chatReducer(chatState, {
      type: 'server_message',
      message: { type: 'message_complete' },
    });

    const renderedContainer = renderWorkspace({
      chatState,
      onCopyMessage,
      onOpenFileReference: onOpenReviewFile,
      onOpenReviewFile,
      onRetryMessage,
    });
    const assistantMessage = renderedContainer.querySelector(
      '[data-testid="assistant-message"]',
    );
    const actionRow = renderedContainer.querySelector(
      '[data-testid="assistant-message-actions"]',
    );
    const fileReferences = renderedContainer.querySelector(
      '[data-testid="assistant-file-references"]',
    );

    expect(assistantMessage?.textContent).toContain('README.md:1');
    expect(actionRow).toBeTruthy();
    expect(fileReferences?.textContent).toContain('README.md:1');
    expect(fileReferences?.textContent).toContain(
      'packages/desktop/src/renderer/App.tsx:12',
    );

    act(() => {
      (
        actionRow?.querySelector(
          'button[aria-label="Copy Response"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onCopyMessage).toHaveBeenCalledWith(
      'Updated README.md:1 and packages/desktop/src/renderer/App.tsx:12.',
    );

    act(() => {
      (
        actionRow?.querySelector(
          'button[aria-label="Retry Last Prompt"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onRetryMessage).toHaveBeenCalledWith(
      'Summarize the project changes',
    );

    act(() => {
      (
        fileReferences?.querySelector(
          'button[aria-label="Open README.md:1"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onOpenReviewFile).toHaveBeenCalledWith('README.md');

    act(() => {
      (
        actionRow?.querySelector(
          'button[aria-label="Open Changes"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      renderedContainer.querySelector('[data-testid="review-panel"]'),
    ).toBeTruthy();
  });

  it('deduplicates and bounds dense assistant file reference chips', () => {
    const onOpenFileReference = vi.fn();
    let chatState = chatReducer(createInitialChatState(), {
      type: 'append_user_message',
      content: 'List the touched files',
    });
    chatState = chatReducer(chatState, {
      type: 'server_message',
      message: {
        type: 'message_delta',
        role: 'assistant',
        text:
          'Touched README.md:1, README.md:1 again, ' +
          'packages/desktop/src/renderer/App.tsx:12:5, .env.example, ' +
          'Dockerfile, docs/guide.mdx, src/App.vue, Makefile, ' +
          'and config/settings.mts.',
      },
    });
    chatState = chatReducer(chatState, {
      type: 'server_message',
      message: { type: 'message_complete' },
    });

    const renderedContainer = renderWorkspace({
      chatState,
      onOpenFileReference,
    });
    const fileReferences = renderedContainer.querySelector(
      '[data-testid="assistant-file-references"]',
    );
    const labels = [...(fileReferences?.querySelectorAll('button') ?? [])].map(
      (button) => button.getAttribute('aria-label'),
    );
    const overflow = fileReferences?.querySelector(
      '.message-file-reference-overflow',
    );

    expect(labels).toEqual([
      'Open README.md:1',
      'Open packages/desktop/src/renderer/App.tsx:12:5',
      'Open .env.example',
      'Open Dockerfile',
      'Open docs/guide.mdx',
      'Open src/App.vue',
    ]);
    expect(labels.filter((label) => label === 'Open README.md:1')).toHaveLength(
      1,
    );
    expect(overflow?.textContent).toBe('+2 more');
    expect(overflow?.getAttribute('aria-label')).toBe('2 more file references');

    act(() => {
      (
        fileReferences?.querySelector(
          'button[aria-label="Open packages/desktop/src/renderer/App.tsx:12:5"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(onOpenFileReference).toHaveBeenCalledWith(
      'packages/desktop/src/renderer/App.tsx',
    );
  });

  it('routes terminal output through an attach action', () => {
    const onAttachTerminalOutput = vi.fn();
    const renderedContainer = renderWorkspace({
      onAttachTerminalOutput,
      terminal,
    });

    act(() => {
      clickButton(renderedContainer, 'Expand Terminal');
    });

    const attachButton = renderedContainer.querySelector(
      'button[aria-label="Attach Output"]',
    );
    expect(attachButton).toBeInstanceOf(HTMLButtonElement);
    expect((attachButton as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      clickButton(renderedContainer, 'Attach Output');
    });

    expect(onAttachTerminalOutput).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before discarding review changes', () => {
    const onRevertReviewTarget = vi.fn();
    const renderedContainer = renderWorkspace({ onRevertReviewTarget });

    act(() => {
      clickButton(renderedContainer, 'Open Changes');
    });

    act(() => {
      clickButton(renderedContainer, 'Discard All');
    });

    expect(
      renderedContainer.querySelector('[data-testid="discard-confirmation"]'),
    ).toBeTruthy();
    expect(renderedContainer.textContent).toContain(
      'Discard all local changes?',
    );
    expect(onRevertReviewTarget).not.toHaveBeenCalled();

    act(() => {
      clickButton(renderedContainer, 'Cancel Discard');
    });

    expect(
      renderedContainer.querySelector('[data-testid="discard-confirmation"]'),
    ).toBeNull();
    expect(onRevertReviewTarget).not.toHaveBeenCalled();

    act(() => {
      clickButton(renderedContainer, 'Discard All');
    });
    act(() => {
      clickButton(renderedContainer, 'Confirm Discard');
    });

    expect(onRevertReviewTarget).toHaveBeenCalledWith({ scope: 'all' });
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
    chatNotice: null,
    onAskUserQuestionResponse: vi.fn(),
    onAuthenticate: vi.fn(),
    onChooseWorkspace: vi.fn(),
    onClearTerminal: vi.fn(),
    onCommit: vi.fn(),
    onCommitMessageChange: vi.fn(),
    onCopyMessage: vi.fn(),
    onCopyTerminalOutput: vi.fn(),
    onCreateSession: vi.fn(),
    onKillTerminal: vi.fn(),
    onMessageTextChange: vi.fn(),
    onModeChange: vi.fn(),
    onModelChange: vi.fn(),
    onOpenFileReference: vi.fn(),
    onPermissionResponse: vi.fn(),
    onRefreshProjectGitStatus: vi.fn(),
    onOpenReviewFile: vi.fn(),
    onRevertReviewTarget: vi.fn(),
    onRunTerminalCommand: vi.fn(),
    onSaveSettings: vi.fn(),
    onAttachTerminalOutput: vi.fn(),
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onSendMessage: (event) => event.preventDefault(),
    onSettingsDispatch: vi.fn(),
    onStageReviewTarget: vi.fn(),
    onStopGeneration: vi.fn(),
    onRetryMessage: vi.fn(),
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
  const button = [...container.querySelectorAll('button')].find((candidate) => {
    const accessibleLabel =
      candidate.getAttribute('aria-label') || candidate.getAttribute('title');
    return (
      accessibleLabel === text ||
      candidate.textContent?.trim() === text ||
      candidate.textContent?.trim().includes(text)
    );
  });
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

const terminal: DesktopTerminal = {
  id: 'terminal-1',
  projectId: project.id,
  cwd: project.path,
  command: 'printf terminal-output',
  status: 'exited',
  output: 'terminal-output',
  exitCode: 0,
  signal: null,
  createdAt: '2026-04-25T00:00:00.000Z',
  updatedAt: '2026-04-25T00:00:01.000Z',
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
