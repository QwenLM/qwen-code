/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { EditToolCall } from './EditToolCall.js';

/**
 * EditToolCall displays file editing operations with diff summaries.
 */
const meta: Meta<typeof EditToolCall> = {
  title: 'ToolCalls/EditToolCall',
  component: EditToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const WithDiff: Story = {
  args: {
    toolCall: {
      toolCallId: 'edit-1',
      kind: 'edit',
      title: 'Edit file',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: 'src/components/App.tsx',
          oldText: 'const App = () => {\n  return <div>Hello</div>;\n};',
          newText:
            'const App = () => {\n  return (\n    <div>\n      <h1>Hello World</h1>\n    </div>\n  );\n};',
        },
      ],
    },
  },
};

export const WithError: Story = {
  args: {
    toolCall: {
      toolCallId: 'edit-2',
      kind: 'edit',
      title: 'Edit file',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'error', error: 'File not found' },
        },
      ],
      locations: [{ path: 'src/missing.ts' }],
    },
  },
};

export const WithLocation: Story = {
  args: {
    toolCall: {
      toolCallId: 'edit-3',
      kind: 'edit',
      title: 'Edit file',
      status: 'completed',
      locations: [{ path: 'src/utils/helpers.ts', line: 42 }],
    },
  },
};

export const Failed: Story = {
  args: {
    toolCall: {
      toolCallId: 'edit-4',
      kind: 'edit',
      title: 'Edit file',
      status: 'failed',
      content: [
        {
          type: 'diff',
          path: 'src/App.tsx',
          oldText: 'old content',
          newText: 'new content',
        },
      ],
    },
  },
};
