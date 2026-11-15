/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallableTool } from '@google/genai';
import {
  DiscoveredMCPTool,
  type McpDirectClient,
} from '@qwen-code/qwen-code-core/tools/mcp-tool.js';
import { describe, expect, it, vi } from 'vitest';
import { mapToDisplay } from '../hooks/useReactToolScheduler.js';
import type { TodoItem } from '../components/TodoDisplay.js';
import type { HistoryItem, HistoryItemToolGroup } from '../types.js';
import { getStickyTodos } from './todoSnapshot.js';

const todos: TodoItem[] = [
  { id: 'task-1', content: 'Run checks', status: 'in_progress' },
];

type ContentMode = 'structured only' | 'compatibility JSON text';

// This is a controlled MCP protocol result, not a captured third-party server
// response. The client boundary is stubbed; serialization, display mapping, and
// sticky-snapshot selection use their production implementations.
async function executeMcpSnapshot(
  mode: ContentMode,
  snapshotTodos: TodoItem[],
  unchanged = false,
): Promise<HistoryItemToolGroup> {
  const structuredContent = {
    type: 'todo_list',
    todos: snapshotTodos,
    ...(unchanged ? { unchanged: true } : {}),
  };
  const serialized = JSON.stringify(structuredContent);
  const client: McpDirectClient = {
    callTool: vi.fn(async () => ({
      content:
        mode === 'structured only'
          ? []
          : [{ type: 'text' as const, text: serialized }],
      structuredContent,
    })),
  };
  const callable: CallableTool = {
    tool: async () => ({ functionDeclarations: [] }),
    callTool: async () => {
      throw new Error('Expected the direct MCP client');
    },
  };
  const tool = new DiscoveredMCPTool(
    callable,
    'task-server',
    'tasks',
    'Return a task snapshot',
    { type: 'object', properties: {} },
    true,
    undefined,
    undefined,
    client,
  );
  const invocation = tool.build({});
  const result = await invocation.execute(new AbortController().signal);

  expect(client.callTool).toHaveBeenCalledOnce();
  expect(result.error).toBeUndefined();
  expect(result.returnDisplay).toBe(serialized);
  // Reproduce the scheduler's completed-call handoff of returnDisplay into
  // resultDisplay, then use the real UI mapper rather than constructing an
  // already-serialized history item. This does not run the full scheduler.
  const display = mapToDisplay({
    status: 'success',
    request: {
      callId: 'mcp-tasks',
      name: tool.name,
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    },
    tool,
    invocation,
    response: {
      callId: 'mcp-tasks',
      responseParts: [],
      resultDisplay: result.returnDisplay,
      error: undefined,
      errorType: undefined,
    },
  });
  expect(display.tools[0].resultDisplay).toBe(serialized);
  return display;
}

async function visibleHistory(mode: ContentMode): Promise<HistoryItem[]> {
  return [
    { ...(await executeMcpSnapshot(mode, todos)), id: 1 },
    { type: 'gemini', id: 2, text: 'Working on the task' },
    { type: 'gemini', id: 3, text: 'Checking the result' },
  ];
}

describe.each<ContentMode>(['structured only', 'compatibility JSON text'])(
  'MCP task snapshots with %s',
  (mode) => {
    it('keeps the visible task list for an unchanged pending result', async () => {
      const history = await visibleHistory(mode);
      expect(getStickyTodos(history, [])).toEqual(todos);

      const pending = await executeMcpSnapshot(mode, todos, true);
      expect(getStickyTodos(history, [pending])).toEqual(todos);
    });

    it('keeps the visible task list when an unchanged result commits', async () => {
      const history = await visibleHistory(mode);
      const unchanged = await executeMcpSnapshot(mode, todos, true);

      expect(getStickyTodos([...history, { ...unchanged, id: 4 }], [])).toEqual(
        todos,
      );
    });

    it('does not revive old tasks after a new user turn', async () => {
      const history = await visibleHistory(mode);
      const unchanged = await executeMcpSnapshot(mode, todos, true);

      expect(
        getStickyTodos(
          [
            ...history,
            { type: 'user', id: 4, text: 'A new question' },
            { ...unchanged, id: 5 },
            { type: 'gemini', id: 6, text: 'Answering the new question' },
            { type: 'gemini', id: 7, text: 'More details' },
          ],
          [],
        ),
      ).toBeNull();
    });

    it('still accepts a changed task snapshot', async () => {
      const history = await visibleHistory(mode);
      const nextTodos: TodoItem[] = [
        { id: 'task-2', content: 'Write the summary', status: 'pending' },
      ];
      const changed = await executeMcpSnapshot(mode, nextTodos);

      expect(getStickyTodos(history, [changed])).toBeNull();
      expect(
        getStickyTodos(
          [
            ...history,
            { ...changed, id: 4 },
            { type: 'gemini', id: 5, text: 'Preparing the summary' },
            { type: 'gemini', id: 6, text: 'Summary follows' },
          ],
          [],
        ),
      ).toEqual(nextTodos);
    });
  },
);
