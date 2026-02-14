/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { TaskToolCall } from './TaskToolCall.js';

/**
 * TaskToolCall displays subagent/task tool execution.
 *
 * ## Features
 * - **Runtime mode**: Expandable to show detailed progress and nested tool calls
 * - **Replay mode**: Summary view with execution stats (no nested details)
 *
 * ## Data Sources
 * The component parses data from:
 * - `rawInput`: Task parameters (description, prompt, subagent_type)
 * - `rawOutput`: Task execution result (TaskResultDisplay format)
 *
 * ## Display Modes (Auto-detected)
 * - **Runtime mode**: Detected when `toolCalls` array has items. Shows "Show details" button.
 * - **Replay mode**: Detected when `toolCalls` is empty or missing. Shows summary only.
 *
 * ## Expanded View
 * When expanded (runtime only), shows:
 * - Detailed execution stats (rounds, duration, tokens, success rate)
 * - Nested tool calls list with status indicators
 * - Task result output
 */
const meta: Meta<typeof TaskToolCall> = {
  title: 'ToolCalls/TaskToolCall',
  component: TaskToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    isFirst: {
      control: 'boolean',
      description: 'Whether this is the first item in an AI sequence',
    },
    isLast: {
      control: 'boolean',
      description: 'Whether this is the last item in an AI sequence',
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Helper to create TaskResultDisplay
 */
const createTaskResultDisplay = (
  overrides: Partial<
    Parameters<typeof TaskToolCall>[0]['toolCall']['rawOutput']
  > = {},
) => ({
  type: 'task_execution' as const,
  subagentName: 'code-reviewer',
  taskDescription: 'Review authentication logic',
  taskPrompt: 'Please review the auth.ts file for security issues',
  status: 'completed' as const,
  terminateReason: 'GOAL',
  result: 'Review complete: Found 2 potential security issues...',
  executionSummary: {
    rounds: 3,
    totalDurationMs: 15420,
    totalToolCalls: 5,
    successfulToolCalls: 5,
    failedToolCalls: 0,
    successRate: 100,
    inputTokens: 2450,
    outputTokens: 890,
    thoughtTokens: 120,
    cachedTokens: 0,
    totalTokens: 3460,
    estimatedCost: 0.00012,
  },
  toolCalls: [
    {
      callId: 'call-1',
      name: 'read_file',
      status: 'success' as const,
      description: 'Reading auth.ts',
      args: { path: 'src/auth.ts' },
    },
    {
      callId: 'call-2',
      name: 'read_file',
      status: 'success' as const,
      description: 'Reading utils.ts',
      args: { path: 'src/utils.ts' },
    },
    {
      callId: 'call-3',
      name: 'grep_search',
      status: 'success' as const,
      description: 'Searching for password patterns',
      args: { pattern: 'password|secret|token' },
    },
  ],
  ...overrides,
});

/**
 * Base tool call data template
 */
const baseToolCall = {
  toolCallId: 'task-1',
  kind: 'task',
  title: 'code-reviewer: Review authentication logic',
  status: 'completed' as const,
  rawInput: {
    description: 'Review authentication logic',
    prompt: 'Please review the auth.ts file for security issues',
    subagent_type: 'code-reviewer',
  },
};

// ==================== Replay Mode Stories ====================

/**
 * Replay mode - summary view of completed task
 * This is what users see when loading a saved session (toolCalls is empty)
 */
export const ReplayCompleted: Story = {
  args: {
    toolCall: {
      ...baseToolCall,
      rawOutput: createTaskResultDisplay({
        toolCalls: [], // Empty array = replay mode
      }),
    },
    isFirst: true,
    isLast: false,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Replay mode (auto-detected when toolCalls is empty). Shows a summary of the task execution. Users cannot expand to see nested tool call details.',
      },
    },
  },
};

/**
 * Replay mode - failed task
 */
export const ReplayFailed: Story = {
  args: {
    toolCall: {
      ...baseToolCall,
      status: 'failed',
      rawOutput: createTaskResultDisplay({
        status: 'failed',
        terminateReason: 'Error parsing file',
        result: undefined,
        toolCalls: [], // Empty array = replay mode
        executionSummary: {
          rounds: 1,
          totalDurationMs: 3200,
          totalToolCalls: 1,
          successfulToolCalls: 0,
          failedToolCalls: 1,
          successRate: 0,
          inputTokens: 450,
          outputTokens: 120,
          totalTokens: 570,
        },
      }),
    },
    isFirst: true,
    isLast: false,
  },
};

/**
 * Replay mode - task without summary (legacy data)
 */
export const ReplayNoSummary: Story = {
  args: {
    toolCall: {
      ...baseToolCall,
      rawOutput: undefined, // No result data = simple display
    },
    isFirst: true,
    isLast: false,
  },
};

// ==================== Runtime Mode Stories ====================

/**
 * Runtime mode - collapsed (default state)
 * Non-empty toolCalls array enables runtime mode and "Show details" button
 */
export const RuntimeCollapsed: Story = {
  args: {
    toolCall: {
      ...baseToolCall,
      rawOutput: createTaskResultDisplay({
        // Non-empty toolCalls = runtime mode
        toolCalls: [
          {
            callId: 'call-1',
            name: 'read_file',
            status: 'success' as const,
            description: 'Reading auth.ts',
            args: { path: 'src/auth.ts' },
          },
        ],
      }),
    },
    isFirst: true,
    isLast: false,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Runtime mode (auto-detected when toolCalls has items). Shows "Show details" button to expand and view nested tool calls.',
      },
    },
  },
};

/**
 * Runtime mode - running task (in progress)
 */
