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

// Extract the first submission segment from a queue. A segment is either a
// single slash-command message (submitted alone so `isSlashCommand` still
// fires at the receiver), or a batch of consecutive plain-text messages
// joined with `\n\n` (preserves the long-standing behavior where queued
// plain-text prompts are sent as one turn). The remaining messages stay in
// the queue; the next natural state transition drains them one segment at a
// time, which ensures a dialog-opening slash command (e.g. `/model`) does
// not auto-advance into subsequent messages while the dialog is still open.
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
   * Atomically drain leading plain-text messages from the queue, stopping
   * at the first slash command. Returns the drained messages and updates
   * both the synchronous ref and React state. Slash commands stay queued
   * because they're UI actions, not model input — they should be executed
   * via the normal idle drain, not injected as tool-result context.
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

  // Pop all messages from the queue for editing (atomic via ref to prevent
  // duplicate pops from key auto-repeat before React re-renders)
  const popAllMessages = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    const allText = current.join('\n\n');
    queueRef.current = [];
    setMessageQueue([]);
    return allText;
  }, []);

  // Atomically drain leading plain-text messages (synchronous, safe from
  // callbacks). Stops at the first slash command so those stay queued and
  // get dispatched through the normal idle-drain path instead of being
  // injected into the model's context as raw text.
  const drainQueue = useCallback((): string[] => {
    const current = queueRef.current;
    if (current.length === 0) return [];
    if (isSlashCommand(current[0])) return [];
    const slashIdx = current.findIndex((m) => isSlashCommand(m));
    if (slashIdx === -1) {
      queueRef.current = [];
      setMessageQueue([]);
      return current;
    }
    const drained = current.slice(0, slashIdx);
    const rest = current.slice(slashIdx);
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
