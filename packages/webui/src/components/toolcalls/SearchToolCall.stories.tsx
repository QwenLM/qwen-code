/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { SearchToolCall } from './SearchToolCall.js';

/**
 * SearchToolCall displays search operations and results.
 */
const meta: Meta<typeof SearchToolCall> = {
  title: 'ToolCalls/SearchToolCall',
  component: SearchToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const GrepSingleResult: Story = {
  args: {
    toolCall: {
      toolCallId: 'search-1',
      kind: 'grep',
      title: 'useState',
      status: 'completed',
      locations: [{ path: 'src/App.tsx', line: 5 }],
    },
  },
};

export const GrepMultipleResults: Story = {
  args: {
    toolCall: {
      toolCallId: 'search-2',
      kind: 'grep',
      title: 'import React',
      status: 'completed',
      locations: [
        { path: 'src/App.tsx', line: 1 },
        { path: 'src/components/Header.tsx', line: 1 },
        { path: 'src/utils/hooks.ts', line: 3 },
      ],
    },
  },
};

export const GlobSearch: Story = {
  args: {
    toolCall: {
      toolCallId: 'search-3',
      kind: 'glob',
      title: '**/*.tsx',
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'Listed 4 item(s).' },
        },
      ],
    },
  },
};

export const WithError: Story = {
  args: {
    toolCall: {
      toolCallId: 'search-4',
      kind: 'grep',
      title: 'invalid[regex',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'error', error: 'Invalid regex pattern' },
        },
      ],
    },
  },
};
