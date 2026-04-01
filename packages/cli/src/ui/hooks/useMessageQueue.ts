/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import { StreamingState } from '../types.js';

export interface UseMessageQueueOptions {
  isConfigInitialized: boolean;
  streamingState: StreamingState;
  submitQuery: (query: string) => void;
}

export interface UseMessageQueueReturn {
  messageQueue: string[];
  addMessage: (message: string) => void;
  clearQueue: () => void;
  popLast: () => string | undefined;
  getQueuedMessagesText: () => string;
}

/**
 * Hook for managing message queuing during streaming responses.
 * Allows users to queue messages while the AI is responding and automatically
 * sends them when streaming completes.
 *
 * Messages are batched: if multiple arrive during a single turn they are
 * combined with double-newlines and submitted as one turn.
 */
export function useMessageQueue({
  isConfigInitialized,
  streamingState,
  submitQuery,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [messageQueue, setMessageQueue] = useState<string[]>([]);

  // Add a message to the queue
  const addMessage = useCallback((message: string) => {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length > 0) {
      setMessageQueue((prev) => [...prev, trimmedMessage]);
    }
  }, []);

  // Clear the entire queue
  const clearQueue = useCallback(() => {
    setMessageQueue([]);
  }, []);

  /**
   * Remove and return the last queued message. Used by the cancel handler
   * to pop one message at a time back into the input buffer instead of
   * dumping the entire queue at once.
   */
  const popLast = useCallback((): string | undefined => {
    let popped: string | undefined;
    setMessageQueue((prev) => {
      if (prev.length === 0) return prev;
      popped = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    return popped;
  }, []);

  // Get all queued messages as a single text string
  const getQueuedMessagesText = useCallback(() => {
    if (messageQueue.length === 0) return '';
    return messageQueue.join('\n\n');
  }, [messageQueue]);

  // Process queued messages when streaming becomes idle
  useEffect(() => {
    if (
      isConfigInitialized &&
      streamingState === StreamingState.Idle &&
      messageQueue.length > 0
    ) {
      // Combine all messages with double newlines for clarity
      const combinedMessage = messageQueue.join('\n\n');
      // Clear the queue and submit
      setMessageQueue([]);
      submitQuery(combinedMessage);
    }
  }, [isConfigInitialized, streamingState, messageQueue, submitQuery]);

  return {
    messageQueue,
    addMessage,
    clearQueue,
    popLast,
    getQueuedMessagesText,
  };
}
