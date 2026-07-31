/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { EmptyState } from './EmptyState.js';
import { PlatformProvider } from '../../context/PlatformContext.js';

/**
 * EmptyState component displays a welcome screen when no conversation is active.
 * Shows logo and welcome message based on authentication state.
 */
const meta: Meta<typeof EmptyState> = {
  title: 'Layout/EmptyState',
  component: EmptyState,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    isAuthenticated: {
      control: 'boolean',
      description: 'Whether user is authenticated',
    },
    loadingMessage: {
      control: 'text',
      description: 'Optional loading message to display',
    },
    logoUrl: {
      control: 'text',
      description: 'Optional custom logo URL',
    },
    appName: {
      control: 'text',
      description: 'App name for welcome message',
    },
  },
  decorators: [
    (Story) => (
      <PlatformProvider
        value={{
          platform: 'web',
          postMessage: () => {},
          onMessage: () => () => {},
        }}
      >
        <div
          style={{
            height: '400px',
            background: 'var(--app-background, #1e1e1e)',
          }}
        >
          <Story />
        </div>
      </PlatformProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Authenticated: Story = {
  args: {
    isAuthenticated: true,
    appName: 'Qwen Code',
  },
};

export const NotAuthenticated: Story = {
  args: {
    isAuthenticated: false,
    appName: 'Qwen Code',
  },
};

export const Loading: Story = {
  args: {
    isAuthenticated: false,
    loadingMessage: 'Initializing...',
    appName: 'Qwen Code',
  },
};

export const WithCustomLogo: Story = {
  args: {
    isAuthenticated: true,
    appName: 'My App',
    logoUrl: 'https://via.placeholder.com/60',
  },
};

export const CustomAppName: Story = {
  args: {
    isAuthenticated: true,
    appName: 'Claude Code',
  },
};
