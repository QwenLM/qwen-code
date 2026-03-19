/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj, Decorator } from '@storybook/react-vite';
import { CopyButton } from './copyUtils.js';
import { PlatformProvider } from '../../../context/PlatformContext.js';

/**
 * CopyButton displays a copy icon that copies text to clipboard.
 * Note: Parent element needs 'group' class for hover effect.
 */
const meta: Meta<typeof CopyButton> = {
  title: 'ToolCalls/Shared/CopyButton',
  component: CopyButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    ((Story) => (
      <PlatformProvider
        value={{
          type: 'web',
          copyToClipboard: async (text) => {
            await navigator.clipboard.writeText(text);
          },
          features: { canCopy: true },
        }}
      >
        <div className="group p-4 bg-[var(--app-background)]">
          <Story />
        </div>
      </PlatformProvider>
    )) as Decorator,
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    text: 'Hello, World!',
  },
};

export const WithLongText: Story = {
  args: {
    text: 'This is a longer piece of text that will be copied to the clipboard when the button is clicked.',
  },
};
