/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { useCallback, useRef, useState } from 'react';
import type { GoalTurnHost, GoalTurnPermit } from '@qwen-code/qwen-code-core';
import { isSlashCommand } from '../utils/commandUtils.js';
import type { PeerQueuedDelivery } from '../../peerMessaging/peer-messaging.js';

export interface QueuedGoalTurn {
  kind: 'goal';
  permit: GoalTurnPermit;
  turnKey: string;
  continuationContext: string;
  objectiveUpdated?: boolean;
  windDown?: boolean;
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

export interface QueuedPeerSubmission {
  kind: 'peer';
  modelText: string;
  displayText: string;
  /**
   * The drain already rendered this entry's notification; set when a
   * failed admission restores it so the retry does not re-render it.
   */
  displayed?: boolean;
  delivery?: PeerQueuedDelivery;
}

export type QueuedSubmission =
  | QueuedUserSubmission
  | QueuedPeerSubmission
  | QueuedGoalTurn;
export type GoalQueueControlMode = 'normal' | 'priority' | 'only';

export interface UseMessageQueueReturn {
  messageQueue: string[];
  pendingSubmissionCount: number;
  addMessage: (
    message: string,
    deferUntilIdle?: boolean,
    submittedPrompt?: string,
  ) => void;
  addPeerMessage: (
    message: string,
    displayText: string,
    delivery?: PeerQueuedDelivery,
  ) => void;
  enqueueGoalTurn: (
    input: Parameters<GoalTurnHost['startGoalTurn']>[0],
  ) => void;
  peekNextUserBatchKey: (goalTurnActive?: boolean) => string | undefined;
  hasQueuedUserMessages: () => boolean;
  getPendingSubmissionCount: () => number;
  getQueuedPeerCount: () => number;
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
    deferUntilIdle?: boolean,
  ) => void;
  restorePeerMessage: (
    message: string,
    displayText: string,
    displayed?: boolean,
    delivery?: PeerQueuedDelivery,
  ) => void;
  drainQueue: (includeDeferred?: boolean, goalTurnActive?: boolean) => string[];
}

interface QueuedMessage {
  key: string;
  text: string;
  submittedPrompt?: string;
  deferUntilIdle: boolean;
  /**
   * A delivered cross-session envelope. Drained alone and submitted on a
   * path that skips user-input preprocessing — the text is peer-authored,
   * so it must not run through `@path`/slash/shell handling.
   */
  peer?: boolean;
  /** Peer-only: its notification was already rendered before a restore. */
  displayed?: boolean;
  /** Peer-only: frame identity used to re-check its recipient at drain. */
  delivery?: PeerQueuedDelivery;
}

export const GOAL_COMMAND_RE = /^\/goal(?:\s|$)/;

function aggregateUserMessages(
  messages: readonly QueuedMessage[],
): QueuedUserSubmission {
  const text = messages.map((message) => message.text).join('\n\n');
  // Every member contributes a projection — its own when it has one, its
  // model text otherwise — so a single projection-less member cannot drop
  // a peer message's one-liner and surface the raw envelope as the
  // user's prompt instead.
  const submittedPrompt = messages
    .map((message) => message.submittedPrompt ?? message.text)
    .join('\n\n');
  return {
    kind: 'user',
    modelText: text,
    turnKey: messages[0].key,
    submittedPrompt,
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

  const addPeerMessage = useCallback(
    (message: string, displayText: string, delivery?: PeerQueuedDelivery) => {
      const text = message.trim();
      if (!text) return;
      queueRef.current = [
        ...queueRef.current,
        {
          key: nextMessageKey(),
          text,
          // Deferred exactly like the typed-input-deferred path: the
          // mid-turn steer drain returns raw text only, and a drained
          // envelope would be steered into the active turn with its
          // projection lost.
          deferUntilIdle: true,
          submittedPrompt: displayText,
          peer: true,
          ...(delivery !== undefined ? { delivery } : {}),
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
        ...(input.objectiveUpdated
          ? { objectiveUpdated: input.objectiveUpdated }
          : {}),
        ...(input.windDown ? { windDown: true } : {}),
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

  const getQueuedPeerCount = useCallback(
    () => queueRef.current.filter(({ peer }) => Boolean(peer)).length,
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

      const head = queueRef.current[0];
      if (head?.peer) {
        queueRef.current = queueRef.current.slice(1);
        setQueuedMessages(queueRef.current);
        return {
          kind: 'peer',
          modelText: head.text,
          displayText: head.submittedPrompt ?? head.text,
          ...(head.displayed ? { displayed: true } : {}),
          ...(head.delivery !== undefined ? { delivery: head.delivery } : {}),
        };
      }

      const plainMessages = queueRef.current.filter(
        ({ text, peer }) => !isSlashCommand(text) && !peer,
      );
      if (plainMessages.length > 0) {
        queueRef.current = queueRef.current.filter(
          ({ text, peer }) => isSlashCommand(text) || Boolean(peer),
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
      // Peer entries stay queued: this pop restores user text into the
      // editable buffer, and a peer-authored envelope re-submitted from
      // there would run through UserQuery preprocessing (`@path`/slash/
      // shell) with its attribution lost. They drain on their own path
      // once the session is idle again.
      const popped = current.filter(({ peer }) => !peer);
      if (popped.length === 0) return null;
      queueRef.current = current.filter(({ peer }) => Boolean(peer));
      setQueuedMessages(queueRef.current);
      onRemoved?.(popped.map(({ key }) => key));
      return aggregateUserMessages(popped);
    },
    [],
  );

  const restoreMessages = useCallback(
    (messages: string[], submittedPrompt?: string, deferUntilIdle = false) => {
      const restored = messages
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({
          key: nextMessageKey(),
          text,
          ...(messages.length === 1 && submittedPrompt !== undefined
            ? { submittedPrompt }
            : {}),
          deferUntilIdle,
        }));
      if (restored.length === 0) return;
      queueRef.current = [...restored, ...queueRef.current];
      setQueuedMessages(queueRef.current);
    },
    [nextMessageKey],
  );

  const restorePeerMessage = useCallback(
    (
      message: string,
      displayText: string,
      displayed = false,
      delivery?: PeerQueuedDelivery,
    ) => {
      const text = message.trim();
      if (!text) return;
      queueRef.current = [
        {
          key: nextMessageKey(),
          text,
          deferUntilIdle: true,
          submittedPrompt: displayText,
          peer: true,
          ...(displayed ? { displayed: true } : {}),
          ...(delivery !== undefined ? { delivery } : {}),
        },
        ...queueRef.current,
      ];
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
    addPeerMessage,
    enqueueGoalTurn,
    peekNextUserBatchKey,
    hasQueuedUserMessages,
    getPendingSubmissionCount,
    getQueuedPeerCount,
    claimGoalTurn,
    claimDirectUserAdmission,
    removeGoalTurns,
    popNextSubmission,
    clearQueue,
    getQueuedMessagesText,
    popAllMessages,
    restoreMessages,
    restorePeerMessage,
    drainQueue,
  };
}
