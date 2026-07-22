/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useRef, useState } from 'react';
import type { GoalTurnHost, GoalTurnPermit } from '@qwen-code/qwen-code-core';
import { randomUUID } from 'node:crypto';
import { isSlashCommand } from '../utils/commandUtils.js';

export interface QueuedGoalTurn {
  kind: 'goal';
  permit: GoalTurnPermit;
  turnKey: string;
  continuationContext: string;
  verifierFeedback?: string;
}

export interface QueuedUserSubmission {
  kind: 'user';
  text: string;
  turnKey: string;
}

export interface DirectUserAdmission {
  turnKey: string;
  goal?: QueuedGoalTurn;
}

export type QueuedSubmission = QueuedUserSubmission | QueuedGoalTurn;

export interface UseMessageQueueReturn {
  messageQueue: string[];
  pendingSubmissionCount: number;
  addMessage: (message: string, deferUntilIdle?: boolean) => void;
  enqueueGoalTurn: (
    input: Parameters<GoalTurnHost['startGoalTurn']>[0],
  ) => void;
  peekNextUserBatchKey: () => string | undefined;
  hasQueuedUserMessages: () => boolean;
  getPendingSubmissionCount: () => number;
  claimGoalTurn: () => QueuedGoalTurn | undefined;
  claimDirectUserAdmission: () => DirectUserAdmission;
  removeGoalTurns: () => number;
  popNextSubmission: (
    holdUserForStoppedGoal?: boolean,
  ) => QueuedSubmission | null;
  clearQueue: () => void;
  getQueuedMessagesText: () => string;
  /** Drain the entire queue joined with `\n\n`. For Ctrl+C / ESC / Up edit-restore. */
  popAllMessages: (onRemoved?: (turnKeys: string[]) => void) => string | null;
  /** Restore interrupted steer messages to the front of the queue. */
  restoreMessages: (messages: string[]) => void;
  /**
   * Drain plain-text prompts that can steer the active turn. Pass true at the
   * idle boundary to also drain messages explicitly deferred with Ctrl+Q.
   * Slash commands stay queued. While a Goal turn owns the exact permit, only
   * `/goal` controls may interrupt it; creating a Goal during an ordinary turn
   * waits for the idle boundary so its first permit cannot overtake ToolResult.
   */
  drainQueue: (includeDeferred?: boolean, goalTurnActive?: boolean) => string[];
  /** Pop the first item from the queue. */
  popNextSegment: () => string | null;
}

interface QueuedMessage {
  key: string;
  text: string;
  deferUntilIdle: boolean;
}

export const GOAL_COMMAND_RE = /^\/goal(?:\s|$)/;

