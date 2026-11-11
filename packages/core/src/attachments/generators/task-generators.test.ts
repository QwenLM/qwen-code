/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  Message,
  ContentBlock,
} from '../../protocol/transcript/message.js';
import { cloneUsage } from '../../protocol/provider/empty-usage.js';
import type { TaskListStatus } from '../../tasks/task-list-types.js';
import {
  TASK_CREATE_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
} from '../../tools/tool-names.js';
import { getTaskReminderAttachments } from './task-generators.js';

function assistantMessage(content: ContentBlock[]): Message {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: crypto.randomUUID(),

      content,

      model: 'test-model',
      stop_reason: null,

      usage: cloneUsage(),
    },
  };
}

function taskMutation(name: string): Message {
  return assistantMessage([
    {
      type: 'tool_use',
      id: crypto.randomUUID(),
      name,
      input: {},
    },
  ]);
}

function idleAssistantTurns(count: number): Message[] {
  return Array.from({ length: count }, (_, index) =>
    assistantMessage([{ type: 'text', text: `turn ${index}` }]),
  );
}

describe('getTaskReminderAttachments', () => {
  const taskStore = {
    listTasks: vi.fn().mockResolvedValue([
      {
        id: '1',
        subject: 'Visible task',
        description: 'details',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      },
      {
        id: '2',
        subject: 'Internal task',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        metadata: { _internal: true },
      },
    ]),
  };

  it.each([TASK_CREATE_TOOL_NAME, TASK_UPDATE_TOOL_NAME])(
    'waits ten assistant turns after %s',
    async (toolName) => {
      expect(
        await getTaskReminderAttachments(
          [taskMutation(toolName), ...idleAssistantTurns(9)],
          taskStore,
          true,
        ),
      ).toEqual([]);

      expect(
        await getTaskReminderAttachments(
          [taskMutation(toolName), ...idleAssistantTurns(10)],
          taskStore,
          true,
        ),
      ).toEqual([
        {
          type: 'task_reminder',
          itemCount: 2,
          content: [
            {
              id: '1',
              subject: 'Visible task',
              description: 'details',
              status: 'pending',
              blocks: [],
              blockedBy: [],
            },
            {
              id: '2',
              subject: 'Internal task',
              description: '',
              status: 'pending',
              blocks: [],
              blockedBy: [],
              metadata: { _internal: true },
            },
          ],
        },
      ]);
    },
  );

  it('does not emit for empty history', async () => {
    expect(await getTaskReminderAttachments([], taskStore, true)).toEqual([]);
  });

  it.each([
    { statuses: [], expected: 0 },
    { statuses: ['completed', 'completed'], expected: 0 },
    { statuses: ['completed', 'pending'], expected: 1 },
    { statuses: ['completed', 'in_progress'], expected: 1 },
  ] satisfies Array<{ statuses: TaskListStatus[]; expected: number }>)(
    'emits $expected reminders for task statuses $statuses',
    async ({ statuses, expected }) => {
      const listTasks = vi.fn().mockResolvedValue(
        statuses.map((status, index) => ({
          id: String(index + 1),
          subject: `Task ${index + 1}`,
          description: '',
          status,
          blocks: [],
          blockedBy: [],
        })),
      );

      expect(
        await getTaskReminderAttachments(
          idleAssistantTurns(10),
          { listTasks },
          true,
        ),
      ).toHaveLength(expected);
    },
  );

  it('preserves reminder throttling after transcript restoration', async () => {
    const restoredReminder = {
      type: 'attachment',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      attachment: {
        type: 'task_reminder',
        content: [],
        itemCount: 0,
      },
    } as Message;

    expect(
      await getTaskReminderAttachments(
        [restoredReminder, ...idleAssistantTurns(9)],
        taskStore,
        true,
      ),
    ).toEqual([]);
    expect(
      await getTaskReminderAttachments(
        [restoredReminder, ...idleAssistantTurns(10)],
        taskStore,
        true,
      ),
    ).toHaveLength(1);
  });

  it('restarts the ten-turn window from compacted history', async () => {
    const compactSummary = {
      type: 'user',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'compact summary' },
      isCompactSummary: true,
    } as Message;

    expect(
      await getTaskReminderAttachments(
        [compactSummary, ...idleAssistantTurns(9)],
        taskStore,
        true,
      ),
    ).toEqual([]);
    expect(
      await getTaskReminderAttachments(
        [compactSummary, ...idleAssistantTurns(10)],
        taskStore,
        true,
      ),
    ).toHaveLength(1);
  });

  it('does not emit when the task store is unavailable', async () => {
    expect(
      await getTaskReminderAttachments(idleAssistantTurns(10), undefined, true),
    ).toEqual([]);
  });

  it('does not emit when TaskUpdate is unavailable', async () => {
    expect(
      await getTaskReminderAttachments(
        idleAssistantTurns(10),
        taskStore,
        false,
      ),
    ).toEqual([]);
  });
});
