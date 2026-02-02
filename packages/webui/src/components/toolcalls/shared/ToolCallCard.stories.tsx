/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ToolCallCard, ToolCallRow } from './LayoutComponents.js';

/**
 * ToolCallCard is a card-style container for displaying detailed tool call results.
 * Used when there's more content to show than fits in a compact container.
 */
const meta: Meta<typeof ToolCallCard> = {
  title: 'ToolCalls/Shared/ToolCallCard',
  component: ToolCallCard,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    icon: '🔧',
    children: (
      <ToolCallRow label="Task">
        <div>Processing data...</div>
      </ToolCallRow>
    ),
  },
};

export const WithMultipleRows: Story = {
  args: {
    icon: '📝',
    children: (
      <>
        <ToolCallRow label="Edit">
          <div>src/components/App.tsx</div>
        </ToolCallRow>
        <ToolCallRow label="Changes">
          <div>+15 lines, -3 lines</div>
        </ToolCallRow>
      </>
    ),
  },
};

export const WithError: Story = {
  args: {
    icon: '❌',
    children: (
      <>
        <ToolCallRow label="Command">
          <div className="font-mono">npm run build</div>
        </ToolCallRow>
        <ToolCallRow label="Error">
          <div className="text-[#c74e39]">Build failed with 3 errors</div>
        </ToolCallRow>
      </>
    ),
  },
};

export const ThinkingCard: Story = {
  args: {
    icon: '💭',
    children: (
      <ToolCallRow label="SaveMemory">
        <div className="italic opacity-90">
          The user wants to refactor the authentication module...
        </div>
      </ToolCallRow>
    ),
  },
};
