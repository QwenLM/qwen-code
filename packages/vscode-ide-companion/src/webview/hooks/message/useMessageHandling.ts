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
  kind?: 'image';
  imagePath?: string;
  imageSrc?: string;
  imageMissing?: boolean;
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
  // Preserve one stable timestamp for all message segments in the same turn.
  const currentStreamTimestampRef = useRef<number | null>(null);

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
    const resolvedTimestamp =
      typeof timestamp === 'number' ? timestamp : Date.now();
    currentStreamTimestampRef.current = resolvedTimestamp;
    // Create an assistant placeholder message immediately so tool calls won't jump before it
    setMessages((prev) => {
      // Record index of the placeholder to update on chunks
      streamingMessageIndexRef.current = prev.length;
      return [
        ...prev,
        {
          role: 'assistant',
          content: '',
          // Use one stable turn timestamp so later split segments sort correctly.
          timestamp: resolvedTimestamp,
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
          next.push({
            role: 'assistant',
            content: '',
            timestamp: currentStreamTimestampRef.current ?? Date.now(),
          });
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

  const breakThinkingSegment = useCallback(() => {
    thinkingMessageIndexRef.current = null;
  }, []);

  /**
   * End streaming response
   */
  const endStreaming = useCallback(() => {
    setIsStreaming(false);
    streamingMessageIndexRef.current = null;
    thinkingMessageIndexRef.current = null;
    currentStreamTimestampRef.current = null;
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
          // Use a timestamp just before the assistant placeholder so thinking
          // sorts above the response text when messages are ordered by time.
          const assistantIdx = streamingMessageIndexRef.current;
          const assistantTs =
            assistantIdx !== null &&
            assistantIdx >= 0 &&
            assistantIdx < next.length
              ? next[assistantIdx].timestamp
              : (currentStreamTimestampRef.current ?? Date.now());
          next.push({
            role: 'thinking',
            content: '',
            timestamp: assistantTs - 1,
          });
        }
        if (idx >= 0 && idx < next.length) {
          const target = next[idx];
          next[idx] = { ...target, content: (target.content || '') + chunk };
        }
        return next;
      });
    },
    clearThinking: () => {
      thinkingMessageIndexRef.current = null;
    },
    breakAssistantSegment,
    breakThinkingSegment,
    setWaitingForResponse,
    clearWaitingForResponse,
    setMessages,
  };
};
