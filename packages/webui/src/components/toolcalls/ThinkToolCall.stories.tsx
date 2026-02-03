/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ThinkToolCall } from './ThinkToolCall.js';

/**
 * ThinkToolCall displays AI reasoning and thought processes.
 * Shows thoughts in compact or card format based on content length.
 */
const meta: Meta<typeof ThinkToolCall> = {
  title: 'ToolCalls/ThinkToolCall',
  component: ThinkToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ShortThought: Story = {
  args: {
    toolCall: {
      toolCallId: 'think-1',
      kind: 'think',
      title: 'Thinking',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'User wants to refactor the auth module.',
          },
        },
      ],
    },
  },
};

export const LongThought: Story = {
  args: {
    toolCall: {
      toolCallId: 'think-2',
      kind: 'think',
      title: 'Thinking',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'The user is asking about implementing a new authentication system. I need to consider several factors: 1) The current codebase uses JWT tokens for authentication. 2) They want to add OAuth2 support. 3) The existing user model needs to be extended. 4) We should maintain backward compatibility with the current API. Let me analyze the best approach for this refactoring task.',
          },
        },
      ],
    },
  },
};

export const Loading: Story = {
  args: {
    toolCall: {
      toolCallId: 'think-3',
      kind: 'think',
      title: 'Thinking',
      status: 'in_progress',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'Analyzing the codebase...' },
        },
      ],
    },
  },
};

export const WithError: Story = {
  args: {
    toolCall: {
      toolCallId: 'think-4',
      kind: 'think',
      title: 'Thinking',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'error', error: 'Memory save failed' },
        },
      ],
    },
  },
};
