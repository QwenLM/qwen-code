/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified message queue manager.
 *
 * - Module-level queue, independent of React state
 * - Priority-based dequeuing: 'now' > 'next' > 'later'
 * - React integration via subscribe/getSnapshot (useSyncExternalStore)
 * - Non-React code reads via getQueueLength/dequeue
 *
 * All commands — user input, task notifications, orphaned permissions — go
 * through this single queue. React consumers drain it when the model is idle.
 */

import { runLogger } from '../utils/runLogger.js';
import { isSlashCommandStyleUserPromptText } from '../utils/commandStyleText.js';
import type {
  QueuedCommand,
  CommandMode,
  QueuePriority,
} from '../input/types.js';

// Re-export for convenience
export type { QueuedCommand, CommandMode, QueuePriority };

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
};

// ============================================================================
// Module-level queue
// ============================================================================

const commandQueue: QueuedCommand[] = [];
let commandQueueRevision = 0;
/** Frozen snapshot -- recreated on every mutation for useSyncExternalStore. */
let snapshot: readonly QueuedCommand[] = Object.freeze([]);
const listeners = new Set<() => void>();
/**
 * Commands already selected for the next turn but not yet committed to
 * execution. The batch stays observable to cancellation even when an idle
 * dispatcher has physically removed it from the queue.
 */
let inFlightDrainBatch: readonly QueuedCommand[] | null = null;
let cancelEntireInFlightDrainBatch = false;
/**
 * UUIDs targeted after their command entered the in-flight batch.
 *
 * Once commands have been coalesced, only the representative command (the
 * last UUID-bearing command in the batch) can cancel execution, and it
 * cancels the entire batch. Markers for non-representative commands are
 * consumed as no-ops.
 */
const cancelPendingUuids = new Set<string>();

function notifySubscribers(): void {
  snapshot = Object.freeze([...commandQueue]);
  for (const listener of listeners) {
    listener();
  }
}

function notifyQueueMutation(): void {
  commandQueueRevision += 1;
  notifySubscribers();
}

// ============================================================================
// useSyncExternalStore interface
// ============================================================================

/**
 * Subscribe to command queue changes.
 * Compatible with React's useSyncExternalStore.
 */
export function subscribeToCommandQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Get current snapshot of the command queue.
 * Compatible with React's useSyncExternalStore.
 */
export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return snapshot;
}

// ============================================================================
// Read operations
// ============================================================================

/**
 * Get a mutable copy of the current queue.
 * Use for one-off reads where you need the actual commands.
 */
export function getCommandQueue(): QueuedCommand[] {
  return [...commandQueue];
}

/**
 * Get the current queue length without copying.
 */
export function getCommandQueueLength(): number {
  return commandQueue.length;
}

export function getCommandQueueRevision(): number {
  return commandQueueRevision;
}

/**
 * Check if there are commands in the queue.
 */
export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0;
}

/**
 * Trigger a re-check by notifying subscribers.
 * Use after async processing completes to ensure remaining commands
 * are picked up by useSyncExternalStore consumers.
 */
export function recheckCommandQueue(): void {
  if (commandQueue.length > 0) {
    notifySubscribers();
  }
}

/**
 * Retain the dequeued batch while its async input dispatch is in progress.
 * This keeps commands observable across the dequeue -> query handoff gap.
 */
export function setInFlightDrainBatch(
  commands: readonly QueuedCommand[],
): void {
  inFlightDrainBatch = commands;
  cancelEntireInFlightDrainBatch = false;
}

/**
 * Clear the current in-flight batch. When a batch is provided, only clear an
 * identical reservation so a stale finally block cannot erase newer state.
 */
export function clearInFlightDrainBatch(
  commands?: readonly QueuedCommand[],
): void {
  if (commands === undefined || inFlightDrainBatch === commands) {
    inFlightDrainBatch = null;
    cancelEntireInFlightDrainBatch = false;
  }
}

/** Return whether the current in-flight drain contains a matching command. */
export function someInFlightDrainCommand(
  predicate: (cmd: QueuedCommand) => boolean,
): boolean {
  return inFlightDrainBatch?.some(predicate) ?? false;
}

