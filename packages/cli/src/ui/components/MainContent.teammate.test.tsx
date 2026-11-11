/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { Box, Text } from 'ink';
import type { JSX } from 'react';
import {
  TaskRegistry,
  modelMessageToAssistantPayload,
  type AgentUnifiedTask,
  type Message,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { TaskRegistryProvider } from '../contexts/TaskRegistryContext.js';
import { MainContent } from './MainContent.js';

vi.mock('ink-spinner', () => ({
  default: () => <Text>◉</Text>,
}));

vi.mock('../hooks/useAlternateBuffer.js', () => ({
  useAlternateBuffer: vi.fn(() => false),
}));

vi.mock('./AppHeader.js', () => ({
  AppHeader: () => <Text>AppHeader(full)</Text>,
}));

vi.mock('./shared/ScrollableList.js', () => ({
  ScrollableList: ({
    data,
    renderItem,
  }: {
    data: unknown[];
    renderItem: (props: { item: unknown }) => JSX.Element;
  }) => (
    <Box flexDirection="column">
      <Text>ScrollableList</Text>
      {data.map((item: unknown, index: number) => (
        <Box key={index}>{renderItem({ item })}</Box>
      ))}
    </Box>
  ),
  SCROLL_TO_ITEM_END: 0,
}));

function createMessages(): Message[] {
  const timestamp = new Date().toISOString();
  return [
    {
      type: 'user',
      uuid: 'user-1',
      timestamp,
      message: {
        role: 'user',
        content: 'Review UI state',
      },
    },
    {
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp,
      message: modelMessageToAssistantPayload({
        messageId: 'msg-1',

        model: 'test-model',
        stopReason: 'end_turn',

        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        blocks: [
          {
            type: 'text',
            text: 'frontend teammate checked the UI state.',
          },
        ],
      }),
    },
  ];
}

function createTask(): AgentUnifiedTask {
  return {
    id: 'a-agent-frontend',
    type: 'in_process_teammate',
    status: 'running',
    description: 'Review UI state',
    startTime: 1,
    notified: false,
    executionId: 100,
    completionBehavior: 'notify',
    agentId: 'agent-frontend',
    agentName: 'frontend',
    agentType: 'MockAgent',
    teamName: 'session-abcdef12',
    prompt: 'Review UI state',
    isBackgrounded: true,
    taskId: 'agent-frontend',
    liveMessages: createMessages(),
    transcriptVersion: 1,
  };
}

describe('<MainContent /> teammate transcript', () => {
  it('renders the selected in-process teammate transcript from task registry', async () => {
    const registry = new TaskRegistry();
    const task = createTask();
    registry.register(task);

    const renderResult = await renderWithProviders(
      <TaskRegistryProvider registry={registry}>
        <MainContent />
      </TaskRegistryProvider>,
      {
        uiState: {
          viewedAgentTaskId: task.id,
        },
      },
    );

    await waitFor(() => {
      const output = renderResult.lastFrame();
      expect(output).toContain('Review UI state');
      expect(output).toContain('frontend teammate checked the UI state.');
    });

    renderResult.unmount();
  });
});
