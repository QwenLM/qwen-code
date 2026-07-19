/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import { isSlashCommand } from '../utils/commandUtils.js';

export interface UseMessageQueueReturn {
  messageQueue: string[];
  addMessage: (message: string, deferUntilIdle?: boolean) => void;
  clearQueue: () => void;
  getQueuedMessagesText: () => string;
  /** Drain the entire queue joined with `\n\n`. For Ctrl+C / ESC / Up edit-restore. */
  popAllMessages: () => string | null;
  /** Restore interrupted steer messages to the front of the queue. */
  restoreMessages: (messages: string[]) => void;
  /**
   * Drain plain-text prompts that can steer the active turn. Pass true at the
   * idle boundary to also drain messages explicitly deferred with Ctrl+Q.
   * Slash commands always stay queued for individual processing.
   */
  drainQueue: (includeDeferred?: boolean) => string[];
  /** Pop the first item from the queue. */
  popNextSegment: () => string | null;
  /**
   * Synchronous snapshot of queued message texts, read from the ref mirror so
   * mid-turn probes (e.g. the Stop-hook continuation's queued-/goal check,
   * #7181) see the latest queue without waiting for a React re-render.
   */
  getQueuedMessages: () => string[];
}

interface QueuedMessage {
  text: string;
  deferUntilIdle: boolean;
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  // Synchronous mirror so non-React callbacks see the latest queue.
  const queueRef = useRef<QueuedMessage[]>([]);

  const addMessage = useCallback((message: string, deferUntilIdle = false) => {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length > 0) {
      queueRef.current = [
        ...queueRef.current,
        { text: trimmedMessage, deferUntilIdle },
      ];
      setQueuedMessages(queueRef.current);
    }
  }, []);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueuedMessages([]);
  }, []);

  const getQueuedMessagesText = useCallback(() => {
    if (queuedMessages.length === 0) return '';
    return queuedMessages.map(({ text }) => text).join('\n\n');
  }, [queuedMessages]);

  const popAllMessages = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    queueRef.current = [];
    setQueuedMessages([]);
    return current.map(({ text }) => text).join('\n\n');
  }, []);

  const restoreMessages = useCallback((messages: string[]) => {
    const restored = messages
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ text, deferUntilIdle: false }));
    if (restored.length === 0) return;
    queueRef.current = [...restored, ...queueRef.current];
    setQueuedMessages(queueRef.current);
  }, []);

  const drainQueue = useCallback((includeDeferred = false): string[] => {
    const current = queueRef.current;
    if (current.length === 0) return [];
    const shouldDrain = (message: QueuedMessage) =>
      !isSlashCommand(message.text) &&
      (includeDeferred || !message.deferUntilIdle);
    const drained = current.filter(shouldDrain);
    if (drained.length === 0) return [];
    const rest = current.filter((message) => !shouldDrain(message));
    queueRef.current = rest;
    setQueuedMessages(rest);
    return drained.map(({ text }) => text);
  }, []);

  const popNextSegment = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    const [head, ...rest] = current;
    queueRef.current = rest;
    setQueuedMessages(rest);
    return head.text;
  }, []);

  const getQueuedMessages = useCallback(
    (): string[] => queueRef.current.map(({ text }) => text),
    [],
  );

  return {
    messageQueue: queuedMessages.map(({ text }) => text),
    addMessage,
    clearQueue,
    getQueuedMessagesText,
    popAllMessages,
    restoreMessages,
    drainQueue,
    popNextSegment,
    getQueuedMessages,
  };
}