export const RuntimeRunning: Story = {
  args: {
    toolCall: {
      ...baseToolCall,
      status: 'in_progress',
      rawOutput: createTaskResultDisplay({
        status: 'running',
        result: undefined,
        toolCalls: [
          {
            callId: 'call-1',
            name: 'read_file',
            status: 'success' as const,
            description: 'Reading config.ts',
          },
          {
            callId: 'call-2',
            name: 'glob',
            status: 'executing' as const,
            description: 'Finding test files',
          },
        ],
        executionSummary: {
          rounds: 2,
          totalDurationMs: 8500,
          totalToolCalls: 3,
          successfulToolCalls: 3,
          failedToolCalls: 0,
          successRate: 100,
          inputTokens: 1200,
          outputTokens: 450,
          totalTokens: 1650,
        },
      }),
    },
    isFirst: true,
    isLast: false,
  },
};

/**
 * Runtime mode - with tool calls awaiting approval
 */
export const RuntimeWithApprovalPending: Story = {
  args: {
    toolCall: {
      ...baseToolCall,
      status: 'in_progress',
      rawOutput: createTaskResultDisplay({
        status: 'running',
        toolCalls: [
          {
            callId: 'call-1',
            name: 'read_file',
            status: 'success' as const,
            description: 'Reading config.ts',
          },
          {
            callId: 'call-2',
            name: 'edit_file',
            status: 'awaiting_approval' as const,
            description: 'Editing auth.ts',
            args: { path: 'src/auth.ts' },
          },
        ],
        executionSummary: {
          rounds: 2,
          totalDurationMs: 5200,
          totalToolCalls: 2,
          successfulToolCalls: 1,
          failedToolCalls: 0,
          successRate: 50,
          inputTokens: 800,
          outputTokens: 300,
          totalTokens: 1100,
        },
      }),
    },
    isFirst: true,
    isLast: false,
  },
};

/**
 * Runtime mode - many nested tool calls
 */
export const RuntimeManyToolCalls: Story = {
  args: {
    toolCall: {
      ...baseToolCall,
      rawOutput: createTaskResultDisplay({
        toolCalls: Array.from({ length: 10 }, (_, i) => ({
          callId: `call-${i}`,
          name: i % 2 === 0 ? 'read_file' : 'glob',
          status: (i === 7 ? 'failed' : 'success') as const,
          description: `Operation ${i + 1}`,
          args: { pattern: `**/*.${i % 2 === 0 ? 'ts' : 'js'}` },
          error: i === 7 ? 'File not found' : undefined,
        })),
        executionSummary: {
          rounds: 5,
          totalDurationMs: 45200,
          totalToolCalls: 10,
          successfulToolCalls: 9,
          failedToolCalls: 1,
          successRate: 90,
          inputTokens: 8500,
          outputTokens: 3200,
          totalTokens: 11700,
        },
      }),
    },
    isFirst: true,
    isLast: false,
  },
};

/**
 * Different subagent types (replay mode - summary view)
 */
export const SubagentTypes: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <TaskToolCall
        toolCall={{
          ...baseToolCall,
          title: 'code-reviewer: Review code',
          rawInput: {
            subagent_type: 'code-reviewer',
            description: 'Review code',
          },
          rawOutput: createTaskResultDisplay({
            subagentName: 'code-reviewer',
            toolCalls: [], // Replay mode
          }),
        }}
      />
      <TaskToolCall
        toolCall={{
          ...baseToolCall,
          title: 'test-writer: Write tests',
          rawInput: {
            subagent_type: 'test-writer',
            description: 'Write tests',
          },
          rawOutput: createTaskResultDisplay({
            subagentName: 'test-writer',
            toolCalls: [], // Replay mode
          }),
        }}
      />
      <TaskToolCall
        toolCall={{
          ...baseToolCall,
          title: 'doc-writer: Write documentation',
          rawInput: { subagent_type: 'doc-writer', description: 'Write docs' },
          rawOutput: createTaskResultDisplay({
            subagentName: 'doc-writer',
            toolCalls: [], // Replay mode
          }),
        }}
      />
      <TaskToolCall
        toolCall={{
          ...baseToolCall,
          title: 'debugger: Debug issue',
          rawInput: { subagent_type: 'debugger', description: 'Debug issue' },
          rawOutput: createTaskResultDisplay({
            subagentName: 'debugger',
            toolCalls: [], // Replay mode
          }),
        }}
      />
    </div>
  ),
};

/**
 * Long task description (replay mode)
 */
export const LongDescription: Story = {
  args: {
    toolCall: {
      ...baseToolCall,
      title:
        'Complex multi-step task with a very long description that might wrap',
      rawInput: {
        description:
          'This is a very long task description that explains in great detail what the subagent needs to do, including multiple steps, constraints, and expected outcomes',
        prompt: 'Please do something complex',
        subagent_type: 'general-purpose',
      },
      rawOutput: createTaskResultDisplay({
        subagentName: 'general-purpose',
        taskDescription:
          'This is a very long task description that explains in great detail what the subagent needs to do, including multiple steps, constraints, and expected outcomes',
        toolCalls: [], // Replay mode
      }),
    },
    isFirst: true,
    isLast: false,
  },
};

/**
 * Minimal task (missing optional fields)
 */
export const MinimalTask: Story = {
  args: {
    toolCall: {
      toolCallId: 'task-minimal',
      kind: 'task',
      title: '',
      status: 'in_progress' as const,
      rawInput: {
        description: 'Simple task',
      },
      // No rawOutput = minimal display
    },
    isFirst: true,
    isLast: false,
  },
};