export function useMessageQueue(): UseMessageQueueReturn {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queuedGoalTurns, setQueuedGoalTurns] = useState<QueuedGoalTurn[]>([]);
  // Synchronous mirror so non-React callbacks see the latest queue.
  const queueRef = useRef<QueuedMessage[]>([]);
  const goalQueueRef = useRef<QueuedGoalTurn[]>([]);
  const nextMessageKey = useCallback(() => `message-queue:${randomUUID()}`, []);

  const addMessage = useCallback(
    (message: string, deferUntilIdle = false) => {
      const trimmedMessage = message.trim();
      if (trimmedMessage.length > 0) {
        queueRef.current = [
          ...queueRef.current,
          {
            key: nextMessageKey(),
            text: trimmedMessage,
            deferUntilIdle,
          },
        ];
        setQueuedMessages(queueRef.current);
      }
    },
    [nextMessageKey],
  );

  const enqueueGoalTurn = useCallback(
    (input: Parameters<GoalTurnHost['startGoalTurn']>[0]) => {
      if (
        goalQueueRef.current.some(
          ({ permit }) => permit.turnId === input.permit.turnId,
        )
      ) {
        return;
      }
      const entry: QueuedGoalTurn = {
        kind: 'goal',
        permit: { ...input.permit },
        turnKey: `goal-runtime:${input.permit.turnId}`,
        continuationContext: input.continuationContext,
        ...(input.verifierFeedback
          ? { verifierFeedback: input.verifierFeedback }
          : {}),
      };
      goalQueueRef.current = [...goalQueueRef.current, entry];
      setQueuedGoalTurns(goalQueueRef.current);
    },
    [],
  );

  const peekNextUserBatchKey = useCallback(
    () => queueRef.current.find(({ text }) => !isSlashCommand(text))?.key,
    [],
  );
  const hasQueuedUserMessages = useCallback(
    () => queueRef.current.length > 0,
    [],
  );
  const getPendingSubmissionCount = useCallback(
    () => queueRef.current.length + goalQueueRef.current.length,
    [],
  );

  const claimGoalTurn = useCallback((): QueuedGoalTurn | undefined => {
    const [goal, ...remainingGoals] = goalQueueRef.current;
    if (goal) {
      goalQueueRef.current = remainingGoals;
      setQueuedGoalTurns(remainingGoals);
    }
    return goal;
  }, []);

  const claimDirectUserAdmission = useCallback((): DirectUserAdmission => {
    const goal = claimGoalTurn();
    return {
      turnKey: nextMessageKey(),
      ...(goal ? { goal } : {}),
    };
  }, [claimGoalTurn, nextMessageKey]);

  const removeGoalTurns = useCallback((): number => {
    const removed = goalQueueRef.current.length;
    if (removed === 0) return 0;
    goalQueueRef.current = [];
    setQueuedGoalTurns([]);
    return removed;
  }, []);

  const popNextSubmission = useCallback(
    (holdUserForStoppedGoal = false): QueuedSubmission | null => {
      if (holdUserForStoppedGoal) {
        const goalCommandIndex = queueRef.current.findIndex(({ text }) =>
          GOAL_COMMAND_RE.test(text),
        );
        if (goalCommandIndex < 0) return null;
        const goalCommand = queueRef.current[goalCommandIndex];
        queueRef.current = [
          ...queueRef.current.slice(0, goalCommandIndex),
          ...queueRef.current.slice(goalCommandIndex + 1),
        ];
        setQueuedMessages(queueRef.current);
        return {
          kind: 'user',
          text: goalCommand.text,
          turnKey: goalCommand.key,
        };
      }

      const plainMessages = queueRef.current.filter(
        ({ text }) => !isSlashCommand(text),
      );
      if (plainMessages.length > 0) {
        queueRef.current = queueRef.current.filter(({ text }) =>
          isSlashCommand(text),
        );
        setQueuedMessages(queueRef.current);
        return {
          kind: 'user',
          text: plainMessages.map(({ text }) => text).join('\n\n'),
          turnKey: plainMessages[0].key,
        };
      }

      const [userHead, ...userRest] = queueRef.current;
      if (userHead) {
        queueRef.current = userRest;
        setQueuedMessages(userRest);
        return {
          kind: 'user',
          text: userHead.text,
          turnKey: userHead.key,
        };
      }

      const [goalHead, ...goalRest] = goalQueueRef.current;
      if (!goalHead) return null;
      goalQueueRef.current = goalRest;
      setQueuedGoalTurns(goalRest);
      return goalHead;
    },
    [],
  );

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueuedMessages([]);
  }, []);

  const getQueuedMessagesText = useCallback(() => {
    if (queuedMessages.length === 0) return '';
    return queuedMessages.map(({ text }) => text).join('\n\n');
  }, [queuedMessages]);

  const popAllMessages = useCallback(
    (onRemoved?: (turnKeys: string[]) => void): string | null => {
      const current = queueRef.current;
      if (current.length === 0) return null;
      queueRef.current = [];
      setQueuedMessages([]);
      onRemoved?.(current.map(({ key }) => key));
      return current.map(({ text }) => text).join('\n\n');
    },
    [],
  );

  const restoreMessages = useCallback(
    (messages: string[]) => {
      const restored = messages
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({
          key: nextMessageKey(),
          text,
          deferUntilIdle: false,
        }));
      if (restored.length === 0) return;
      queueRef.current = [...restored, ...queueRef.current];
      setQueuedMessages(queueRef.current);
    },
    [nextMessageKey],
  );

  const drainQueue = useCallback(
    (includeDeferred = false, goalTurnActive = false): string[] => {
      const current = queueRef.current;
      if (current.length === 0) return [];
      const shouldDrain = (message: QueuedMessage) =>
        (goalTurnActive
          ? GOAL_COMMAND_RE.test(message.text)
          : !isSlashCommand(message.text)) &&
        (includeDeferred || !message.deferUntilIdle);
      const drained = current.filter(shouldDrain);
      if (drained.length === 0) return [];
      const rest = current.filter((message) => !shouldDrain(message));
      queueRef.current = rest;
      setQueuedMessages(rest);
      return drained.map(({ text }) => text);
    },
    [],
  );

  const popNextSegment = useCallback((): string | null => {
    const current = queueRef.current;
    if (current.length === 0) return null;
    const [head, ...rest] = current;
    queueRef.current = rest;
    setQueuedMessages(rest);
    return head.text;
  }, []);

  return {
    messageQueue: queuedMessages.map(({ text }) => text),
    pendingSubmissionCount: queuedMessages.length + queuedGoalTurns.length,
    addMessage,
    enqueueGoalTurn,
    peekNextUserBatchKey,
    hasQueuedUserMessages,
    getPendingSubmissionCount,
    claimGoalTurn,
    claimDirectUserAdmission,
    removeGoalTurns,
    popNextSubmission,
    clearQueue,
    getQueuedMessagesText,
    popAllMessages,
    restoreMessages,
    drainQueue,
    popNextSegment,
  };
}
