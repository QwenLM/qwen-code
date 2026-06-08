/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonPromptStatus,
  DaemonTodoItem,
  DaemonTodoList,
} from './types.js';

export type DaemonStreamingState =
  | 'idle'
  | 'waiting'
  | 'responding'
  | 'thinking';

export function selectDaemonPendingPermissions(
  blocks: readonly DaemonTranscriptBlock[],
): ReadonlyArray<Extract<DaemonTranscriptBlock, { kind: 'permission' }>> {
  return blocks.filter(
    (block): block is Extract<DaemonTranscriptBlock, { kind: 'permission' }> =>
      block.kind === 'permission' && block.resolved === undefined,
  );
}

export function selectDaemonTodoLists(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTodoList[] {
  return blocks.flatMap((block): DaemonTodoList[] => {
    if (block.kind !== 'tool') return [];
    const items = extractDaemonTodosFromToolBlock(block);
    if (!items || items.length === 0) return [];
    return [
      {
        blockId: block.id,
        toolCallId: block.toolCallId,
        title: block.title,
        status: block.status,
        items,
        raw: block,
      },
    ];
  });
}

export function selectDaemonLatestTodoList(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTodoList | undefined {
  return selectDaemonTodoLists(blocks).at(-1);
}

export function selectDaemonActiveTodoList(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonTodoList | undefined {
  const latest = selectDaemonLatestTodoList(blocks);
  // Only the latest list is considered active; earlier active items are stale
  // once a newer TodoWrite/plan snapshot has arrived.
  return latest && hasDaemonActiveTodos(latest.items) ? latest : undefined;
}

export function extractDaemonTodosFromToolBlock(
  block: DaemonToolTranscriptBlock,
): DaemonTodoItem[] | undefined {
  const toolName = (block.toolName ?? '').toLowerCase();
  const toolKind = (block.toolKind ?? '').toLowerCase();
  if (
    toolName !== 'todowrite' &&
    toolKind !== 'updated_plan' &&
    toolKind !== 'todo' &&
    toolKind !== 'other'
  ) {
    return undefined;
  }

  const rawInput = getRecord(block.rawInput);
  const inputTodos = getTodoArray(rawInput);
  if (inputTodos) return parseDaemonTodoItemsFromEntries(inputTodos);

  const rawOutput = getRecord(block.rawOutput);
  const outputTodos = getTodoArray(rawOutput);
  if (outputTodos) return parseDaemonTodoItemsFromEntries(outputTodos);

  const entries = Array.isArray(rawOutput?.['entries'])
    ? rawOutput['entries']
    : undefined;
  return entries ? parseDaemonTodoItemsFromEntries(entries) : undefined;
}

export function parseDaemonTodoItemsFromEntries(
  entries: readonly unknown[],
): DaemonTodoItem[] | undefined {
  const todos = entries.flatMap((entry, index): DaemonTodoItem[] => {
    const item = getRecord(entry);
    const content = getString(item, 'content');
    if (!content) return [];
    const id = getString(item, 'id') ?? `plan-${index}`;
    return [
      {
        id,
        content,
        status: getTodoStatus(getString(item, 'status')),
        ...(() => {
          const priority = getTodoPriority(getString(item, 'priority'));
          return priority ? { priority } : {};
        })(),
      },
    ];
  });
  return todos.length > 0 ? todos : undefined;
}

export function hasDaemonActiveTodos(
  items: readonly DaemonTodoItem[],
): boolean {
  return items.some(
    (item) => item.status === 'pending' || item.status === 'in_progress',
  );
}

export function isDaemonSubAgentToolBlock(
  block: DaemonToolTranscriptBlock,
): boolean {
  const toolName = (block.toolName ?? '').toLowerCase();
  if (toolName === 'agent' || toolName === 'task') return true;
  if (block.parentToolCallId || block.parentBlockId || block.subagentType) {
    return true;
  }
  if (isTaskExecutionRaw(block.rawOutput)) return true;
  const rawInput = getRecord(block.rawInput);
  return Boolean(getString(rawInput, 'subagent_type'));
}

export function selectDaemonSubAgentToolBlocks(
  blocks: readonly DaemonTranscriptBlock[],
): DaemonToolTranscriptBlock[] {
  return blocks.filter(
    (block): block is DaemonToolTranscriptBlock =>
      block.kind === 'tool' && isDaemonSubAgentToolBlock(block),
  );
}

export function selectDaemonTranscriptStreamingState(
  blocks: readonly DaemonTranscriptBlock[],
): Exclude<DaemonStreamingState, 'waiting'> {
  if (blocks.length === 0) return 'idle';

  const last = blocks[blocks.length - 1];
  if (last?.kind === 'thought' && isStreamingTextBlock(last)) {
    return 'thinking';
  }
  if (last?.kind === 'assistant' && isStreamingTextBlock(last)) {
    return 'responding';
  }
  if (last?.kind === 'tool' && isRunningToolBlock(last)) {
    return 'responding';
  }

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind === 'user') break;
    if (block.kind === 'tool' && isRunningToolBlock(block)) {
      return 'responding';
    }
  }

  return 'idle';
}

export function selectDaemonStreamingState(
  blocks: readonly DaemonTranscriptBlock[],
  promptStatus: DaemonPromptStatus = 'idle',
): DaemonStreamingState {
  const transcriptState = selectDaemonTranscriptStreamingState(blocks);
  if (promptStatus === 'idle' || transcriptState !== 'idle') {
    return transcriptState;
  }
  return promptStatus === 'waiting' ? 'waiting' : 'responding';
}

function isStreamingTextBlock(block: DaemonTextTranscriptBlock): boolean {
  return block.streaming === true;
}

function isRunningToolBlock(block: DaemonToolTranscriptBlock): boolean {
  return block.status === 'running' || block.status === 'in_progress';
}

function getTodoArray(
  record: Record<string, unknown> | undefined,
): readonly unknown[] | undefined {
  const todos = record?.['todos'];
  return Array.isArray(todos) ? todos : undefined;
}

function getTodoStatus(value: string | undefined): DaemonTodoItem['status'] {
  return value === 'completed' || value === 'in_progress' || value === 'pending'
    ? value
    : 'pending';
}

function getTodoPriority(
  value: string | undefined,
): DaemonTodoItem['priority'] | undefined {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : undefined;
}

function isTaskExecutionRaw(raw: unknown): boolean {
  const record = getRecord(raw);
  return record?.['type'] === 'task_execution';
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
