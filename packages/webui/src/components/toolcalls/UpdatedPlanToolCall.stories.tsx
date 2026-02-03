/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { UpdatedPlanToolCall } from './UpdatedPlanToolCall.js';

/**
 * UpdatedPlanToolCall displays plan/todo list updates with checkboxes.
 */
const meta: Meta<typeof UpdatedPlanToolCall> = {
  title: 'ToolCalls/UpdatedPlanToolCall',
  component: UpdatedPlanToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const MixedStatus: Story = {
  args: {
    toolCall: {
      toolCallId: 'plan-1',
      kind: 'todo_write',
      title: 'TodoWrite',
      status: 'completed',
      content: [
        {
          type: 'entries',
          entries: [
            { content: 'Setup project structure', status: 'completed' },
            { content: 'Implement authentication', status: 'in_progress' },
            { content: 'Add unit tests', status: 'pending' },
            { content: 'Deploy to production', status: 'pending' },
          ],
        },
      ],
    },
  },
};

export const AllCompleted: Story = {
  args: {
    toolCall: {
      toolCallId: 'plan-2',
      kind: 'todo_write',
      title: 'TodoWrite',
      status: 'completed',
      content: [
        {
          type: 'entries',
          entries: [
            { content: 'Create component', status: 'completed' },
            { content: 'Add styles', status: 'completed' },
            { content: 'Write tests', status: 'completed' },
          ],
        },
      ],
    },
  },
};

export const AllPending: Story = {
  args: {
    toolCall: {
      toolCallId: 'plan-3',
      kind: 'todo_write',
      title: 'TodoWrite',
      status: 'completed',
      content: [
        {
          type: 'entries',
          entries: [
            { content: 'Research API options', status: 'pending' },
            { content: 'Design database schema', status: 'pending' },
            { content: 'Implement endpoints', status: 'pending' },
          ],
        },
      ],
    },
  },
};

export const WithError: Story = {
  args: {
    toolCall: {
      toolCallId: 'plan-4',
      kind: 'todo_write',
      title: 'TodoWrite',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'error', error: 'Failed to update plan' },
        },
      ],
    },
  },
};
