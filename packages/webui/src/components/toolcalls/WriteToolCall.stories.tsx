/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { WriteToolCall } from './WriteToolCall.js';

/**
 * WriteToolCall displays file writing operations with line counts.
 */
const meta: Meta<typeof WriteToolCall> = {
  title: 'ToolCalls/WriteToolCall',
  component: WriteToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {
  args: {
    toolCall: {
      toolCallId: 'write-1',
      kind: 'write',
      title: 'Write file',
      status: 'completed',
      rawInput: { content: 'line1\nline2\nline3\nline4\nline5' },
      locations: [{ path: 'src/new-file.ts' }],
    },
  },
};

export const WithError: Story = {
  args: {
    toolCall: {
      toolCallId: 'write-2',
      kind: 'write',
      title: 'Write file',
      status: 'failed',
      rawInput: { content: 'const x = 1;' },
      content: [
        {
          type: 'content',
          content: { type: 'error', error: 'Permission denied' },
        },
      ],
      locations: [{ path: '/etc/config.ts' }],
    },
  },
};

export const Loading: Story = {
  args: {
    toolCall: {
      toolCallId: 'write-3',
      kind: 'write',
      title: 'Write file',
      status: 'in_progress',
      rawInput: { content: 'writing...' },
      locations: [{ path: 'src/output.ts' }],
    },
  },
};
