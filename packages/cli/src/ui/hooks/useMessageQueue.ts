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
  popLast: () => string | undefined;
  drain: () => string[];
  getQueuedMessagesText: () => string;
}

/**
 * Hook for managing message queuing during streaming responses.
 *
 * Messages queued while the agent is working are injected mid-turn (between
 * tool calls) so the model sees them immediately and can decide whether to
 * act on them or continue its current task. Any messages still in the queue
 * when the turn finishes are submitted as a new turn.
 */
export function useMessageQueue({
  isConfigInitialized,
  streamingState,
  submitQuery,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  // Ref mirror so drain() can read synchronously without stale closures
  const queueRef = useRef<string[]>([]);
  queueRef.current = messageQueue;

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

  /**
   * Atomically drain all queued messages, returning them and clearing the
   * queue. Called by handleCompletedTools to inject messages mid-turn
   * alongside tool results.
   */
  const drain = useCallback((): string[] => {
    const messages = [...queueRef.current];
    if (messages.length > 0) {
      setMessageQueue([]);
    }
    return messages;
  }, []);

  // Get all queued messages as a single text string
  const getQueuedMessagesText = useCallback(() => {
    if (messageQueue.length === 0) return '';
    return messageQueue.join('\n\n');
  }, [messageQueue]);

  // Fallback: submit any remaining queued messages when streaming becomes
  // idle. Most messages will have already been injected mid-turn by
  // handleCompletedTools.drain(), but if the turn ends without any tool
  // calls (pure text response), this catches them.
  useEffect(() => {
    if (
      isConfigInitialized &&
      streamingState === StreamingState.Idle &&
      messageQueue.length > 0
    ) {
      const combinedMessage = messageQueue.join('\n\n');
      setMessageQueue([]);
      submitQuery(combinedMessage);
    }
  }, [isConfigInitialized, streamingState, messageQueue, submitQuery]);

  return {
    messageQueue,
    addMessage,
    clearQueue,
    popLast,
    drain,
    getQueuedMessagesText,
  };
}
