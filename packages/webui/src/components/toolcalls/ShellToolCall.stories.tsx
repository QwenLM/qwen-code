/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ShellToolCall } from './ShellToolCall.js';

/**
 * ShellToolCall displays bash/execute command operations.
 * Shows command input (IN) and output (OUT) in a card layout.
 */
const meta: Meta<typeof ShellToolCall> = {
  title: 'ToolCalls/ShellToolCall',
  component: ShellToolCall,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Bash command with successful output
 */
export const BashWithOutput: Story = {
  args: {
    toolCall: {
      toolCallId: 'bash-1',
      kind: 'bash',
      title: 'ls -la',
      status: 'completed',
      rawInput: { command: 'ls -la' },
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'total 24\ndrwxr-xr-x  5 user staff  160 Jan 16 10:00 .\ndrwxr-xr-x 10 user staff  320 Jan 16 09:00 ..\n-rw-r--r--  1 user staff 1234 Jan 16 10:00 package.json\n-rw-r--r--  1 user staff  567 Jan 16 10:00 tsconfig.json',
          },
        },
      ],
    },
  },
};

/**
 * Bash command without output (just ran successfully)
 */
export const BashNoOutput: Story = {
  args: {
    toolCall: {
      toolCallId: 'bash-2',
      kind: 'bash',
      title: 'mkdir -p src/components',
      status: 'completed',
      rawInput: { command: 'mkdir -p src/components' },
    },
  },
};

/**
 * Bash command with error
 */
export const BashWithError: Story = {
  args: {
    toolCall: {
      toolCallId: 'bash-3',
      kind: 'bash',
      title: 'rm -rf /protected',
      status: 'failed',
      rawInput: { command: 'rm -rf /protected' },
      content: [
        {
          type: 'content',
          content: {
            type: 'error',
            error: 'rm: /protected: Permission denied',
          },
        },
      ],
    },
  },
};

/**
 * Bash command in progress (loading state)
 */
export const BashLoading: Story = {
  args: {
    toolCall: {
      toolCallId: 'bash-4',
      kind: 'bash',
      title: 'npm install',
      status: 'in_progress',
      rawInput: { command: 'npm install' },
    },
  },
};

/**
 * Execute variant with description
 */
export const ExecuteWithDescription: Story = {
  args: {
    toolCall: {
      toolCallId: 'execute-1',
      kind: 'execute',
      title: 'Run unit tests',
      status: 'completed',
      rawInput: {
        command: 'npm test',
        description: 'Run unit tests',
      },
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: 'PASS src/utils.test.ts\n  ✓ should format date correctly (5ms)\n  ✓ should parse input (2ms)\n\nTest Suites: 1 passed, 1 total\nTests:       2 passed, 2 total',
          },
        },
      ],
    },
  },
};

/**
 * Execute variant with long output (truncated)
 */
export const ExecuteLongOutput: Story = {
  args: {
    toolCall: {
      toolCallId: 'execute-2',
      kind: 'execute',
      title: 'Build project',
      status: 'completed',
      rawInput: {
        command: 'npm run build',
        description: 'Build project',
      },
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: Array(100)
              .fill('Building module...')
              .map((s, i) => `[${i + 1}/100] ${s}`)
              .join('\n'),
          },
        },
      ],
    },
  },
};

/**
 * Command variant (alias for bash)
 */
export const CommandVariant: Story = {
  args: {
    toolCall: {
      toolCallId: 'command-1',
      kind: 'command',
      title: 'git status',
      status: 'completed',
      rawInput: { command: 'git status' },
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean",
          },
        },
      ],
    },
  },
};
