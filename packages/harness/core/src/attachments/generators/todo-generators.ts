/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Todo reminder attachment generator.
 *
 * Periodically injects a `todo_reminder` attachment to remind the LLM of the
 * current todo list when `write_todos` has not been called for a while.
 *
 * Throttle rules:
 *   TURNS_SINCE_WRITE       = 10  assistant turns without a write_todos call
 *   TURNS_BETWEEN_REMINDERS = 10  assistant turns between consecutive reminders
 *
 * State is derived entirely from the message history on each call, so it is
 * automatically correct after session resume — no persistent counters needed.
 *
 * Guards (skip generation entirely if any is true):
 *   1. write_todos is not in the active tool list
 *
 * Current todo list is extracted by scanning messages backwards for the most
 * recent write_todos tool_use block.
 */

import type { Todo } from '../../tools/tools.js';
import { WRITE_TODOS_TOOL_NAME } from '../../tools/tool-names.js';
import { TodoReminderAttachment } from '../types.js';
import type { Message } from '../../protocol/transcript/message.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const TODO_REMINDER_CONFIG = {
  /** Minimum assistant turns since last write_todos before injecting reminder. */
  TURNS_SINCE_WRITE: 10,
  /** Minimum assistant turns between consecutive todo_reminder injections. */
  TURNS_BETWEEN_REMINDERS: 10,
} as const;

const TERMINAL_TODO_STATUSES = new Set<Todo['status']>([
  'completed',
  'cancelled',
]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a `todo_reminder` attachment if the throttle conditions are met.
 *
 * @param messages          Current conversation history (read-only).
 * @param isTodoToolEnabled Whether the write_todos tool is in the active tool list.
 * @param fallbackTodos     Last known todos from ctx, used when the message scan
 *                          finds no write_todos (e.g. after context compression).
 * @returns Zero or one TodoReminderAttachment.
 */
export function getTodoReminderAttachments(
  messages: readonly Message[] | undefined,
  isTodoToolEnabled: boolean,
  fallbackTodos?: Todo[],
): TodoReminderAttachment[] {
  if (!isTodoToolEnabled) return [];

  let { turnsSinceLastWrite, turnsSinceLastReminder, currentTodos } =
    deriveTodoCounts(messages ?? []);

  // When fallbackTodos is set, compaction has occurred and the pre-compaction
  // history is gone. The short post-compaction history may not yet have enough
  // assistant turns to meet the TURNS_SINCE_WRITE threshold, which would
  // suppress the reminder even though write_todos was used long ago.
  // Override: treat the write as "infinitely long ago" so the reminder fires.
  if (fallbackTodos !== undefined && currentTodos.length === 0) {
    turnsSinceLastWrite = Number.MAX_SAFE_INTEGER;
  }

  if (
    turnsSinceLastWrite < TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE ||
    turnsSinceLastReminder < TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    return [];
  }

  const todos = currentTodos.length > 0 ? currentTodos : (fallbackTodos ?? []);

  if (todos.length === 0) return [];

  return [
    new TodoReminderAttachment({
      type: 'todo_reminder',
      content: todos,
      itemCount: todos.length,
    }),
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface TodoCounts {
  turnsSinceLastWrite: number;
  turnsSinceLastReminder: number;
  currentTodos: Todo[];
}

/**
 * Extract the most recent todo list from a message history by scanning for the
 * last write_todos tool_use block.  Returns an empty array when none is found.
 *
 * Exported for use by finalizePostCompact() to preserve todo state before the
 * pre-compression history is discarded.
 */
export function extractTodosFromHistory(messages: readonly Message[]): Todo[] {
  return findLastWriteTodosInput(messages) ?? [];
}

/**
 * Scan messages backwards to derive throttle counts and the current todo list.
 *
 * Counting unit: non-thinking assistant turns (extended thinking artefacts
 * carry no action signal and are excluded).
 */
function deriveTodoCounts(messages: readonly Message[]): TodoCounts {
  let turnsSinceLastWrite = 0;
  let turnsSinceLastReminder = 0;
  let lastWriteIndex = -1;
  let lastReminderIndex = -1;
  let currentTodos: Todo[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === 'assistant') {
      if (isThinkingOnlyMessage(msg.message.content)) continue;

      if (lastWriteIndex === -1) {
        const block = msg.message.content.find(
          (b): b is ModelToolUseBlock =>
            b.type === 'tool_use' && b.name === WRITE_TODOS_TOOL_NAME,
        );
        if (block) {
          lastWriteIndex = i;
          const input = block.input as { todos?: Todo[] };
          currentTodos = normalizeTodoWriteInput(input.todos);
        } else {
          turnsSinceLastWrite++;
        }
      }

      if (lastReminderIndex === -1) {
        turnsSinceLastReminder++;
      }
    } else if (msg.type === 'attachment') {
      if (lastReminderIndex === -1 && msg.attachment.type === 'todo_reminder') {
        lastReminderIndex = i;
      }
    }

    if (lastWriteIndex !== -1 && lastReminderIndex !== -1) break;
  }

  // If write_todos was never found in the current history (e.g. after /compact
  // wipes the assistant turns), treat it as "infinitely long ago" rather than
  // "just now".  The counter only increments for assistant turns *without*
  // write_todos, so an empty history yields 0 — which falsely passes the
  // "recently used" guard.
  if (lastWriteIndex === -1) {
    turnsSinceLastWrite = Number.MAX_SAFE_INTEGER;
  }

  // Same logic for the reminder cooldown: no reminder found → show one now.
  if (lastReminderIndex === -1) {
    turnsSinceLastReminder = Number.MAX_SAFE_INTEGER;
  }

  return { turnsSinceLastWrite, turnsSinceLastReminder, currentTodos };
}

/**
 * Find the write_todos input from the last assistant turn in the given slice.
 * Returns the todos array when found, null when no write_todos is present.
 */
function findLastWriteTodosInput(messages: readonly Message[]): Todo[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type !== 'assistant') continue;
    if (isThinkingOnlyMessage(msg.message.content)) continue;
    const block = msg.message.content.find(
      (b): b is ModelToolUseBlock =>
        b.type === 'tool_use' && b.name === WRITE_TODOS_TOOL_NAME,
    );
    if (block) {
      const input = block.input as { todos?: Todo[] };
      return normalizeTodoWriteInput(input.todos);
    }
  }
  return null;
}

/**
 * Reminder generation only needs actionable todos. Terminal items should not be
 * resurrected from transcript history or injected back into context.
 */
function normalizeTodoWriteInput(todos: unknown): Todo[] {
  if (!Array.isArray(todos)) return [];
  return (todos as Todo[]).filter(
    (todo) => !TERMINAL_TODO_STATUSES.has(todo.status),
  );
}

/** Returns true when all content blocks are thinking/redacted_thinking. */
export function isThinkingOnlyMessage(
  content: ReadonlyArray<{ type: string }>,
): boolean {
  if (content.length === 0) return false;
  return content.every(
    (block) => block.type === 'thinking' || block.type === 'redacted_thinking',
  );
}
