/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeSessionEventQueue,
  enqueueSubagentSdkEvent,
  type QueryEvent,
} from '@qwen-code/core';
import {
  drainBackgroundSubagentEvents,
  isBackgroundAgentTask,
  isBackgroundSubagentEvent,
  type BackgroundSubagentTaskIdentity,
} from './backgroundSubagentEvents.js';

const SESSION_ID = 'session-background-subagent';
const IDENTITY: BackgroundSubagentTaskIdentity = {
  taskIds: new Set(['task-1']),
  toolUseIds: new Set(['toolu-parent']),
};

function assistantEvent(
  uuid: string,
  parentToolUseId: string | null,
): QueryEvent {
  return {
    type: 'assistant',
    uuid,
    sessionId: SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `toolu-${uuid}`, name: 'Read', input: {} },
      ],
    },
  } as unknown as QueryEvent;
}

function userEvent(uuid: string, parentToolUseId: string): QueryEvent {
  return {
    type: 'user',
    uuid,
    sessionId: SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu-result', content: 'ok' },
      ],
    },
  } as unknown as QueryEvent;
}

function systemEvent(
  uuid: string,
  subtype: string,
  taskId?: string,
  toolUseId?: string,
): QueryEvent {
  return {
    type: 'system',
    subtype,
    content: '',
    level: 'info',
    uuid,
    sessionId: SESSION_ID,
    ...(taskId ? { task_id: taskId } : {}),
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
  } as unknown as QueryEvent;
}

afterEach(() => {
  disposeSessionEventQueue(SESSION_ID);
});

describe('background subagent event filter', () => {
  it('只取后台任务自己的正文与进度，task_started 留给 engine', () => {
    const assistantBackground = assistantEvent('assistant-bg', 'toolu-parent');
    const streamBackground = {
      type: 'stream_event',
      event: { marker: 'stream-bg' },
      parent_tool_use_id: 'toolu-parent',
      session_id: SESSION_ID,
    } as unknown as QueryEvent;
    const userBackground = userEvent('user-bg', 'toolu-parent');
    const progressBackground = systemEvent(
      'progress-bg',
      'task_progress',
      'task-1',
      'toolu-parent',
    );
    const progressOther = systemEvent(
      'progress-other',
      'task_progress',
      'task-other',
      'toolu-other',
    );
    const startedBackground = systemEvent(
      'started-bg',
      'task_started',
      'task-1',
      'toolu-parent',
    );
    const assistantForeground = assistantEvent(
      'assistant-foreground',
      'toolu-foreground',
    );

    for (const event of [
      assistantBackground,
      streamBackground,
      userBackground,
      progressBackground,
      progressOther,
      startedBackground,
      assistantForeground,
    ]) {
      enqueueSubagentSdkEvent(SESSION_ID, event);
    }

    expect(
      drainBackgroundSubagentEvents(SESSION_ID, IDENTITY),
    ).toEqual([
      assistantBackground,
      streamBackground,
      userBackground,
      progressBackground,
    ]);
    expect(drainBackgroundSubagentEvents(SESSION_ID, IDENTITY)).toEqual([]);
  });

  it('background_tasks_changed 只在存在后台任务身份时补投', () => {
    const changed = systemEvent('changed', 'background_tasks_changed');

    expect(
      isBackgroundSubagentEvent(changed, {
        taskIds: new Set(),
        toolUseIds: new Set(),
      }),
    ).toBe(false);
    expect(isBackgroundSubagentEvent(changed, IDENTITY)).toBe(true);
  });
});

describe('background agent task guard', () => {
  it('只接受仍在后台运行的 Agent 任务', () => {
    expect(
      isBackgroundAgentTask({
        type: 'local_agent',
        isBackgrounded: true,
      }),
    ).toBe(true);
    expect(
      isBackgroundAgentTask({
        type: 'in_process_teammate',
        isBackgrounded: true,
      }),
    ).toBe(true);
    expect(
      isBackgroundAgentTask({
        type: 'local_agent',
        isBackgrounded: false,
      }),
    ).toBe(false);
    expect(
      isBackgroundAgentTask({
        type: 'local_bash',
        isBackgrounded: true,
      }),
    ).toBe(false);
  });
});
