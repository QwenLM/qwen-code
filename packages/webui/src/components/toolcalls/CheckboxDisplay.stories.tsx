/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { CheckboxDisplay } from './CheckboxDisplay.js';

/**
 * CheckboxDisplay is a read-only checkbox for displaying plan entry status.
 */
const meta: Meta<typeof CheckboxDisplay> = {
  title: 'ToolCalls/Shared/CheckboxDisplay',
  component: CheckboxDisplay,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {
  args: {
    checked: false,
    indeterminate: false,
  },
};

export const Checked: Story = {
  args: {
    checked: true,
    indeterminate: false,
  },
};

export const Indeterminate: Story = {
  args: {
    checked: false,
    indeterminate: true,
  },
};

export const AllStates: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <CheckboxDisplay checked={false} />
        <div style={{ fontSize: '12px', marginTop: '4px' }}>Pending</div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <CheckboxDisplay indeterminate />
        <div style={{ fontSize: '12px', marginTop: '4px' }}>In Progress</div>
      </div>
      <div style={{ textAlign: 'center' }}>
        <CheckboxDisplay checked />
        <div style={{ fontSize: '12px', marginTop: '4px' }}>Completed</div>
      </div>
    </div>
  ),
};