/** Return a stable copy of the current in-flight batch. */
export function getInFlightDrainBatch(): readonly QueuedCommand[] {
  return inFlightDrainBatch ? [...inFlightDrainBatch] : [];
}

/**
 * Record a cancellation that arrived after a command entered an in-flight
 * coalesced batch.
 *
 * Repeated cancellation requests for the same UUID remain idempotent.
 */
export function markCancelPending(uuid: string): void {
  cancelPendingUuids.add(uuid);
}

/**
 * Mark the current dequeue-to-dispatch batch for unconditional removal.
 *
 * Standard `cancel_async_message` retains representative-UUID granularity.
 * An interrupt with `cancel_queued:true` uses this operation when the batch
 * contains a matching main-thread command, including a command without a
 * public UUID.
 */
export function markInFlightDrainBatchCancelPending(
  predicate: (command: QueuedCommand) => boolean = () => true,
): readonly QueuedCommand[] {
  if (!inFlightDrainBatch || !inFlightDrainBatch.some(predicate)) return [];
  cancelEntireInFlightDrainBatch = true;
  return inFlightDrainBatch.filter(predicate);
}

/**
 * Consume a dequeue-to-dispatch cancellation marker.
 *
 * Returns `true` exactly once for each UUID recorded by
 * `markCancelPending()`.
 */
export function consumeCancelPending(uuid: string): boolean {
  return cancelPendingUuids.delete(uuid);
}

/**
 * Settle cancellation markers for a coalesced in-flight batch.
 *
 * The last command with a public UUID is the batch representative. Cancelling
 * it drops the entire batch; cancelling any other member is a no-op. All
 * member markers are consumed so they cannot affect a later command that
 * reuses a UUID.
 *
 * Known gap: a cross-session peer message carries a UUID too, so one landing at
 * the end of a coalesced batch becomes that batch's representative — and an SDK
 * client cancelling its own command then finds nothing dropped. Peer traffic is
 * not sent by that client and has no business representing its batch, but
 * narrowing the rule is a queue-semantics change rather than a transport fix.
 * Tracked separately; do not read the peer transport's own hardening as having
 * closed this.
 */
export function consumeInFlightBatchCancellation(
  commands: readonly QueuedCommand[],
): boolean {
  const cancelEntireBatch =
    inFlightDrainBatch === commands && cancelEntireInFlightDrainBatch;
  const representativeUuid = commands.findLast(
    (command) => command.uuid !== undefined,
  )?.uuid;
  let representativeCancelled = false;

  for (const command of commands) {
    if (!command.uuid) continue;
    const cancelled = consumeCancelPending(command.uuid);
    if (command.uuid === representativeUuid && cancelled) {
      representativeCancelled = true;
    }
  }

  if (cancelEntireBatch) {
    cancelEntireInFlightDrainBatch = false;
  }
  return cancelEntireBatch || representativeCancelled;
}

// ============================================================================
// Write operations
// ============================================================================

/**
 * Add a command to the queue.
 * Used for user-initiated commands (prompt, bash, orphaned-permission).
 * Defaults priority to 'next' (processed before task notifications).
 */
export function enqueue(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'next' });
  notifyQueueMutation();
  runLogger.debug(
    `[MessageQueue] enqueue: commandMode=${command.commandMode}, priority=${command.priority ?? 'next'}, ` +
      `queueLength=${commandQueue.length}`,
  );
}

/**
 * Add a task notification to the queue.
 * Convenience wrapper that defaults priority to 'later' so user input
 * is never starved by system messages.
 */
export function enqueuePendingNotification(command: QueuedCommand): void {
  commandQueue.push({ ...command, priority: command.priority ?? 'later' });
  notifyQueueMutation();
  runLogger.debug(
    `[MessageQueue] enqueue: commandMode=${command.commandMode}, priority=${command.priority ?? 'later'}, ` +
      `queueLength=${commandQueue.length}`,
  );
}

/**
 * Find the index of the highest-priority command matching an optional filter.
 * Returns -1 if the queue is empty or no command matches.
 */
