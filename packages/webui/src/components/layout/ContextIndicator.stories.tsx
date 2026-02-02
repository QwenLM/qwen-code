/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { ContextIndicator } from './ContextIndicator.js';

/**
 * ContextIndicator component shows context usage as a circular progress indicator.
 * Displays token usage information with tooltip on hover.
 */
const meta: Meta<typeof ContextIndicator> = {
  title: 'Layout/ContextIndicator',
  component: ContextIndicator,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    contextUsage: {
      description: 'Context usage data, null to hide indicator',
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    contextUsage: {
      percentLeft: 75,
      usedTokens: 25000,
      tokenLimit: 100000,
    },
  },
};

export const HalfUsed: Story = {
  args: {
    contextUsage: {
      percentLeft: 50,
      usedTokens: 50000,
      tokenLimit: 100000,
    },
  },
};

export const AlmostFull: Story = {
  args: {
    contextUsage: {
      percentLeft: 10,
      usedTokens: 90000,
      tokenLimit: 100000,
    },
  },
};

export const Full: Story = {
  args: {
    contextUsage: {
      percentLeft: 0,
      usedTokens: 100000,
      tokenLimit: 100000,
    },
  },
};

export const LowUsage: Story = {
  args: {
    contextUsage: {
      percentLeft: 95,
      usedTokens: 5000,
      tokenLimit: 100000,
    },
  },
};

export const Hidden: Story = {
  args: {
    contextUsage: null,
  },
};
