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
          type: 'content',
          content: {
            type: 'text',
            text: '- [x] Setup project structure\n- [-] Implement authentication\n- [ ] Add unit tests\n- [ ] Deploy to production',
          },
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
          type: 'content',
          content: {
            type: 'text',
            text: '- [x] Create component\n- [x] Add styles\n- [x] Write tests',
          },
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
          type: 'content',
          content: {
            type: 'text',
            text: '- [ ] Research API options\n- [ ] Design database schema\n- [ ] Implement endpoints',
          },
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
