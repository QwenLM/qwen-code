/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { useCallback, useRef, useState } from 'react';
import type { GoalTurnHost, GoalTurnPermit } from '@qwen-code/qwen-code-core';
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
  modelText: string;
  submittedPrompt?: string;
  turnKey: string;
}

export interface DirectUserAdmission {
  turnKey: string;
  goal?: QueuedGoalTurn;
}

export type QueuedSubmission = QueuedUserSubmission | QueuedGoalTurn;
export type GoalQueueControlMode = 'normal' | 'priority' | 'only';

export interface UseMessageQueueReturn {
  messageQueue: string[];
  pendingSubmissionCount: number;
  addMessage: (
    message: string,
    deferUntilIdle?: boolean,
    submittedPrompt?: string,
  ) => void;
  enqueueGoalTurn: (
    input: Parameters<GoalTurnHost['startGoalTurn']>[0],
  ) => void;
  peekNextUserBatchKey: (goalTurnActive?: boolean) => string | undefined;
  hasQueuedUserMessages: () => boolean;
  getPendingSubmissionCount: () => number;
  claimGoalTurn: () => QueuedGoalTurn | undefined;
  claimDirectUserAdmission: () => DirectUserAdmission;
  removeGoalTurns: () => string[];
  popNextSubmission: (
    goalControlMode?: GoalQueueControlMode,
  ) => QueuedSubmission | null;
  clearQueue: () => void;
  getQueuedMessagesText: () => string;
  popAllMessages: (
    onRemoved?: (turnKeys: string[]) => void,
  ) => QueuedUserSubmission | null;
  restoreMessages: (messages: string[], submittedPrompt?: string) => void;
  drainQueue: (includeDeferred?: boolean, goalTurnActive?: boolean) => string[];
}

interface QueuedMessage {
  key: string;
  text: string;
  submittedPrompt?: string;
  deferUntilIdle: boolean;
}

export const GOAL_COMMAND_RE = /^\/goal(?:\s|$)/;

function aggregateUserMessages(
  messages: readonly QueuedMessage[],
): QueuedUserSubmission {
  const text = messages.map((message) => message.text).join('\n\n');
  const submittedPrompts = messages.map((message) => message.submittedPrompt);
  return {
    kind: 'user',
    modelText: text,
    turnKey: messages[0].key,
    ...(submittedPrompts.every(
      (submittedPrompt): submittedPrompt is string =>
        submittedPrompt !== undefined,
    )
      ? { submittedPrompt: submittedPrompts.join('\n\n') }
      : {}),
  };
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queuedGoalTurns, setQueuedGoalTurns] = useState<QueuedGoalTurn[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  const goalQueueRef = useRef<QueuedGoalTurn[]>([]);
  const nextMessageKey = useCallback(() => `message-queue:${randomUUID()}`, []);

  const addMessage = useCallback(
    (message: string, deferUntilIdle = false, submittedPrompt?: string) => {
      const text = message.trim();
      if (!text) return;
      queueRef.current = [
        ...queueRef.current,
        {
          key: nextMessageKey(),
          text,
          deferUntilIdle,
          submittedPrompt,
        },
      ];
      setQueuedMessages(queueRef.current);
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
    (goalTurnActive = false) =>
      goalTurnActive
        ? undefined
        : queueRef.current.find(({ text }) => !isSlashCommand(text))?.key,
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

  const removeGoalTurns = useCallback((): string[] => {
    const keys = goalQueueRef.current.map(({ turnKey }) => turnKey);
    if (keys.length === 0) return [];
    goalQueueRef.current = [];
    setQueuedGoalTurns([]);
    return keys;
  }, []);

  const popNextSubmission = useCallback(
    (
      goalControlMode: GoalQueueControlMode = 'normal',
    ): QueuedSubmission | null => {
      if (goalControlMode !== 'normal') {
        const goalCommandIndex = queueRef.current.findIndex(({ text }) =>
          GOAL_COMMAND_RE.test(text),
        );
        if (goalCommandIndex >= 0) {
          const goalCommand = queueRef.current[goalCommandIndex];
          queueRef.current = [
            ...queueRef.current.slice(0, goalCommandIndex),
            ...queueRef.current.slice(goalCommandIndex + 1),
          ];
          setQueuedMessages(queueRef.current);
          return aggregateUserMessages([goalCommand]);
        }
        if (goalControlMode === 'priority') {
          return claimGoalTurn() ?? null;
        }
        if (goalControlMode === 'only') return null;
      }

      const plainMessages = queueRef.current.filter(
        ({ text }) => !isSlashCommand(text),
      );
      if (plainMessages.length > 0) {
        queueRef.current = queueRef.current.filter(({ text }) =>
          isSlashCommand(text),
        );
        setQueuedMessages(queueRef.current);
        return aggregateUserMessages(plainMessages);
      }

      const [userHead, ...userRest] = queueRef.current;
      if (userHead) {
        queueRef.current = userRest;
        setQueuedMessages(userRest);
        return aggregateUserMessages([userHead]);
      }

      return claimGoalTurn() ?? null;
    },
    [claimGoalTurn],
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
    (onRemoved?: (turnKeys: string[]) => void): QueuedUserSubmission | null => {
      const current = queueRef.current;
      if (current.length === 0) return null;
      queueRef.current = [];
      setQueuedMessages([]);
      onRemoved?.(current.map(({ key }) => key));
      return aggregateUserMessages(current);
    },
    [],
  );

  const restoreMessages = useCallback(
    (messages: string[], submittedPrompt?: string) => {
      const restored = messages
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({
          key: nextMessageKey(),
          text,
          ...(messages.length === 1 && submittedPrompt !== undefined
            ? { submittedPrompt }
            : {}),
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
  };
}
