/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import type { ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let EmbeddedApp: ComponentType;

interface CapturedProps {
  [key: string]: unknown;
}

interface RenderedApp {
  container: HTMLElement;
  root: Root;
}

const mocks = vi.hoisted(() => ({
  vscode: {
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
  },
  session: {
    qwenSessions: [
      { id: 'session-1', title: 'Session one', messageCount: 2 },
    ] as Array<Record<string, unknown>>,
    currentSessionId: 'session-1' as string | null,
    currentSessionTitle: 'Session one',
    showSessionSelector: false,
    sessionSearchQuery: '',
    filteredSessions: [
      { id: 'session-1', title: 'Session one', messageCount: 2 },
    ] as Array<Record<string, unknown>>,
    hasMore: true,
    isLoading: false,
    isSwitchingSession: false,
    setSessionSearchQuery: vi.fn(),
    setShowSessionSelector: vi.fn(),
    handleLoadQwenSessions: vi.fn(),
    handleLoadMoreSessions: vi.fn(),
    handleSwitchSession: vi.fn(),
    handleNewQwenSession: vi.fn(),
    handleDeleteSession: vi.fn(),
    handleRenameSession: vi.fn(),
    setQwenSessions: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setCurrentSessionTitle: vi.fn(),
    setNextCursor: vi.fn(),
    setHasMore: vi.fn(),
    setIsLoading: vi.fn(),
    setIsSwitchingSession: vi.fn(),
  },
  fileContext: {
    activeFileName: 'editor.ts',
    activeFilePath: '/workspace/editor.ts',
    activeSelection: { startLine: 3, endLine: 5 },
    workspaceFiles: [],
    hasRequestedFiles: true,
    getFileReferences: vi.fn(() => [
      { name: 'main.ts', value: '/workspace/src/main.ts' },
    ]),
    searchWorkspaceFiles: vi.fn(async () => []),
    clearFileReferences: vi.fn(),
    addFileReference: vi.fn(),
    requestWorkspaceFiles: vi.fn(),
    requestActiveEditor: vi.fn(),
    focusActiveEditor: vi.fn(),
    setActiveFileName: vi.fn(),
    setActiveFilePath: vi.fn(),
    setActiveSelection: vi.fn(),
    setWorkspaceFiles: vi.fn(),
    setWorkspaceFilesFromResponse: vi.fn(),
  },
  messageHandling: {
    messages: [] as Array<{
      role: 'assistant';
      content: string;
      timestamp: number;
      localOnly?: boolean;
    }>,
    isStreaming: false,
    isWaitingForResponse: false,
    setWaitingForResponse: vi.fn(),
    clearWaitingForResponse: vi.fn(),
    endStreaming: vi.fn(),
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    setMessages: vi.fn(),
  },
  tools: {
    inProgressToolCalls: [],
    handleToolCallUpdate: vi.fn(),
    clearToolCalls: vi.fn(),
    rewindToolCallsToTimestamp: vi.fn(),
  },
  blocks: {
    current: [
      {
        id: 'assistant-1',
        kind: 'assistant',
        text: 'assistant reply',
      } as unknown as DaemonTranscriptBlock,
    ],
  },
  embeddedProps: { current: null as CapturedProps | null },
  webViewMessageProps: { current: null as CapturedProps | null },
}));

vi.mock('@qwen-code/web-shell', () => ({
    EmbeddedWebShell: (props: CapturedProps) => {
      mocks.embeddedProps.current = props;
      return null;
    },
  }));

vi.mock('./hooks/useVSCode.js', () => ({
  useVSCode: () => mocks.vscode,
}));

vi.mock('./hooks/session/useSessionManagement.js', () => ({
  useSessionManagement: () => mocks.session,
}));

vi.mock('./hooks/file/useFileContext.js', () => ({
  useFileContext: () => mocks.fileContext,
}));

vi.mock('./hooks/message/useMessageHandling.js', () => ({
  useMessageHandling: () => mocks.messageHandling,
}));

vi.mock('./hooks/useToolCalls.js', () => ({
  useToolCalls: () => mocks.tools,
}));

vi.mock('./hooks/useAcpTranscript.js', () => ({
  useAcpTranscript: () => mocks.blocks.current,
}));

vi.mock('./hooks/useWebViewMessages.js', () => ({
  useWebViewMessages: (props: CapturedProps) => {
    mocks.webViewMessageProps.current = props;
  },
}));

const mounted: RenderedApp[] = [];

async function renderApp(): Promise<CapturedProps> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<EmbeddedApp />);
    await Promise.resolve();
    await Promise.resolve();
  });
  for (
    let attempt = 0;
    attempt < 5 && !mocks.embeddedProps.current;
    attempt++
  ) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
  mounted.push({ container, root });
  const props = mocks.embeddedProps.current;
  expect(props).not.toBeNull();
  return props as CapturedProps;
}

