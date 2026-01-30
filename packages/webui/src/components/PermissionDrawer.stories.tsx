/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import PermissionDrawer from './PermissionDrawer.js';
import type {
  PermissionOption,
  PermissionToolCall,
} from './PermissionDrawer.js';

const options: PermissionOption[] = [
  {
    name: 'Allow once',
    kind: 'approve_once',
    optionId: 'allow-once',
  },
  {
    name: 'Always allow',
    kind: 'approve_always',
    optionId: 'allow-always',
  },
  {
    name: 'Deny',
    kind: 'reject',
    optionId: 'deny',
  },
];

const toolCall: PermissionToolCall = {
  kind: 'edit',
  title: 'Edit src/components/PermissionDrawer.tsx',
  locations: [
    {
      path: 'src/components/PermissionDrawer.tsx',
      line: 42,
    },
  ],
};

const meta: Meta<typeof PermissionDrawer> = {
  title: 'Components/PermissionDrawer',
  component: PermissionDrawer,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [isOpen, setIsOpen] = useState(true);

    return (
      <div
        style={{
          minHeight: '100vh',
          padding: '16px',
          background: 'var(--app-primary-background, #1e1e1e)',
        }}
      >
        <PermissionDrawer
          isOpen={isOpen}
          options={options}
          toolCall={toolCall}
          onResponse={(optionId) => {
            console.log('[PermissionDrawer story] response:', optionId);
            setIsOpen(false);
          }}
          onClose={() => setIsOpen(false)}
        />
      </div>
    );
  },
};
