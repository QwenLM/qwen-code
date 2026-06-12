/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentResultDisplay,
  AnsiOutputDisplay,
  McpToolProgressData,
  PlanResultDisplay,
  TaskListResultDisplay,
  TeamResultDisplay,
  TodoResultDisplay,
} from '../tools/tools.js';
import {
  compactStringForHistory,
  compactToolResultDisplayForHistory,
  MAX_RETAINED_AGENT_FIELD_CHARS,
  MAX_RETAINED_ANSI_OUTPUT_LINES,
  MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
} from './toolResultDisplayCompaction.js';

describe('toolResultDisplayCompaction', () => {
  it('keeps short strings unchanged', () => {
    const value = 'short output';

    expect(compactStringForHistory(value)).toBe(value);
  });

  it('keeps head and tail when compacting long strings', () => {
    const value = `start-${'x'.repeat(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    )}-end`;

    const compacted = compactStringForHistory(value);

    expect(compacted.length).toBeLessThanOrEqual(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    );
    expect(compacted).toContain('start-');
    expect(compacted).toContain('-end');
    expect(compacted).toContain('truncated from');
  });

  it('preserves unmatched surrogate code units when compacting', () => {
    const value = `start-\uD800-${'x'.repeat(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    )}-end`;

    const compacted = compactStringForHistory(value);

    expect(compacted).toContain('\uD800');
    expect(compacted).not.toContain('\uFFFD');
  });

  it('drops subagent display fields that are not rendered in CLI history', () => {
    const nestedDisplay = `nested-${'x'.repeat(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    )}-done`;
    const display: AgentResultDisplay = {
      type: 'task_execution',
      subagentName: 'researcher',
      taskDescription: 'research',
      taskPrompt: 'p'.repeat(MAX_RETAINED_AGENT_FIELD_CHARS + 100),
      status: 'completed',
      toolCalls: [
        {
          callId: 'call-1',
          name: 'read_file',
          status: 'success',
          args: { content: 'x'.repeat(100_000) },
          responseParts: [{ text: 'x'.repeat(100_000) }],
          result: 'x'.repeat(100_000),
        },
        {
          callId: 'call-2',
          name: 'agent',
          status: 'success',
          resultDisplay: nestedDisplay,
        },
      ],
    };

    const compacted = compactToolResultDisplayForHistory(display);

    expect(compacted.taskPrompt.length).toBeLessThanOrEqual(
      MAX_RETAINED_AGENT_FIELD_CHARS,
    );
    expect(compacted.toolCalls?.[0]).not.toHaveProperty('args');
    expect(compacted.toolCalls?.[0]).not.toHaveProperty('responseParts');
    expect(compacted.toolCalls?.[0]).not.toHaveProperty('result');
    expect(compacted.toolCalls?.[1].resultDisplay).toContain('nested-');
    expect(compacted.toolCalls?.[1].resultDisplay).toContain('-done');
    expect(compacted.toolCalls?.[1].resultDisplay).toContain('truncated from');
  });

  it('compacts ansi output tokens under the retained line limit', () => {
    const display: AnsiOutputDisplay = {
      totalLines: 1,
      ansiOutput: [
        [
          {
            text: `line-${'x'.repeat(
              MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
            )}-done`,
            bold: false,
            italic: false,
            underline: false,
            dim: false,
            inverse: false,
            fg: '',
            bg: '',
          },
        ],
      ],
    };

    const compacted = compactToolResultDisplayForHistory(display);

    expect(compacted.ansiOutput).toHaveLength(1);
    expect(compacted.totalLines).toBe(1);
    expect(compacted.ansiOutput[0][0].text).toContain('line-');
    expect(compacted.ansiOutput[0][0].text).toContain('-done');
    expect(compacted.ansiOutput[0][0].text).toContain('truncated from');
  });

  it('bounds long ansi output and keeps the tail lines', () => {
    const display: AnsiOutputDisplay = {
      ansiOutput: Array.from(
        { length: MAX_RETAINED_ANSI_OUTPUT_LINES + 5 },
        (_, index) => [
          {
            text: `line-${index}`,
            bold: false,
            italic: false,
            underline: false,
            dim: false,
            inverse: false,
            fg: '',
            bg: '',
          },
        ],
      ),
    };

    const compacted = compactToolResultDisplayForHistory(display);

    expect(compacted.ansiOutput).toHaveLength(MAX_RETAINED_ANSI_OUTPUT_LINES);
    expect(compacted.ansiOutput[0][0].text).toContain('terminal lines omitted');
    expect(compacted.ansiOutput.at(-1)?.[0].text).toBe(
      `line-${MAX_RETAINED_ANSI_OUTPUT_LINES + 4}`,
    );
  });

  it('compacts todo, plan, and MCP progress displays', () => {
    const todoDisplay: TodoResultDisplay = {
      type: 'todo_list',
      todos: [
        {
          id: '1',
          status: 'pending',
          content: `todo-${'x'.repeat(MAX_RETAINED_AGENT_FIELD_CHARS)}-done`,
        },
      ],
    };
    const planDisplay: PlanResultDisplay = {
      type: 'plan_summary',
      message: `message-${'x'.repeat(MAX_RETAINED_AGENT_FIELD_CHARS)}-done`,
      plan: `plan-${'x'.repeat(MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS)}-done`,
    };
    const progressDisplay: McpToolProgressData = {
      type: 'mcp_tool_progress',
      progress: 1,
      message: `progress-${'x'.repeat(MAX_RETAINED_AGENT_FIELD_CHARS)}-done`,
    };

    const compactedTodo = compactToolResultDisplayForHistory(todoDisplay);
    const compactedPlan = compactToolResultDisplayForHistory(planDisplay);
    const compactedProgress =
      compactToolResultDisplayForHistory(progressDisplay);

    expect(compactedTodo.todos[0].content).toContain('truncated from');
    expect(compactedPlan.message).toContain('truncated from');
    expect(compactedPlan.plan).toContain('truncated from');
    expect(compactedProgress.message).toContain('truncated from');
  });

  it('compacts task list and team result displays', () => {
    const taskDisplay: TaskListResultDisplay = {
      type: 'task_list',
      tasks: [
        {
          id: '1',
          status: 'pending',
          subject: `task-${'x'.repeat(MAX_RETAINED_AGENT_FIELD_CHARS)}-done`,
          owner: `owner-${'x'.repeat(MAX_RETAINED_AGENT_FIELD_CHARS)}-done`,
        },
      ],
    };
    const teamDisplay: TeamResultDisplay = {
      type: 'team_result',
      action: 'created',
      teamName: `team-${'x'.repeat(MAX_RETAINED_AGENT_FIELD_CHARS)}-done`,
    };

    const compactedTask = compactToolResultDisplayForHistory(taskDisplay);
    const compactedTeam = compactToolResultDisplayForHistory(teamDisplay);

    expect(compactedTask.tasks[0].subject).toContain('truncated from');
    expect(compactedTask.tasks[0].owner).toContain('truncated from');
    expect(compactedTeam.teamName).toContain('truncated from');
  });
});
