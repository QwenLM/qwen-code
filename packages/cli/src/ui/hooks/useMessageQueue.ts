/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import { isSlashCommand } from '../utils/commandUtils.js';

export interface UseMessageQueueReturn {
  messageQueue: string[];
  addMessage: (message: string) => void;
  clearQueue: () => void;
  getQueuedMessagesText: () => string;
  /** Drain the entire queue joined with `\n\n`. For Ctrl+C / ESC / Up edit-restore. */
  popAllMessages: () => string | null;
  /** Drain leading plain-text prompts; stop before slash commands to preserve order. */
  drainQueue: () => string[];
  /** Pop the first item from the queue. */
  popNextSegment: () => string | null;
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  // Synchronous mirror so non-React callbacks see the latest queue.
  const queueRef = useRef<string[]>([]);

  const addMessage = useCallback((message: string) => {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length > 0) {
      queueRef.current = [...queueRef.current, trimmedMessage];
      setMessageQueue(queueRef.current);
    }
  }, []);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setMessageQueue([]);
  }, []);

  const getQueuedMessagesText = useCallback(() => {
    if (messageQueue.length === 0) return '';
    return messageQueue.join('\n\n');
  }, [messageQueue]);

  const popAllMessages = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    queueRef.current = [];
    setMessageQueue([]);
    return current.join('\n\n');
  }, []);

  const drainQueue = useCallback((): string[] => {
    const current = queueRef.current;
    if (current.length === 0) return [];

    const firstSlashIndex = current.findIndex((message) =>
      isSlashCommand(message),
    );
    const drainEnd = firstSlashIndex === -1 ? current.length : firstSlashIndex;
    if (drainEnd === 0) return [];

    const drained = current.slice(0, drainEnd);
    const rest = current.slice(drainEnd);
    queueRef.current = rest;
    setMessageQueue(rest);
    return drained;
  }, []);

  const popNextSegment = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    const [head, ...rest] = current;
    queueRef.current = rest;
    setMessageQueue(rest);
    return head;
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
