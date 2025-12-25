/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useCallback } from 'react';

export interface TextMessage {
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: number;
  fileContext?: {
    fileName: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
  };
}

/**
 * Message handling Hook
 * Manages message list, streaming responses, and loading state
 */
export const useMessageHandling = () => {
  const [messages, setMessages] = useState<TextMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  // Track the index of the assistant placeholder message during streaming
  const streamingMessageIndexRef = useRef<number | null>(null);
  // Track the index of the current aggregated thinking message
  const thinkingMessageIndexRef = useRef<number | null>(null);

  /**
   * Add message
   */
  const addMessage = useCallback((message: TextMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  /**
   * Clear messages
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  /**
   * Start streaming response
   */
  const startStreaming = useCallback((timestamp?: number) => {
    // Create an assistant placeholder message immediately so tool calls won't jump before it
    setMessages((prev) => {
      // Record index of the placeholder to update on chunks
      streamingMessageIndexRef.current = prev.length;
      return [
        ...prev,
        {
          role: 'assistant',
          content: '',
          // Use provided timestamp (from extension) to keep ordering stable
          timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
        },
      ];
    });
    setIsStreaming(true);
  }, []);

  /**
   * Add stream chunk
   */
  const appendStreamChunk = useCallback(
    (chunk: string) => {
      // Ignore late chunks after user cancelled streaming (until next streamStart)
      if (!isStreaming) {
        return;
      }

      setMessages((prev) => {
        let idx = streamingMessageIndexRef.current;
        const next = prev.slice();

        // If there is no active placeholder (e.g., after a tool call), start a new one
        if (idx === null) {
          idx = next.length;
          streamingMessageIndexRef.current = idx;
          next.push({ role: 'assistant', content: '', timestamp: Date.now() });
        }

        if (idx < 0 || idx >= next.length) {
          return prev;
        }
        const target = next[idx];
        next[idx] = { ...target, content: (target.content || '') + chunk };
        return next;
      });
    },
    [isStreaming],
  );

  /**
   * Break current assistant stream segment (e.g., when a tool call starts/updates)
   * Next incoming chunk will create a new assistant placeholder
   */
  const breakAssistantSegment = useCallback(() => {
    streamingMessageIndexRef.current = null;
  }, []);

  /**
   * End streaming response
   */
  const endStreaming = useCallback(() => {
    // Finalize streaming; content already lives in the placeholder message
    setIsStreaming(false);
    streamingMessageIndexRef.current = null;
    // Remove the thinking message if it exists (collapse thoughts)
    setMessages((prev) => {
      const idx = thinkingMessageIndexRef.current;
      thinkingMessageIndexRef.current = null;
      if (idx === null || idx < 0 || idx >= prev.length) {
        return prev;
      }
      const next = prev.slice();
      next.splice(idx, 1);
      return next;
    });
  }, []);

  /**
   * Set waiting for response state
   */
  const setWaitingForResponse = useCallback((message: string) => {
    setIsWaitingForResponse(true);
    setLoadingMessage(message);
  }, []);

  /**
   * Clear waiting for response state
   */
  const clearWaitingForResponse = useCallback(() => {
    setIsWaitingForResponse(false);
    setLoadingMessage('');
  }, []);

  return {
    // State
    messages,
    isStreaming,
    isWaitingForResponse,
    loadingMessage,

    // Operations
    addMessage,
    clearMessages,
    startStreaming,
    appendStreamChunk,
    endStreaming,
    // Thought handling
    appendThinkingChunk: (chunk: string) => {
      // Ignore late thoughts after user cancelled streaming
      if (!isStreaming) {
        return;
      }
      setMessages((prev) => {
        let idx = thinkingMessageIndexRef.current;
        const next = prev.slice();
        if (idx === null) {
          idx = next.length;
          thinkingMessageIndexRef.current = idx;
          next.push({ role: 'thinking', content: '', timestamp: Date.now() });
        }
        if (idx >= 0 && idx < next.length) {
          const target = next[idx];
          next[idx] = { ...target, content: (target.content || '') + chunk };
        }
        return next;
      });
    },
    clearThinking: () => {
      setMessages((prev) => {
        const idx = thinkingMessageIndexRef.current;
        thinkingMessageIndexRef.current = null;
        if (idx === null || idx < 0 || idx >= prev.length) {
          return prev;
        }
        const next = prev.slice();
        next.splice(idx, 1);
        return next;
      });
    },
    breakAssistantSegment,
    setWaitingForResponse,
    clearWaitingForResponse,
    setMessages,
  };
};
