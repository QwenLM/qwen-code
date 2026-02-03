/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusIndicator } from './LayoutComponents.js';

/**
 * StatusIndicator displays a colored dot with status text.
 */
const meta: Meta<typeof StatusIndicator> = {
  title: 'ToolCalls/Shared/StatusIndicator',
  component: StatusIndicator,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  args: {
    status: 'pending',
    text: 'Waiting to start',
  },
};

export const InProgress: Story = {
  args: {
    status: 'in_progress',
    text: 'Processing...',
  },
};

export const Completed: Story = {
  args: {
    status: 'completed',
    text: 'Done',
  },
};

export const Failed: Story = {
  args: {
    status: 'failed',
    text: 'Error occurred',
  },
};