function findHighestPriorityIndex(
  filter?: (cmd: QueuedCommand) => boolean,
): number {
  if (commandQueue.length === 0) return -1;
  let bestIdx = -1;
  let bestPriority = Infinity;
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i];
    if (!cmd) continue;
    if (filter && !filter(cmd)) continue;
    const priority = PRIORITY_ORDER[cmd.priority ?? 'next'];
    if (priority < bestPriority) {
      bestIdx = i;
      bestPriority = priority;
    }
  }
  return bestIdx;
}

/**
 * Remove and return the highest-priority command, or undefined if empty.
 * Within the same priority level, commands are dequeued FIFO.
 *
 * An optional `filter` narrows the candidates: only commands for which the
 * predicate returns true are considered.
 */
export function dequeue(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const bestIdx = findHighestPriorityIndex(filter);
  if (bestIdx === -1) return undefined;

  const [dequeued] = commandQueue.splice(bestIdx, 1);
  notifyQueueMutation();
  return dequeued;
}

/**
 * Return the highest-priority command without removing it, or undefined if empty.
 * Accepts an optional `filter` — only commands passing the predicate are considered.
 */
export function peek(
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand | undefined {
  const bestIdx = findHighestPriorityIndex(filter);
  if (bestIdx === -1) return undefined;
  return commandQueue[bestIdx];
}

/**
 * Remove and return all commands matching a predicate.
 * Non-matching commands stay in the queue.
 */
export function dequeueAllMatching(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const matched: QueuedCommand[] = [];
  const remaining: QueuedCommand[] = [];
  for (const cmd of commandQueue) {
    if (predicate(cmd)) {
      matched.push(cmd);
    } else {
      remaining.push(cmd);
    }
  }
  if (matched.length === 0) {
    return [];
  }
  commandQueue.length = 0;
  commandQueue.push(...remaining);
  notifyQueueMutation();
  return matched;
}

/**
 * Return all commands at or above a given priority threshold WITHOUT removing them.
 * Used for mid-turn drain where commands are consumed then explicitly removed.
 */
export function getCommandsByMaxPriority(
  maxPriority: QueuePriority,
  filter?: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const threshold = PRIORITY_ORDER[maxPriority];
  return commandQueue.filter(
    (cmd) =>
      PRIORITY_ORDER[cmd.priority ?? 'next'] <= threshold &&
      (!filter || filter(cmd)),
  );
}

/**
 * Remove specific commands from the queue by reference identity.
 */
export function remove(commandsToRemove: QueuedCommand[]): void {
  if (commandsToRemove.length === 0) {
    return;
  }

  const toRemove = new Set(commandsToRemove);
  const before = commandQueue.length;
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    const cmd = commandQueue[i];
    if (cmd && toRemove.has(cmd)) {
      commandQueue.splice(i, 1);
    }
  }

  if (commandQueue.length !== before) {
    notifyQueueMutation();
  }
}

/**
 * Remove commands matching a predicate.
 * Returns the removed commands.
 */
export function removeByFilter(
  predicate: (cmd: QueuedCommand) => boolean,
): QueuedCommand[] {
  const removed: QueuedCommand[] = [];
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    const cmd = commandQueue[i];
    if (cmd && predicate(cmd)) {
      removed.unshift(commandQueue.splice(i, 1)[0]);
    }
  }

  if (removed.length > 0) {
    notifyQueueMutation();
  }

  return removed;
}

/**
 * Clear all commands from the queue.
 * Used by ESC cancellation to discard queued notifications.
 */
export function clearCommandQueue(): void {
  if (commandQueue.length === 0) {
    return;
  }
  commandQueue.length = 0;
  notifyQueueMutation();
}

/**
 * Returns true if the command is a slash command that should be routed through
 * processSlashCommand rather than sent to the model as text.
 */
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.prompt === 'string' &&
    isSlashCommandStyleUserPromptText(cmd.prompt, {
      commandCatalogReady: false,
    }) &&
    !cmd.skipSlashCommands
  );
}

// ============================================================================
// Test helpers
// ============================================================================

/** @internal Test helper -- clears all queue state. */
export function _resetQueueForTest(): void {
  commandQueue.length = 0;
  commandQueueRevision = 0;
  snapshot = Object.freeze([]);
  listeners.clear();
  inFlightDrainBatch = null;
  cancelPendingUuids.clear();
  cancelEntireInFlightDrainBatch = false;
}
