/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { Onboarding } from './Onboarding.js';

/**
 * Onboarding is the welcome screen shown to new users.
 * It displays the app logo, welcome message, and a get started button.
 */
const meta: Meta<typeof Onboarding> = {
  title: 'Layout/Onboarding',
  component: Onboarding,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default onboarding screen
 */
export const Default: Story = {
  args: {
    onGetStarted: () => console.log('Get started clicked'),
  },
};

/**
 * With custom icon URL
 */
export const WithIcon: Story = {
  args: {
    iconUrl: 'https://via.placeholder.com/80',
    onGetStarted: () => console.log('Get started clicked'),
  },
};

/**
 * Custom app name and messages
 */
export const CustomBranding: Story = {
  args: {
    iconUrl: 'https://via.placeholder.com/80',
    appName: 'My AI Assistant',
    subtitle:
      'Your personal coding companion powered by advanced AI technology.',
    buttonText: 'Start Coding Now',
    onGetStarted: () => console.log('Get started clicked'),
  },
};

/**
 * Minimal (no icon)
 */
export const NoIcon: Story = {
  args: {
    appName: 'Code Helper',
    subtitle: 'Simple and powerful code assistance.',
    buttonText: 'Begin',
    onGetStarted: () => console.log('Get started clicked'),
  },
};
