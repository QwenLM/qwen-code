/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChatHeader } from './ChatHeader.js';

/**
 * ChatHeader component for displaying chat session information.
 * Shows current session title with navigation controls.
 */
const meta: Meta<typeof ChatHeader> = {
  title: 'Layout/ChatHeader',
  component: ChatHeader,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    currentSessionTitle: {
      control: 'text',
      description: 'Current session title to display',
    },
    onLoadSessions: { action: 'loadSessions' },
    onNewSession: { action: 'newSession' },
  },
  decorators: [
    (Story) => (
      <div
        style={{ width: '400px', background: 'var(--app-background, #1e1e1e)' }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    currentSessionTitle: 'My Chat Session',
  },
};

export const LongTitle: Story = {
  args: {
    currentSessionTitle:
      'This is a very long session title that should be truncated with ellipsis',
  },
};

export const ShortTitle: Story = {
  args: {
    currentSessionTitle: 'Chat',
  },
};

export const UntitledSession: Story = {
  args: {
    currentSessionTitle: 'Untitled Session',
  },
};
