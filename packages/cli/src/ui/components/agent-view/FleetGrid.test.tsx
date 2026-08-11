/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import {
  AgentStatus,
  type AgentMessage,
  type AgentSessionView,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem } from '../../types.js';
import { StreamingState } from '../../types.js';
import { UIStateContext, type UIState } from '../../contexts/UIStateContext.js';
import type { RegisteredAgent } from '../../contexts/AgentViewContext.js';
import { canShowFleetGrid, FleetGrid } from './FleetGrid.js';

vi.mock('../shared/ScrollableList.js', () => ({
  SCROLL_TO_ITEM_END: Number.MAX_SAFE_INTEGER,
  ScrollableList: ({
    data,
    renderItem,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
  }) => (
    <Box flexDirection="column">
      {data.map((item, index) => (
        <Box key={index}>{renderItem({ item, index })}</Box>
      ))}
    </Box>
  ),
}));

vi.mock('../HistoryItemDisplay.js', () => ({
  HistoryItemDisplay: ({ item }: { item: HistoryItem }) => (
    <Text>{'text' in item ? item.text : item.type}</Text>
  ),
}));

describe('canShowFleetGrid', () => {
  it('requires at least one teammate and enough room for every pane', () => {
    expect(canShowFleetGrid(120, 24, 2)).toBe(true);
    expect(canShowFleetGrid(80, 24, 2)).toBe(false);
    expect(canShowFleetGrid(120, 15, 2)).toBe(false);
    expect(canShowFleetGrid(120, 24, 3)).toBe(true);
  });

  it('shows leader beside a single teammate, the smallest debug scenario', () => {
    expect(canShowFleetGrid(120, 24, 1)).toBe(true);
    expect(canShowFleetGrid(120, 24, 0)).toBe(false);
  });

  it('still falls back to tabs when a single pane cannot fit', () => {
    expect(canShowFleetGrid(80, 24, 1)).toBe(false);
    expect(canShowFleetGrid(120, 4, 1)).toBe(false);
  });
});

describe('FleetGrid', () => {
  it('renders leader and two supervised teammate transcripts in one frame', () => {
    const agents = [
      ['researcher', createAgent('researcher', 'Research result')],
      ['reviewer', createAgent('reviewer', 'Review result')],
    ] as const;
    const uiState = {
      history: [{ type: 'user', text: 'Leader prompt', id: 1 }],
      pendingHistoryItems: [],
      streamingState: StreamingState.Responding,
      slashCommands: [],
    } as unknown as UIState;

    const { lastFrame } = render(
      <UIStateContext.Provider value={uiState}>
        <FleetGrid
          activeView="researcher"
          agents={agents}
          width={120}
          height={24}
        />
      </UIStateContext.Provider>,
    );

    const output = lastFrame() ?? '';
    expect(output).toContain('Leader');
    expect(output).toContain('Leader prompt');
    expect(output).toContain('researcher');
    expect(output).toContain('Research result');
    expect(output).toContain('reviewer');
    expect(output).toContain('Review result');
  });
});

function createAgent(name: string, text: string): RegisteredAgent {
  const messages: AgentMessage[] = [
    { role: 'assistant', content: text, timestamp: Date.now() },
  ];
  const view: AgentSessionView = {
    getStatus: () => AgentStatus.RUNNING,
    getMessages: () => messages,
    getPendingApprovals: () => new Map(),
    getLiveOutputs: () => new Map(),
    getShellPids: () => new Map(),
    getExecutionStartTimes: () => new Map(),
    workingDir: '/tmp',
    modelId: name,
    onChange: () => () => {},
  };
  return {
    session: {
      agentId: name,
      teamId: 'fleet',
      kind: 'supervised',
      getStatus: () => AgentStatus.RUNNING,
      getError: () => undefined,
      send: async () => 'turn-1',
      cancelTurn: () => {},
      abort: () => {},
      on: () => () => {},
    },
    view,
    answerApproval: async () => {},
    modelId: name,
    modelName: name,
    color: 'cyan',
  };
}
