/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import type { StreamingState } from '../types.js';
import { isSlashCommand } from '../utils/commandUtils.js';

export interface UseMessageQueueOptions {
  isConfigInitialized: boolean;
  streamingState: StreamingState;
  submitQuery: (query: string) => void | Promise<unknown>;
}

// Extract the first queue segment in original order. A segment is either a
// single slash command or a batch of consecutive plain-text prompts joined
// with `\n\n`.
function extractFirstSegment(messages: string[]): {
  segment: string;
  rest: string[];
} {
  if (isSlashCommand(messages[0])) {
    return { segment: messages[0], rest: messages.slice(1) };
  }
  const slashIdx = messages.findIndex((m) => isSlashCommand(m));
  if (slashIdx === -1) {
    return { segment: messages.join('\n\n'), rest: [] };
  }
  return {
    segment: messages.slice(0, slashIdx).join('\n\n'),
    rest: messages.slice(slashIdx),
  };
}

export interface UseMessageQueueReturn {
  messageQueue: string[];
  addMessage: (message: string) => void;
  clearQueue: () => void;
  getQueuedMessagesText: () => string;
  popAllMessages: () => string | null;
  /**
   * Atomically drain every queued plain-text prompt from the queue while
   * leaving slash commands deferred for manual execution. Returns the
   * drained prompts in their original order and updates both the
   * synchronous ref and React state.
   * Safe to call from non-React contexts (e.g., tool completion callbacks).
   */
  drainQueue: () => string[];
  /**
   * Pop the next submission segment from the queue. Consecutive plain-text
   * messages are batched into one segment joined by `\n\n`; slash commands
   * are returned alone so the receiver's `isSlashCommand` check still fires.
   * Returns `null` when the queue is empty.
   */
  popNextSegment: () => string | null;
}

/**
 * Hook for managing message queuing during streaming responses.
 * Allows users to queue messages while the AI is responding and automatically
 * sends them when streaming completes.
 */
export function useMessageQueue(
  _options: UseMessageQueueOptions,
): UseMessageQueueReturn {
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

  // Pop deferred queue content for editing (atomic via ref to prevent
  // duplicate pops from key auto-repeat before React re-renders).
  const popAllMessages = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    const { segment, rest } = extractFirstSegment(current);
    queueRef.current = rest;
    setMessageQueue(rest);
    return segment;
  }, []);

  // Atomically drain every plain-text prompt (synchronous, safe from
  // callbacks) while leaving slash commands deferred for manual execution.
  const drainQueue = useCallback((): string[] => {
    const current = queueRef.current;
    if (current.length === 0) return [];
    const drained = current.filter((message) => !isSlashCommand(message));
    if (drained.length === 0) return [];
    const rest = current.filter((message) => isSlashCommand(message));
    queueRef.current = rest;
    setMessageQueue(rest);
    return drained;
  }, []);

  // Pop the next submission segment. Caller is responsible for gating on
  // streamingState, open dialogs, etc.; this hook only owns queue state.
  const popNextSegment = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    const { segment, rest } = extractFirstSegment(current);
    queueRef.current = rest;
    setMessageQueue(rest);
    return segment;
  }, []);

  return {
    messageQueue,
    addMessage,
    clearQueue,
    getQueuedMessagesText,
    popAllMessages,
    drainQueue,
    popNextSegment,
  };
}
