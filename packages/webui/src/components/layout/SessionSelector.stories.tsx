/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { SessionSelector } from './SessionSelector.js';

/**
 * SessionSelector component displays a session list dropdown.
 * Shows sessions grouped by date with search and infinite scroll support.
 */
const meta: Meta<typeof SessionSelector> = {
  title: 'Layout/SessionSelector',
  component: SessionSelector,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    visible: {
      control: 'boolean',
      description: 'Whether the selector is visible',
    },
    currentSessionId: {
      control: 'text',
      description: 'Currently selected session ID',
    },
    searchQuery: {
      control: 'text',
      description: 'Current search query',
    },
    hasMore: {
      control: 'boolean',
      description: 'Whether there are more sessions to load',
    },
    isLoading: {
      control: 'boolean',
      description: 'Whether loading is in progress',
    },
    onSearchChange: { action: 'searchChanged' },
    onSelectSession: { action: 'sessionSelected' },
    onClose: { action: 'closed' },
    onLoadMore: { action: 'loadMore' },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          height: '600px',
          background: 'var(--app-background, #1e1e1e)',
          position: 'relative',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

const now = new Date();
const today = now.toISOString();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
const lastWeek = new Date(
  now.getTime() - 5 * 24 * 60 * 60 * 1000,
).toISOString();
const older = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

const mockSessions = [
  { id: '1', title: 'Debugging React hooks', lastUpdated: today },
  { id: '2', title: 'API integration discussion', lastUpdated: today },
  { id: '3', title: 'Code review feedback', lastUpdated: yesterday },
  { id: '4', title: 'Project planning', lastUpdated: lastWeek },
  { id: '5', title: 'Feature brainstorming', lastUpdated: lastWeek },
  { id: '6', title: 'Old conversation', lastUpdated: older },
];

export const Default: Story = {
  args: {
    visible: true,
    sessions: mockSessions,
    currentSessionId: '1',
    searchQuery: '',
  },
};

export const WithSearch: Story = {
  args: {
    visible: true,
    sessions: mockSessions.filter((s) =>
      s.title.toLowerCase().includes('debug'),
    ),
    currentSessionId: null,
    searchQuery: 'debug',
  },
};

export const Empty: Story = {
  args: {
    visible: true,
    sessions: [],
    currentSessionId: null,
    searchQuery: '',
  },
};

export const NoSearchResults: Story = {
  args: {
    visible: true,
    sessions: [],
    currentSessionId: null,
    searchQuery: 'nonexistent',
  },
};

export const Loading: Story = {
  args: {
    visible: true,
    sessions: mockSessions,
    currentSessionId: '1',
    searchQuery: '',
    hasMore: true,
    isLoading: true,
  },
};

export const Hidden: Story = {
  args: {
    visible: false,
    sessions: mockSessions,
    currentSessionId: '1',
    searchQuery: '',
  },
};

export const ManySessions: Story = {
  args: {
    visible: true,
    sessions: Array.from({ length: 30 }, (_, i) => ({
      id: String(i + 1),
      title: `Session ${i + 1}`,
      lastUpdated: new Date(
        now.getTime() - i * 24 * 60 * 60 * 1000,
      ).toISOString(),
    })),
    currentSessionId: '5',
    searchQuery: '',
    hasMore: true,
  },
};
