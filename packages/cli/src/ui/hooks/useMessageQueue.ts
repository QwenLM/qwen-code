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

/**
 * Where a queued submission came from.
 *
 * `'peer'` marks an envelope delivered by another session. The queue is
 * shared with typed input, and the drain would otherwise submit it as a
 * user query — which routes it through slash/shell/@ preprocessing, so a
 * receiver sitting in `!` shell mode would EXECUTE peer content with no
 * approval prompt. Origin is what lets the drain route it around that.
 */
export type SubmissionOrigin = 'typed' | 'peer';

export interface QueuedUserSubmission {
  kind: 'user';
  modelText: string;
  submittedPrompt?: string;
  turnKey: string;
  origin: SubmissionOrigin;
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
    origin?: SubmissionOrigin,
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
  restoreMessages: (
    messages: string[],
    submittedPrompt?: string,
    origin?: SubmissionOrigin,
  ) => void;
  /**
   * Take the steerable messages out of the queue as bare text.
   *
   * Peer envelopes are deliberately left behind — see the implementation.
   */
  drainQueue: (includeDeferred?: boolean, goalTurnActive?: boolean) => string[];
}

interface QueuedMessage {
  key: string;
  text: string;
  submittedPrompt?: string;
  deferUntilIdle: boolean;
  origin: SubmissionOrigin;
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
    // Callers below keep peer and typed entries in separate batches, but a
    // whole-queue drain (cancel, /btw) cannot. Resolve a mixed batch as
    // 'peer': the cost is a typed `!command` reaching the model instead of
    // the shell, versus peer content reaching the shell the other way.
    origin: messages.some((message) => message.origin === 'peer')
      ? 'peer'
      : 'typed',
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
    (
      message: string,
      deferUntilIdle = false,
      submittedPrompt?: string,
      origin: SubmissionOrigin = 'typed',
    ) => {
      const text = message.trim();
      if (!text) return;
      queueRef.current = [
        ...queueRef.current,
        {
          key: nextMessageKey(),
          text,
          deferUntilIdle,
          submittedPrompt,
          origin,
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
        // Batch only entries that share the head's origin. Peer envelopes
        // are submitted with a different type than typed input (they skip
        // slash/shell/@ preprocessing), so a mixed batch would have to
        // pick one and mistreat the rest. Whichever origin is at the head
        // goes first; the others stay queued and drain on the next pass.
        const batchOrigin = plainMessages[0].origin;
        const batch = plainMessages.filter(
          ({ origin }) => origin === batchOrigin,
        );
        const batchKeys = new Set(batch.map(({ key }) => key));
        queueRef.current = queueRef.current.filter(
          ({ key }) => !batchKeys.has(key),
        );
        setQueuedMessages(queueRef.current);
        return aggregateUserMessages(batch);
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
    (
      messages: string[],
      submittedPrompt?: string,
      origin: SubmissionOrigin = 'typed',
    ) => {
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
          // A submission that failed admission goes back with the origin it
          // arrived with, or the retry would submit a peer envelope as
          // typed input and re-open the shell-execution path.
          origin,
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
        // Peer envelopes never steer. This drain returns bare text, and
        // every restore path behind it (steer aborted, preprocessing threw,
        // the client declined the steer) puts that text back with origin
        // defaulting to 'typed' — which would submit the envelope as a user
        // query and hand it to the shell/slash/@ preprocessing the origin
        // tag exists to skip. Widening the drain and all four restore sites
        // to carry origin would keep the tag alive, but steering is the
        // wrong destination for peer content anyway: it would splice
        // another session's text into the middle of the user's in-flight
        // turn. Leaving it queued costs it the current turn and no more —
        // the idle drain picks it up at the turn boundary through the
        // origin-aware popNextSubmission path.
        message.origin !== 'peer' &&
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
