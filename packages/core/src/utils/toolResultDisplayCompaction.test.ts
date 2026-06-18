/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentResultDisplay,
  AnsiOutputDisplay,
  FileDiff,
  McpToolProgressData,
  PlanResultDisplay,
  TaskListResultDisplay,
  TeamResultDisplay,
  TodoResultDisplay,
} from '../tools/tools.js';
import {
  compactStringForHistory,
  compactStringForRecording,
  compactToolResultDisplayForHistory,
  compactToolResultDisplayForRecording,
  MAX_RETAINED_AGENT_FIELD_CHARS,
  MAX_RETAINED_ANSI_OUTPUT_LINES,
  MAX_RETAINED_FILE_CONTENT_CHARS,
  MAX_RETAINED_FILE_DIFF_CHARS,
  MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
} from './toolResultDisplayCompaction.js';

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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

  it('uses saved session wording when compacting recording strings', () => {
    const value = `start-${'x'.repeat(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    )}-end`;

    const compacted = compactStringForRecording(value);

    expect(compacted).toContain('truncated for saved session preview');
    expect(compacted).toContain(`original length: ${value.length} characters`);
    expect(compacted).not.toContain('CLI history display');
  });

  it('preserves unmatched surrogate code units when compacting', () => {
    const value = `start-\uD800-${'x'.repeat(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    )}-end`;

    const compacted = compactStringForHistory(value);

    expect(compacted).toContain('\uD800');
    expect(compacted).not.toContain('\uFFFD');
  });

  it('does not split surrogate pairs at compaction boundaries', () => {
    const limit = 80;
    const emoji = '😀';
    // With this length and limit, the raw head/tail cuts land inside each emoji.
    const value = `${'h'.repeat(8)}${emoji}${'m'.repeat(
      183,
    )}${emoji}${'t'.repeat(5)}`;

    const compacted = compactStringForHistory(value, limit);

    expect(compacted.length).toBeLessThanOrEqual(limit);
    expect(hasUnpairedSurrogate(compacted)).toBe(false);
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

  it('compacts file diffs through the history display path', () => {
    const display: FileDiff = {
      fileName: 'large.txt',
      fileDiff: `diff-${'d'.repeat(MAX_RETAINED_FILE_DIFF_CHARS)}-done`,
      originalContent: `old-${'o'.repeat(
        MAX_RETAINED_FILE_CONTENT_CHARS,
      )}-done`,
      newContent: `new-${'n'.repeat(MAX_RETAINED_FILE_CONTENT_CHARS)}-done`,
      diffStat: {
        model_added_lines: 1,
        model_removed_lines: 1,
        model_added_chars: 1,
        model_removed_chars: 1,
        user_added_lines: 0,
        user_removed_lines: 0,
        user_added_chars: 0,
        user_removed_chars: 0,
      },
    };

    const compacted = compactToolResultDisplayForHistory(display);

    expect(compacted).not.toBe(display);
    expect(compacted.fileDiff.length).toBeLessThanOrEqual(
      MAX_RETAINED_FILE_DIFF_CHARS,
    );
    expect(compacted.originalContent?.length).toBeLessThanOrEqual(
      MAX_RETAINED_FILE_CONTENT_CHARS,
    );
    expect(compacted.newContent.length).toBeLessThanOrEqual(
      MAX_RETAINED_FILE_CONTENT_CHARS,
    );
    expect(compacted.truncatedForSession).toBe(true);
    expect(compacted.fileDiffLength).toBe(display.fileDiff.length);
    expect(compacted.originalContentLength).toBe(
      display.originalContent?.length,
    );
    expect(compacted.newContentLength).toBe(display.newContent.length);
    expect(compacted.fileDiffTruncated).toBe(true);
    expect(compacted.originalContentTruncated).toBe(true);
    expect(compacted.newContentTruncated).toBe(true);
    expect(display.truncatedForSession).toBeUndefined();
  });

  it('preserves null original content when compacting file diffs', () => {
    const display: FileDiff = {
      fileName: 'new.txt',
      fileDiff: 'new file',
      originalContent: null,
      newContent: `new-${'n'.repeat(MAX_RETAINED_FILE_CONTENT_CHARS)}-done`,
      diffStat: {
        model_added_lines: 1,
        model_removed_lines: 0,
        model_added_chars: 1,
        model_removed_chars: 0,
        user_added_lines: 0,
        user_removed_lines: 0,
        user_added_chars: 0,
        user_removed_chars: 0,
      },
    };

    const compacted = compactToolResultDisplayForHistory(display);

    expect(compacted.originalContent).toBeNull();
    expect(compacted.originalContentLength).toBe(0);
    expect(compacted.originalContentTruncated).toBe(false);
    expect(compacted.newContentTruncated).toBe(true);
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

  it('keeps unchanged ansi output displays by reference', () => {
    const display: AnsiOutputDisplay = {
      totalLines: 1,
      ansiOutput: [
        [
          {
            text: 'short',
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

    expect(compactToolResultDisplayForRecording(display)).toBe(display);
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

  it('uses saved session wording when compacting recording ansi output', () => {
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

    const compacted = compactToolResultDisplayForRecording(display);

    expect(compacted.ansiOutput[0][0].text).toContain(
      'terminal lines omitted from saved session preview',
    );
    expect(compacted.ansiOutput[0][0].text).not.toContain(
      'CLI history display',
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
