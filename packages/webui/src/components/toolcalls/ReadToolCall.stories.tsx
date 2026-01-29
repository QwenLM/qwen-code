/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReadToolCall } from './ReadToolCall.js';

/**
 * ReadToolCall displays file reading operations.
 * Shows the file name being read with appropriate status indicators.
 */
const meta: Meta<typeof ReadToolCall> = {
  title: 'ToolCalls/ReadToolCall',
  component: ReadToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Successfully read a file
 */
export const Success: Story = {
  args: {
    toolCall: {
      toolCallId: 'read-1',
      kind: 'read',
      title: 'Read file',
      status: 'completed',
      locations: [{ path: 'src/components/Button.tsx', line: 1 }],
    },
  },
};

/**
 * Reading file in progress (loading state)
 */
export const Loading: Story = {
  args: {
    toolCall: {
      toolCallId: 'read-2',
      kind: 'read',
      title: 'Read file',
      status: 'in_progress',
      locations: [{ path: 'src/utils/helpers.ts' }],
    },
  },
};

/**
 * Read file with error
 */
export const WithError: Story = {
  args: {
    toolCall: {
      toolCallId: 'read-3',
      kind: 'read',
      title: 'Read file',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: {
            type: 'error',
            error: 'File not found: src/missing-file.ts',
          },
        },
      ],
      locations: [{ path: 'src/missing-file.ts' }],
    },
  },
};

/**
 * Failed status without explicit error content
 */
export const FailedStatusFallback: Story = {
  args: {
    toolCall: {
      toolCallId: 'read-8',
      kind: 'read',
      title: 'Read file',
      status: 'failed',
      content: [],
      locations: [{ path: 'src/missing-file-no-error.ts' }],
    },
  },
};

/**
 * Read multiple files
 */
export const ReadManyFiles: Story = {
  args: {
    toolCall: {
      toolCallId: 'read-4',
      kind: 'read_many_files',
      title: 'Read multiple files',
      status: 'completed',
      locations: [
        { path: 'src/index.ts' },
        { path: 'src/App.tsx' },
        { path: 'src/main.ts' },
      ],
    },
  },
};

/**
 * List directory operation
 */
export const ListDirectory: Story = {
  args: {
    toolCall: {
      toolCallId: 'read-5',
      kind: 'list_directory',
      title: 'List directory',
      status: 'completed',
      locations: [{ path: 'src/components' }],
    },
  },
};

/**
 * Read with diff content
 */
export const WithDiff: Story = {
  args: {
    toolCall: {
      toolCallId: 'read-6',
      kind: 'read',
      title: 'Read file with diff',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: 'src/config.ts',
          oldText: 'const debug = false;',
          newText: 'const debug = true;',
        },
      ],
      locations: [{ path: 'src/config.ts' }],
    },
  },
};

/**
 * Long file path
 */
export const LongFilePath: Story = {
  args: {
    toolCall: {
      toolCallId: 'read-7',
      kind: 'read',
      title: 'Read file',
      status: 'completed',
      locations: [
        {
          path: 'packages/vscode-ide-companion/src/webview/components/messages/toolcalls/ReadToolCall.tsx',
          line: 42,
        },
      ],
    },
  },
};