function callback<T extends (...args: never[]) => unknown>(
  props: CapturedProps,
  name: string,
): T {
  const value = props[name];
  expect(value).toEqual(expect.any(Function));
  return value as T;
}

function postMessagesOfType(type: string): unknown[] {
  return mocks.vscode.postMessage.mock.calls
    .map(([message]) => message as { type?: string })
    .filter((message) => message.type === type)
    .map((message) => message);
}

beforeAll(async () => {
  ({ EmbeddedApp } = await import('./EmbeddedApp.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.embeddedProps.current = null;
  mocks.webViewMessageProps.current = null;
  mocks.messageHandling.messages = [];
  mocks.messageHandling.isStreaming = false;
  mocks.messageHandling.isWaitingForResponse = false;
  mocks.blocks.current = [
    {
      id: 'assistant-1',
      kind: 'assistant',
      text: 'assistant reply',
    } as unknown as DaemonTranscriptBlock,
  ];
});

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('EmbeddedApp host wiring', () => {
  it('maps composer submissions to the existing ACP sendMessage contract', async () => {
    const props = await renderApp();
    const submit = callback<
      (submission: {
        text: string;
        images?: Array<{ data: string; media_type: string }>;
        files?: Array<{ name: string; media_type: string; text?: string }>;
        inputAnnotations?: unknown[];
      }) => boolean
    >(props, 'onSubmit');

    expect(
      submit({
        text: 'Explain @main.ts',
        images: [{ data: 'aGVsbG8=', media_type: 'image/png' }],
        files: [
          { name: 'notes.md', media_type: 'text/markdown', text: '# Notes' },
        ],
        inputAnnotations: [{ type: 'file', text: '@main.ts' }],
      }),
    ).toBe(true);

    const message = postMessagesOfType('sendMessage').at(-1) as {
      data: {
        text: string;
        context: Array<Record<string, unknown>>;
        attachments: Array<Record<string, unknown>>;
        inlineFiles: Array<Record<string, unknown>>;
        fileContext: Record<string, unknown>;
        inputAnnotations: unknown[];
      };
    };
    expect(message.data.text).toBe('Explain @main.ts');
    expect(message.data.context).toEqual([
      {
        type: 'file',
        name: 'main.ts',
        value: '/workspace/src/main.ts',
        isImage: false,
      },
      {
        type: 'file',
        name: 'editor.ts',
        value: '/workspace/editor.ts',
        startLine: 3,
        endLine: 5,
        isImage: false,
      },
    ]);
    expect(message.data.fileContext).toEqual({
      fileName: 'editor.ts',
      filePath: '/workspace/editor.ts',
      startLine: 3,
      endLine: 5,
    });
    expect(message.data.attachments[0]).toMatchObject({
      type: 'image/png',
      data: 'aGVsbG8=',
    });
    expect(message.data.inlineFiles).toEqual([
      { name: 'notes.md', mediaType: 'text/markdown', text: '# Notes' },
    ]);
    expect(message.data.inputAnnotations).toEqual([
      { type: 'file', text: '@main.ts' },
    ]);
    expect(mocks.messageHandling.setWaitingForResponse).toHaveBeenCalledOnce();
    expect(mocks.fileContext.clearFileReferences).toHaveBeenCalledOnce();
  });

  it('maps permission, question, history, model, mode, and copy host actions', async () => {
    await renderApp();
    const webViewProps = mocks.webViewMessageProps.current as CapturedProps;
    const handlePermissionRequest = callback<(request: unknown) => void>(
      webViewProps,
      'handlePermissionRequest',
    );
    const handleAskUserQuestion = callback<(request: unknown) => void>(
      webViewProps,
      'handleAskUserQuestion',
    );

    await act(async () => {
      callback<(authenticated: boolean) => void>(
        webViewProps,
        'setIsAuthenticated',
      )(true);
      await Promise.resolve();
    });

    await act(async () => {
      handlePermissionRequest({
        options: [
          { name: 'Allow once', kind: 'allow_once', optionId: 'proceed_once' },
          { name: 'Reject', kind: 'reject_once', optionId: 'cancel' },
        ],
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'bash',
          title: 'Run command',
          rawInput: { command: 'npm test' },
          content: [],
        },
      });
      handleAskUserQuestion({
        sessionId: 'session-1',
        questions: [
          {
            header: 'Keep?',
            question: 'Keep current changes?',
            multiSelect: false,
            options: [{ label: 'Keep', description: 'Keep current changes' }],
          },
        ],
      });
      callback<(path: string | null) => void>(
        webViewProps,
        'setInsightReportPath',
      )('/workspace/insight.md');
      await Promise.resolve();
    });

    const props = mocks.embeddedProps.current as CapturedProps;
    expect(props.pendingPermission).toMatchObject({
      id: 'tool-1',
      kind: 'bash',
      options: [
        { id: 'proceed_once', kind: 'allow_once' },
        { id: 'cancel', kind: 'reject_once' },
      ],
    });
    expect(props.pendingQuestion).toMatchObject({
      id: 'session-1',
      kind: 'ask_user_question',
      rawInput: expect.objectContaining({ questions: expect.any(Array) }),
    });
    expect(props.notices).toContainEqual({
      id: 'insight-report',
      message: 'Insight report: /workspace/insight.md',
      actionLabel: 'Open report',
    });

    await act(async () => {
      callback<(requestId: string, optionId: string) => void>(
        props,
        'onPermissionResponse',
      )('tool-1', 'proceed_once');
      await callback<
        (
          requestId: string,
          optionId: string,
          answers?: Record<string, string>,
        ) => Promise<boolean>
      >(props, 'onQuestionResponse')('session-1', 'proceed_once', {
        '0': 'Keep',
      });
    });
    expect(postMessagesOfType('permissionResponse').at(-1)).toEqual({
      type: 'permissionResponse',
      data: { optionId: 'proceed_once' },
    });
    expect(postMessagesOfType('askUserQuestionResponse').at(-1)).toEqual({
      type: 'askUserQuestionResponse',
      data: { answers: { '0': 'Keep' }, cancelled: false },
    });
    callback<(noticeId: string) => void>(
      props,
      'onNoticeAction',
    )('insight-report');
    expect(postMessagesOfType('openInsightReport').at(-1)).toEqual({
      type: 'openInsightReport',
      data: { path: '/workspace/insight.md' },
    });

    const historyOpenChange = callback<(open: boolean) => void>(
      props,
      'onHistoryOpenChange',
    );
    historyOpenChange(true);
    callback<(sessionId: string) => void>(
      props,
      'onSessionSelect',
    )('session-2');
    callback<() => void>(props, 'onLoadMoreSessions')();
    callback<(modelId: string) => void>(props, 'onSelectModel')('qwen-next');
    callback<(modeId: string) => void>(props, 'onSelectMode')('yolo');
    expect(mocks.session.handleLoadQwenSessions).toHaveBeenCalledOnce();
    expect(mocks.session.handleSwitchSession).toHaveBeenCalledWith('session-2');
    expect(mocks.session.handleLoadMoreSessions).toHaveBeenCalledOnce();
    expect(mocks.vscode.postMessage).toHaveBeenCalledWith({
      type: 'setModel',
      data: { modelId: 'qwen-next' },
    });
    expect(mocks.vscode.postMessage).toHaveBeenCalledWith({
      type: 'setApprovalMode',
      data: { modeId: 'yolo' },
    });

    const host = document.createElement('div');
    host.setAttribute('data-web-shell-embedded-host', '');
    const row = document.createElement('div');
    row.setAttribute('data-message-row-key', 'msg:assistant-1');
    host.appendChild(row);
    document.body.appendChild(host);
    expect(row).not.toBeNull();
    act(() =>
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
    );
    expect(postMessagesOfType('contextMenuTriggered')).toHaveLength(1);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'copyCommand', data: { action: 'copyMessage' } },
        }),
      );
    });
    expect(postMessagesOfType('copyToClipboard').at(-1)).toEqual({
      type: 'copyToClipboard',
      data: { text: 'assistant reply' },
    });
    host.remove();
  });
});
