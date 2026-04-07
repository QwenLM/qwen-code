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
    const clearToolCalls = vi.fn();
    const setCurrentSessionId = vi.fn();
    const setCurrentSessionTitle = vi.fn();
    const setUsageStats = vi.fn();
    const clearImageResolutions = vi.fn();
    const postMessage = vi.fn();

    resetConversationState({
      handlers: {
        messageHandling: {
          clearMessages,
        },
        clearToolCalls,
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

    expect(clearMessages).toHaveBeenCalled();
    expect(clearToolCalls).toHaveBeenCalled();
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
