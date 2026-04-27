/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { resetConversationState } from './useWebViewMessages.js';

describe('resetConversationState', () => {
  it('clears retained usage stats when a conversation is reset', () => {
    const clearMessages = vi.fn();
    const endStreaming = vi.fn();
    const clearWaitingForResponse = vi.fn();
    const clearThinking = vi.fn();
    const clearToolCalls = vi.fn();
    const clearActiveExecToolCalls = vi.fn();
    const setPlanEntries = vi.fn();
    const handlePermissionRequest = vi.fn();
    const handleAskUserQuestion = vi.fn();
    const setCurrentSessionId = vi.fn();
    const setCurrentSessionTitle = vi.fn();
    const setUsageStats = vi.fn();
    const clearImageResolutions = vi.fn();
    const postMessage = vi.fn();

    resetConversationState({
      handlers: {
        messageHandling: {
          clearMessages,
          endStreaming,
          clearWaitingForResponse,
          clearThinking,
        },
        clearToolCalls,
        clearActiveExecToolCalls,
        setPlanEntries,
        handlePermissionRequest,
        handleAskUserQuestion,
        sessionManagement: {
          setCurrentSessionId,
          setCurrentSessionTitle,
        },
        setUsageStats,
      },
      clearImageResolutions,
      vscode: {
        postMessage,
      },
    });

    expect(endStreaming).toHaveBeenCalled();
    expect(clearWaitingForResponse).toHaveBeenCalled();
    expect(clearThinking).toHaveBeenCalled();
    expect(clearMessages).toHaveBeenCalled();
    expect(clearToolCalls).toHaveBeenCalled();
    expect(clearActiveExecToolCalls).toHaveBeenCalled();
    expect(setPlanEntries).toHaveBeenCalledWith([]);
    expect(handlePermissionRequest).toHaveBeenCalledWith(null);
    expect(handleAskUserQuestion).toHaveBeenCalledWith(null);
    expect(setCurrentSessionId).toHaveBeenCalledWith(null);
    expect(clearImageResolutions).toHaveBeenCalled();
    expect(setUsageStats).toHaveBeenCalledWith(undefined);
    expect(setCurrentSessionTitle).toHaveBeenCalledWith('Past Conversations');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'updatePanelTitle',
      data: { title: 'Qwen Code' },
    });
  });
});
