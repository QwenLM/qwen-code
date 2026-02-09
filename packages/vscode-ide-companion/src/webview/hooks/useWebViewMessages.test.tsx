/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import type React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';
import type { ToolCallUpdate } from '../../types/chatTypes.js';
import type { ApprovalModeValue } from '../../types/approvalModeValueTypes.js';
import type { PlanEntry, UsageStatsPayload } from '../../types/chatTypes.js';
import type { ModelInfo } from '../../types/acpTypes.js';

declare global {
  var acquireVsCodeApi:
    | undefined
    | (() => {
        postMessage: (message: unknown) => void;
        getState: () => unknown;
        setState: (state: unknown) => void;
      });
}

interface WebViewMessageProps {
  sessionManagement: {
    currentSessionId: string | null;
    setQwenSessions: (
      sessions:
        | Array<Record<string, unknown>>
        | ((
            prev: Array<Record<string, unknown>>,
          ) => Array<Record<string, unknown>>),
    ) => void;
    setCurrentSessionId: (id: string | null) => void;
    setCurrentSessionTitle: (title: string) => void;
    setShowSessionSelector: (show: boolean) => void;
    setNextCursor: (cursor: number | undefined) => void;
    setHasMore: (hasMore: boolean) => void;
    setIsLoading: (loading: boolean) => void;
    handleSaveSessionResponse: (response: {
      success: boolean;
      message?: string;
    }) => void;
  };
  fileContext: {
    setActiveFileName: (name: string | null) => void;
    setActiveFilePath: (path: string | null) => void;
    setActiveSelection: (
      selection: { startLine: number; endLine: number } | null,
    ) => void;
    setWorkspaceFilesFromResponse: (
      files: Array<{
        id: string;
        label: string;
        description: string;
        path: string;
      }>,
      requestId?: number,
    ) => void;
    addFileReference: (name: string, path: string) => void;
  };
  messageHandling: {
    setMessages: (
      messages: Array<{
        role: 'user' | 'assistant' | 'thinking';
        content: string;
        timestamp: number;
        fileContext?: {
          fileName: string;
          filePath: string;
          startLine?: number;
          endLine?: number;
        };
      }>,
    ) => void;
    addMessage: (message: {
      role: 'user' | 'assistant' | 'thinking';
      content: string;
      timestamp: number;
    }) => void;
    clearMessages: () => void;
    startStreaming: (timestamp?: number) => void;
    appendStreamChunk: (chunk: string) => void;
    endStreaming: () => void;
    breakAssistantSegment: () => void;
    appendThinkingChunk: (chunk: string) => void;
    clearThinking: () => void;
    setWaitingForResponse: (message: string) => void;
    clearWaitingForResponse: () => void;
  };
  handleToolCallUpdate: (update: ToolCallUpdate) => void;
  clearToolCalls: () => void;
  setPlanEntries: (entries: PlanEntry[]) => void;
  handlePermissionRequest: (
    request: {
      options: PermissionOption[];
      toolCall: PermissionToolCall;
    } | null,
  ) => void;
  inputFieldRef: React.RefObject<HTMLDivElement>;
  setInputText: (text: string) => void;
  setEditMode?: (mode: ApprovalModeValue) => void;
  setIsAuthenticated?: (authenticated: boolean | null) => void;
  setUsageStats?: (stats: UsageStatsPayload | undefined) => void;
  setModelInfo?: (info: ModelInfo | null) => void;
}

const createProps = (overrides: Partial<WebViewMessageProps> = {}) => {
  const props: WebViewMessageProps = {
    sessionManagement: {
      currentSessionId: null,
      setQwenSessions: vi.fn(),
      setCurrentSessionId: vi.fn(),
      setCurrentSessionTitle: vi.fn(),
      setShowSessionSelector: vi.fn(),
      setNextCursor: vi.fn(),
      setHasMore: vi.fn(),
      setIsLoading: vi.fn(),
      handleSaveSessionResponse: vi.fn(),
    },
    fileContext: {
      setActiveFileName: vi.fn(),
      setActiveFilePath: vi.fn(),
      setActiveSelection: vi.fn(),
      setWorkspaceFilesFromResponse: vi.fn(),
      addFileReference: vi.fn(),
    },
    messageHandling: {
      setMessages: vi.fn(),
      addMessage: vi.fn(),
      clearMessages: vi.fn(),
      startStreaming: vi.fn(),
      appendStreamChunk: vi.fn(),
      endStreaming: vi.fn(),
      breakAssistantSegment: vi.fn(),
      appendThinkingChunk: vi.fn(),
      clearThinking: vi.fn(),
      setWaitingForResponse: vi.fn(),
      clearWaitingForResponse: vi.fn(),
    },
    handleToolCallUpdate: vi.fn(),
    clearToolCalls: vi.fn(),
    setPlanEntries: vi.fn(),
    handlePermissionRequest: vi.fn(),
    inputFieldRef: {
      current: document.createElement('div'),
    } as React.RefObject<HTMLDivElement>,
    setInputText: vi.fn(),
    setEditMode: vi.fn(),
    setIsAuthenticated: vi.fn(),
    setUsageStats: vi.fn(),
    setModelInfo: vi.fn(),
  };

  return {
    ...props,
    ...overrides,
    sessionManagement: {
      ...props.sessionManagement,
      ...overrides.sessionManagement,
    },
    fileContext: {
      ...props.fileContext,
      ...overrides.fileContext,
    },
    messageHandling: {
      ...props.messageHandling,
      ...overrides.messageHandling,
    },
  };
};

