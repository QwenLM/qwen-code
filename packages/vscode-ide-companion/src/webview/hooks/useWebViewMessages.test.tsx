/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebViewMessages } from './useWebViewMessages.js';

const { mockPostMessage, mockClearImageResolutions } = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
  mockClearImageResolutions: vi.fn(),
}));

vi.mock('./useVSCode.js', () => ({
  useVSCode: () => ({
    postMessage: mockPostMessage,
  }),
}));

vi.mock('./useImage.js', () => ({
  useImageResolution: () => ({
    materializeMessages: <T,>(messages: T) => messages,
    materializeMessage: <T,>(message: T) => [message],
    mergeResolvedImages: <T,>(messages: T) => messages,
    clearImageResolutions: mockClearImageResolutions,
  }),
}));

function renderHookHarness(overrides?: {
  setUsageStats?: ReturnType<typeof vi.fn>;
  endStreaming?: ReturnType<typeof vi.fn>;
  clearWaitingForResponse?: ReturnType<typeof vi.fn>;
  setInsightReportPath?: ReturnType<typeof vi.fn>;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const setUsageStats = overrides?.setUsageStats ?? vi.fn();
  const endStreaming = overrides?.endStreaming ?? vi.fn();
  const clearWaitingForResponse = overrides?.clearWaitingForResponse ?? vi.fn();
  const setInsightReportPath = overrides?.setInsightReportPath ?? vi.fn();

  const handlers = {
    sessionManagement: {
      currentSessionId: 'conversation-1',
      setQwenSessions: vi.fn(),
      setCurrentSessionId: vi.fn(),
      setCurrentSessionTitle: vi.fn(),
      setShowSessionSelector: vi.fn(),
      setNextCursor: vi.fn(),
      setHasMore: vi.fn(),
      setIsLoading: vi.fn(),
      setIsSwitchingSession: vi.fn(),
    },
    fileContext: {
      setActiveFileName: vi.fn(),
      setActiveFilePath: vi.fn(),
      setActiveSelection: vi.fn(),
      setWorkspaceFilesFromResponse: vi.fn(),
      addFileReference: vi.fn(),
    },
    messageHandling: {
      messages: [
        { role: 'user', content: 'first', timestamp: 100 },
        { role: 'assistant', content: 'first reply', timestamp: 200 },
        { role: 'user', content: 'second', timestamp: 300 },
        { role: 'assistant', content: 'second reply', timestamp: 400 },
      ],
      setMessages: vi.fn(),
      addMessage: vi.fn(),
      clearMessages: vi.fn(),
      startStreaming: vi.fn(),
      appendStreamChunk: vi.fn(),
      endStreaming,
      breakAssistantSegment: vi.fn(),
      breakThinkingSegment: vi.fn(),
      appendThinkingChunk: vi.fn(),
      clearThinking: vi.fn(),
      setWaitingForResponse: vi.fn(),
      clearWaitingForResponse,
    },
    handleToolCallUpdate: vi.fn(),
    clearToolCalls: vi.fn(),
    rewindToolCallsToTimestamp: vi.fn(),
    setPlanEntries: vi.fn(),
    handlePermissionRequest: vi.fn(),
    handleAskUserQuestion: vi.fn(),
    inputFieldRef: createRef<HTMLDivElement>(),
    setInputText: vi.fn(),
    setEditMode: vi.fn(),
    setIsAuthenticated: vi.fn(),
    setUsageStats,
    setModelInfo: vi.fn(),
    setAvailableCommands: vi.fn(),
    setAvailableModels: vi.fn(),
    setInsightReportPath,
  };

  function Harness() {
    useWebViewMessages(handlers);
    return null;
  }

  act(() => {
    root.render(<Harness />);
  });

  return {
    container,
    root,
    handlers,
    setUsageStats,
    endStreaming,
    clearWaitingForResponse,
    setInsightReportPath,
  };
}

describe('useWebViewMessages', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('fully resets local UI state when a conversation is cleared', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'conversationCleared',
            data: {},
          },
        }),
      );
    });

    expect(rendered.handlers.messageHandling.clearMessages).toHaveBeenCalled();
    expect(rendered.handlers.clearToolCalls).toHaveBeenCalled();
    expect(
      rendered.handlers.sessionManagement.setCurrentSessionId,
    ).toHaveBeenCalledWith(null);
    expect(rendered.endStreaming).toHaveBeenCalled();
    expect(rendered.clearWaitingForResponse).toHaveBeenCalled();
    expect(mockClearImageResolutions).toHaveBeenCalled();
    expect(rendered.setUsageStats).toHaveBeenCalledWith(undefined);
    expect(rendered.handlers.setPlanEntries).toHaveBeenCalledWith([]);
    expect(rendered.handlers.handlePermissionRequest).toHaveBeenCalledWith(
      null,
    );
    expect(rendered.handlers.handleAskUserQuestion).toHaveBeenCalledWith(null);
    expect(
      rendered.handlers.sessionManagement.setCurrentSessionTitle,
    ).toHaveBeenCalledWith('Past Conversations');
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'updatePanelTitle',
      data: { title: 'Qwen Code' },
    });
  });

  it('clears stale execute-tool tracking before the next session ends', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'toolCall',
            data: {
              toolCallId: 'exec-1',
              kind: 'execute',
              status: 'in_progress',
              rawInput: 'ls',
            },
          },
        }),
      );
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'conversationCleared',
            data: {},
          },
        }),
      );
    });

    rendered.clearWaitingForResponse.mockClear();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'streamEnd',
            data: {},
          },
        }),
      );
    });

    expect(rendered.clearWaitingForResponse).toHaveBeenCalled();
  });

  it('drops transcript state from the edited user turn onward', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'conversationRewound',
            data: { targetTurnIndex: 1 },
          },
        }),
      );
    });

    expect(rendered.handlers.messageHandling.setMessages).toHaveBeenCalledWith([
      { role: 'user', content: 'first', timestamp: 100 },
      { role: 'assistant', content: 'first reply', timestamp: 200 },
    ]);
    expect(rendered.handlers.rewindToolCallsToTimestamp).toHaveBeenCalledWith(
      300,
    );
    expect(rendered.handlers.setPlanEntries).toHaveBeenCalledWith([]);
    expect(rendered.setUsageStats).toHaveBeenCalledWith(undefined);
  });

  it('ignores conversation rewind events when the target turn is missing', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'conversationRewound',
            data: { targetTurnIndex: 99 },
          },
        }),
      );
    });

    expect(
      rendered.handlers.messageHandling.setMessages,
    ).not.toHaveBeenCalled();
    expect(rendered.handlers.rewindToolCallsToTimestamp).not.toHaveBeenCalled();
    expect(rendered.handlers.setPlanEntries).not.toHaveBeenCalled();
    expect(rendered.clearWaitingForResponse).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'message',
            data: { role: 'user', content: 'next', timestamp: 500 },
          },
        }),
      );
    });

    expect(rendered.handlers.messageHandling.addMessage).toHaveBeenCalledWith({
      role: 'user',
      content: 'next',
      timestamp: 500,
      turnIndex: 0,
    });
  });

  it('indexes user turns after switching to a persisted session', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'qwenSessionSwitched',
            data: {
              sessionId: 'conversation-2',
              session: { title: 'Persisted Session' },
              messages: [
                { role: 'user', content: 'persisted first', timestamp: 10 },
                { role: 'assistant', content: 'reply', timestamp: 20 },
                { role: 'user', content: 'persisted second', timestamp: 30 },
              ],
            },
          },
        }),
      );
    });

    expect(rendered.handlers.messageHandling.setMessages).toHaveBeenCalledWith([
      {
        role: 'user',
        content: 'persisted first',
        timestamp: 10,
        turnIndex: 0,
      },
      { role: 'assistant', content: 'reply', timestamp: 20 },
      {
        role: 'user',
        content: 'persisted second',
        timestamp: 30,
        turnIndex: 1,
      },
    ]);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'message',
            data: { role: 'user', content: 'next', timestamp: 40 },
          },
        }),
      );
    });

    expect(rendered.handlers.messageHandling.addMessage).toHaveBeenCalledWith({
      role: 'user',
      content: 'next',
      timestamp: 40,
      turnIndex: 2,
    });
  });

  it('indexes user turns when loading a conversation transcript', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'conversationLoaded',
            data: {
              messages: [
                { role: 'user', content: 'loaded first', timestamp: 10 },
                { role: 'assistant', content: 'reply', timestamp: 20 },
                { role: 'user', content: 'loaded second', timestamp: 30 },
              ],
            },
          },
        }),
      );
    });

    expect(rendered.handlers.messageHandling.setMessages).toHaveBeenCalledWith([
      {
        role: 'user',
        content: 'loaded first',
        timestamp: 10,
        turnIndex: 0,
      },
      { role: 'assistant', content: 'reply', timestamp: 20 },
      {
        role: 'user',
        content: 'loaded second',
        timestamp: 30,
        turnIndex: 1,
      },
    ]);
  });

  it('resets user turn indexing after a conversation is cleared', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'qwenSessionSwitched',
            data: {
              sessionId: 'conversation-2',
              session: { title: 'Persisted Session' },
              messages: [
                { role: 'user', content: 'persisted first', timestamp: 10 },
                { role: 'assistant', content: 'reply', timestamp: 20 },
                { role: 'user', content: 'persisted second', timestamp: 30 },
              ],
            },
          },
        }),
      );
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'conversationCleared',
            data: {},
          },
        }),
      );
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'message',
            data: { role: 'user', content: 'restart', timestamp: 40 },
          },
        }),
      );
    });

    expect(
      rendered.handlers.messageHandling.addMessage,
    ).toHaveBeenLastCalledWith({
      role: 'user',
      content: 'restart',
      timestamp: 40,
      turnIndex: 0,
    });
  });

  it('resets user turn indexing when switching to a session without messages', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'qwenSessionSwitched',
            data: {
              sessionId: 'conversation-2',
              session: { title: 'Empty Session' },
            },
          },
        }),
      );
    });

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'message',
            data: { role: 'user', content: 'first', timestamp: 10 },
          },
        }),
      );
    });

    expect(rendered.handlers.messageHandling.clearMessages).toHaveBeenCalled();
    expect(rendered.handlers.messageHandling.addMessage).toHaveBeenCalledWith({
      role: 'user',
      content: 'first',
      timestamp: 10,
      turnIndex: 0,
    });
  });

  it('clears the generic waiting state when insight progress starts', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'insightProgress',
            data: {
              stage: 'Analyzing sessions',
              progress: 42,
              detail: '21/50',
            },
          },
        }),
      );
    });

    expect(rendered.clearWaitingForResponse).toHaveBeenCalled();
  });

  it('clears waiting state when authCancelled is received', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'authCancelled',
          },
        }),
      );
    });

    expect(rendered.clearWaitingForResponse).toHaveBeenCalled();
  });

  it('stores the latest insight report path when the ready event arrives', () => {
    const rendered = renderHookHarness();
    root = rendered.root;
    container = rendered.container;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'insightReportReady',
            data: {
              path: '/tmp/insight-report.html',
            },
          },
        }),
      );
    });

    expect(rendered.setInsightReportPath).toHaveBeenCalledWith(
      '/tmp/insight-report.html',
    );
  });
});
