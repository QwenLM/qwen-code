/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ThinkingMessage } from './ThinkingMessage.js';

/**
 * ThinkingMessage component displays the AI's internal thinking process.
 * Supports collapse/expand functionality, collapsed by default, click to expand and view details.
 *
 * Style reference from Claude Code's thinking message design:
 * - Collapsed: gray dot + "Thinking" + down arrow
 * - Expanded: solid dot + "Thinking" + up arrow + thinking content
 * - Aligned with other message items, with status icon and connector line
 */
const meta: Meta<typeof ThinkingMessage> = {
  title: 'Messages/ThinkingMessage',
  component: ThinkingMessage,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    content: {
      control: 'text',
      description: 'Thinking content',
    },
    timestamp: {
      control: 'number',
      description: 'Message timestamp',
    },
    defaultExpanded: {
      control: 'boolean',
      description: 'Whether to expand by default',
    },
    status: {
      control: 'select',
      options: ['default', 'loading'],
      description:
        'Status: loading means thinking in progress, default means thinking complete',
    },
    onFileClick: { action: 'fileClicked' },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: 'var(--app-background, #1e1e1e)',
          padding: '20px',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default state - collapsed
 */
export const Default: Story = {
  args: {
    content: 'Let me analyze this code and think about the best approach...',
    timestamp: Date.now(),
    defaultExpanded: false,
    status: 'default',
  },
};

/**
 * Default expanded state
 */
export const Expanded: Story = {
  args: {
    content: 'Let me analyze this code and think about the best approach...',
    timestamp: Date.now(),
    defaultExpanded: true,
    status: 'default',
  },
};

/**
 * Thinking in progress - with pulse animation
 */
export const Loading: Story = {
  args: {
    content: 'Analyzing the codebase structure...',
    timestamp: Date.now(),
    defaultExpanded: false,
    status: 'loading',
  },
};

/**
 * Thinking in progress - expanded
 */
export const LoadingExpanded: Story = {
  args: {
    content: 'Analyzing the codebase structure...',
    timestamp: Date.now(),
    defaultExpanded: true,
    status: 'loading',
  },
};

/**
 * Long thinking content - multiline text
 */
export const LongThought: Story = {
  args: {
    content: `I need to consider several factors here:
1. The function structure and its dependencies
2. The type annotations and their implications
3. How this integrates with the rest of the codebase
4. Performance implications of the proposed changes

Let me work through each of these systematically...`,
    timestamp: Date.now(),
    defaultExpanded: true,
    status: 'default',
  },
};

/**
 * Thinking content with file path
 */
export const WithFilePath: Story = {
  args: {
    content:
      'Looking at the code in `src/utils/helpers.ts` to understand the pattern...',
    timestamp: Date.now(),
    defaultExpanded: true,
    status: 'default',
  },
};