const renderHook = async (props: WebViewMessageProps) => {
  const { useWebViewMessages } = await import('./useWebViewMessages.js');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const Harness = () => {
    useWebViewMessages(props);
    return <div ref={props.inputFieldRef} />;
  };

  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {});

  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
};

const setup = async (overrides: Partial<WebViewMessageProps> = {}) => {
  vi.resetModules();
  const postMessage = vi.fn();

  globalThis.acquireVsCodeApi = () => ({
    postMessage,
    getState: vi.fn(),
    setState: vi.fn(),
  });

  const props = createProps(overrides);
  const { unmount } = await renderHook(props);

  return { postMessage, props, unmount };
};

describe('useWebViewMessages', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    globalThis.acquireVsCodeApi = undefined;
  });

  it('opens a diff when permission request includes diff content', async () => {
    const { postMessage, props, unmount } = await setup();

    const diffContent = {
      type: 'diff',
      path: 'src/example.ts',
      oldText: 'old',
      newText: 'new',
    };

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'permissionRequest',
            data: {
              options: [
                { name: 'Allow once', kind: 'allow_once', optionId: 'allow' },
              ],
              toolCall: {
                toolCallId: 'tc-1',
                title: 'Edit file',
                kind: 'execute',
                status: 'pending',
                content: [diffContent],
              },
            },
          },
        }),
      );
    });

    // The actual postMessage sends data without the 'type' field
    expect(postMessage).toHaveBeenCalledWith({
      type: 'openDiff',
      data: {
        path: 'src/example.ts',
        oldText: 'old',
        newText: 'new',
      },
    });

    expect(props.handleToolCallUpdate).toHaveBeenCalled();
    const update = vi.mocked(props.handleToolCallUpdate).mock.calls[0][0];
    expect(update.type).toBe('tool_call');
    expect(update.toolCallId).toBe('tc-1');
    expect(update.kind).toBe('edit');

    unmount();
  });

  it('records inbound messages when test array is present', async () => {
    const { unmount } = await setup();
    const holder = globalThis as typeof globalThis & {
      __qwenTestMode?: boolean;
      __qwenReceivedMessages?: unknown[];
    };
    holder.__qwenTestMode = true;
    holder.__qwenReceivedMessages = [];

    const payload = { type: 'authState', data: { authenticated: true } };

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: payload }));
    });

    expect(holder.__qwenReceivedMessages).toEqual([payload]);

    delete holder.__qwenReceivedMessages;
    delete holder.__qwenTestMode;
    unmount();
  });

  it('closes permission drawer when extension resolves permission', async () => {
    const { props, unmount } = await setup();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'permissionResolved',
            data: { optionId: 'allow' },
          },
        }),
      );
    });

    expect(props.handlePermissionRequest).toHaveBeenCalledWith(null);

    unmount();
  });

  it('merges plan updates into a single tool call', async () => {
    const { props, unmount } = await setup();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const initialPlan: PlanEntry[] = [
      { content: 'Step 1', status: 'completed' },
    ];

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'plan', data: { entries: initialPlan } },
        }),
      );
    });

    const firstCall = vi.mocked(props.handleToolCallUpdate).mock.calls[0][0];

    vi.setSystemTime(new Date('2024-01-01T00:00:01Z'));

    const updatedPlan: PlanEntry[] = [
      { content: 'Step 1', status: 'completed' },
      { content: 'Step 2', status: 'in_progress' },
    ];

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'plan', data: { entries: updatedPlan } },
        }),
      );
    });

    const secondCall = vi.mocked(props.handleToolCallUpdate).mock.calls[1][0];

    expect(firstCall.type).toBe('tool_call');
    expect(secondCall.type).toBe('tool_call_update');
    expect(secondCall.toolCallId).toBe(firstCall.toolCallId);

    vi.useRealTimers();
    unmount();
  });
});
