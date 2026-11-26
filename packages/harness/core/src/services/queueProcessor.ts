/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Queue processor — unified dispatcher for the command queue.
 *
 * - Slash commands and bash-mode commands are processed one at a time
 * - Other commands are batched by same commandMode
 * - Main-thread filter skips sub-agent commands
 */

import type { QueuedCommand } from '../input/types.js';
import type { QueryGuard } from './QueryGuard.js';
import {
  clearInFlightDrainBatch,
  dequeue,
  dequeueAllMatching,
  isSlashCommand,
  peek,
  setInFlightDrainBatch,
} from './messageQueueManager.js';
import { runLogger } from '../utils/runLogger.js';
import { runWithoutAgentContext } from '../utils/agentContext.js';

export interface ProcessQueueParams {
  executeInput: (commands: QueuedCommand[]) => Promise<void>;
  queryGuard: QueryGuard;
}

export interface ProcessQueueResult {
  processed: boolean;
}

/**
 * Processes commands from the queue.
 *
 * Slash commands (starting with '/') and bash-mode commands are processed
 * one at a time so each goes through the executeInput path individually.
 * Other non-slash commands are batched: all items with the same commandMode
 * as the highest-priority item are drained at once and passed as a single
 * array to executeInput. Different modes (e.g. prompt vs task-notification)
 * are never mixed because they are treated differently downstream.
 *
 * The caller is responsible for ensuring no query is currently running
 * and for calling this function again after each command completes
 * until the queue is empty.
 */
export function processQueueIfReady({
  executeInput,
  queryGuard,
}: ProcessQueueParams): ProcessQueueResult {
  // Reserve synchronously before dequeueing. React state updates lag behind
  // this call, so the guard owns the dequeue -> async query handoff gap.
  if (!queryGuard.reserve()) {
    return { processed: false };
  }

  const cancelReservation = (): ProcessQueueResult => {
    queryGuard.cancelReservation();
    return { processed: false };
  };

  const dispatch = (commands: QueuedCommand[]): ProcessQueueResult => {
    setInFlightDrainBatch(commands);
    // A teammate can enqueue a continuation for the main loop from inside its
    // own async context. Detach before starting the main turn so caller
    // identity and all derived attribution remain owned by the main session.
    runWithoutAgentContext(() => {
      void executeInput(commands).finally(() => {
        clearInFlightDrainBatch(commands);
        // No-op once the reservation has transitioned to a running query.
        queryGuard.cancelReservation();
      });
    });
    return { processed: true };
  };

  // Main-thread filter: skip anything addressed to a subagent.
  const isMainThread = (cmd: QueuedCommand): boolean =>
    cmd.targetAgentId === undefined;

  const next = peek(isMainThread);
  if (!next) {
    return cancelReservation();
  }

  runLogger.debug(
    `[QueueProcessor] processQueueIfReady: next.commandMode=${next.commandMode}, ` +
      `next.priority=${next.priority}, prompt=${typeof next.prompt === 'string' ? next.prompt.slice(0, 80) : '[ContentBlock]'}`,
  );

  // Slash commands and bash-mode commands are processed individually.
  if (isSlashCommand(next) || next.commandMode === 'bash') {
    const cmd = dequeue(isMainThread);
    if (!cmd) return cancelReservation();
    runLogger.debug(
      `[QueueProcessor] dispatching single: commandMode=${cmd.commandMode}`,
    );
    return dispatch([cmd]);
  }

  // Drain all non-slash-command items with the same mode at once.
  const targetMode = next.commandMode;
  const commands = dequeueAllMatching(
    (cmd) =>
      isMainThread(cmd) &&
      !isSlashCommand(cmd) &&
      cmd.commandMode === targetMode,
  );
  if (commands.length === 0) {
    return cancelReservation();
  }

  runLogger.debug(
    `[QueueProcessor] dispatching batch: commandMode=${targetMode}, count=${commands.length}`,
  );
  return dispatch(commands);
}
