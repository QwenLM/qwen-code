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
    materializeMessage: <T,>(message: T) => message,
    mergeResolvedImages: <T,>(messages: T) => messages,
    clearImageResolutions: mockClearImageResolutions,
  }),
}));

function renderHookHarness(overrides?: {
  setUsageStats?: ReturnType<typeof vi.fn>;
  endStreaming?: ReturnType<typeof vi.fn>;
  clearWaitingForResponse?: ReturnType<typeof vi.fn>;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const setUsageStats = overrides?.setUsageStats ?? vi.fn();
  const endStreaming = overrides?.endStreaming ?? vi.fn();
  const clearWaitingForResponse =
    overrides?.clearWaitingForResponse ?? vi.fn();

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
  };

  function Harness() {
    useWebViewMessages(handlers);
    return null;
  }

  act(() => {
    root.render(<Harness />);
  });

  return { container, root, handlers, setUsageStats, endStreaming, clearWaitingForResponse };
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
    expect(rendered.handlers.sessionManagement.setCurrentSessionId).toHaveBeenCalledWith(
      null,
    );
    expect(rendered.endStreaming).toHaveBeenCalled();
    expect(rendered.clearWaitingForResponse).toHaveBeenCalled();
    expect(mockClearImageResolutions).toHaveBeenCalled();
    expect(rendered.setUsageStats).toHaveBeenCalledWith(undefined);
    expect(
      rendered.handlers.sessionManagement.setCurrentSessionTitle,
    ).toHaveBeenCalledWith('Past Conversations');
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'updatePanelTitle',
      data: { title: 'Qwen Code' },
    });
  });
});
