/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import { isSlashCommand } from '../utils/commandUtils.js';

export interface UseMessageQueueReturn {
  messageQueue: string[];
  addMessage: (
    message: string,
    deferUntilIdle?: boolean,
    submittedPrompt?: string,
  ) => void;
  clearQueue: () => void;
  getQueuedMessagesText: () => string;
  /** Drain the entire queue joined with `\n\n`. For Ctrl+C / ESC / Up edit-restore. */
  popAllMessages: () => QueuedSubmission | null;
  /** Restore interrupted steer messages to the front of the queue. */
  restoreMessages: (messages: string[]) => void;
  /**
   * Drain plain-text prompts that can steer the active turn. Pass true at the
   * idle boundary to also drain messages explicitly deferred with Ctrl+Q.
   * Slash commands stay queued except `/goal`, which must control active loops.
   */
  drainQueue: (includeDeferred?: boolean) => string[];
  /** Drain the next idle turn while preserving eligible prompt provenance. */
  popNextTurn: () => QueuedSubmission | null;
}

export interface QueuedSubmission {
  modelText: string;
  submittedPrompt?: string;
}

interface QueuedMessage extends QueuedSubmission {
  deferUntilIdle: boolean;
}

export const GOAL_COMMAND_RE = /^\/goal(?:\s|$)/;

function aggregateMessages(
  messages: readonly QueuedMessage[],
): QueuedSubmission {
  const modelText = messages.map((message) => message.modelText).join('\n\n');
  const submittedPrompts = messages.map((message) => message.submittedPrompt);
  return submittedPrompts.every(
    (submittedPrompt): submittedPrompt is string =>
      submittedPrompt !== undefined,
  )
    ? { modelText, submittedPrompt: submittedPrompts.join('\n\n') }
    : { modelText };
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  // Synchronous mirror so non-React callbacks see the latest queue.
  const queueRef = useRef<QueuedMessage[]>([]);

  const addMessage = useCallback(
    (message: string, deferUntilIdle = false, submittedPrompt?: string) => {
      const modelText = message.trim();
      if (modelText.length > 0) {
        queueRef.current = [
          ...queueRef.current,
          { modelText, deferUntilIdle, submittedPrompt },
        ];
        setQueuedMessages(queueRef.current);
      }
    },
    [],
  );

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueuedMessages([]);
  }, []);

  const getQueuedMessagesText = useCallback(() => {
    if (queuedMessages.length === 0) return '';
    return queuedMessages.map(({ modelText }) => modelText).join('\n\n');
  }, [queuedMessages]);

  const popAllMessages = useCallback((): QueuedSubmission | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    queueRef.current = [];
    setQueuedMessages([]);
    return aggregateMessages(current);
  }, []);

  const restoreMessages = useCallback((messages: string[]) => {
    const restored = messages
      .map((text) => text.trim())
      .filter(Boolean)
      .map((modelText) => ({ modelText, deferUntilIdle: false }));
    if (restored.length === 0) return;
    queueRef.current = [...restored, ...queueRef.current];
    setQueuedMessages(queueRef.current);
  }, []);

  const drainQueue = useCallback((includeDeferred = false): string[] => {
    const current = queueRef.current;
    if (current.length === 0) return [];
    const shouldDrain = (message: QueuedMessage) =>
      (!isSlashCommand(message.modelText) ||
        (!includeDeferred && GOAL_COMMAND_RE.test(message.modelText))) &&
      (includeDeferred || !message.deferUntilIdle);
    const drained = current.filter(shouldDrain);
    if (drained.length === 0) return [];
    const rest = current.filter((message) => !shouldDrain(message));
    queueRef.current = rest;
    setQueuedMessages(rest);
    return drained.map(({ modelText }) => modelText);
  }, []);

  const popNextTurn = useCallback((): QueuedSubmission | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    const plainMessages = current.filter(
      (message) => !isSlashCommand(message.modelText),
    );
    const messages = plainMessages.length > 0 ? plainMessages : [current[0]];
    const selected = new Set(messages);
    const rest = current.filter((message) => !selected.has(message));
    queueRef.current = rest;
    setQueuedMessages(rest);
    return aggregateMessages(messages);
  }, []);

  return {
    messageQueue: queuedMessages.map(({ modelText }) => modelText),
    addMessage,
    clearQueue,
    getQueuedMessagesText,
    popAllMessages,
    restoreMessages,
    drainQueue,
    popNextTurn,
  };
}
