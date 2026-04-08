/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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
  getQueuedMessagesText: () => string;
  /**
   * Atomically drain all queued messages. Returns the drained messages
   * and clears both the synchronous ref and React state. Safe to call
   * from non-React contexts (e.g., tool completion callbacks).
   */
  drainQueue: () => string[];
}

/**
 * Hook for managing message queuing during streaming responses.
 * Allows users to queue messages while the AI is responding and automatically
 * sends them when streaming completes.
 */
export function useMessageQueue({
  isConfigInitialized,
  streamingState,
  submitQuery,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  // Synchronous ref mirrors React state so non-React callbacks (e.g.,
  // mid-turn drain in handleCompletedTools) always see the latest queue.
  const queueRef = useRef<string[]>([]);

  // Add a message to the queue
  const addMessage = useCallback((message: string) => {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length > 0) {
      queueRef.current = [...queueRef.current, trimmedMessage];
      setMessageQueue(queueRef.current);
    }
  }, []);

  // Clear the entire queue
  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setMessageQueue([]);
  }, []);

  // Get all queued messages as a single text string
  const getQueuedMessagesText = useCallback(() => {
    if (messageQueue.length === 0) return '';
    return messageQueue.join('\n\n');
  }, [messageQueue]);

  // Atomically drain all queued messages (synchronous, safe from callbacks).
  const drainQueue = useCallback((): string[] => {
    const drained = queueRef.current;
    if (drained.length === 0) return [];
    queueRef.current = [];
    setMessageQueue([]);
    return drained;
  }, []);

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
      clearQueue();
      submitQuery(combinedMessage);
    }
  }, [
    isConfigInitialized,
    streamingState,
    messageQueue,
    submitQuery,
    clearQueue,
  ]);

  return {
    messageQueue,
    addMessage,
    clearQueue,
    getQueuedMessagesText,
    drainQueue,
  };
}
