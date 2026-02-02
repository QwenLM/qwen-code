/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { GenericToolCall } from './GenericToolCall.js';

/**
 * GenericToolCall is a fallback component for displaying any tool call type.
 * Used when no specialized component exists for a particular tool kind.
 */
const meta: Meta<typeof GenericToolCall> = {
  title: 'ToolCalls/GenericToolCall',
  component: GenericToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const TaskSuccess: Story = {
  args: {
    toolCall: {
      toolCallId: 'generic-1',
      kind: 'task',
      title: 'Running background task',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'Task completed successfully' },
        },
      ],
    },
  },
};

export const WebFetch: Story = {
  args: {
    toolCall: {
      toolCallId: 'generic-2',
      kind: 'web_fetch',
      title: 'Fetching https://api.example.com/data',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'Retrieved 1.2KB of data' },
        },
      ],
    },
  },
};

export const WithError: Story = {
  args: {
    toolCall: {
      toolCallId: 'generic-3',
      kind: 'web_search',
      title: 'Searching for "react hooks"',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'error', error: 'Network timeout' },
        },
      ],
    },
  },
};

export const Loading: Story = {
  args: {
    toolCall: {
      toolCallId: 'generic-4',
      kind: 'task',
      title: 'Processing files...',
      status: 'in_progress',
      content: [],
    },
  },
};

export const WithLocations: Story = {
  args: {
    toolCall: {
      toolCallId: 'generic-5',
      kind: 'task',
      title: 'Found matching files',
      status: 'completed',
      locations: [
        { path: 'src/App.tsx', line: 10 },
        { path: 'src/utils/helpers.ts', line: 25 },
      ],
    },
  },
};
