/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  AgentStatus,
  type ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem, HistoryItemWithoutId } from '../../types.js';
import { StreamingState, ToolCallStatus } from '../../types.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import type { RegisteredAgent } from '../../contexts/AgentViewContext.js';
import type { SlashCommand } from '../../commands/types.js';
import { theme } from '../../semantic-colors.js';
import { buildThoughtHeadIdMap } from '../../utils/historyUtils.js';
import { HistoryItemDisplay } from '../HistoryItemDisplay.js';
import {
  SCROLL_TO_ITEM_END,
  ScrollableList,
} from '../shared/ScrollableList.js';
import { agentMessagesToHistoryItems } from './agentHistoryAdapter.js';

const LEADER_WIDTH_RATIO = 0.4;
const MIN_PANE_COLUMNS = 36;
const MIN_PANE_ROWS = 8;
export const MAX_FLEET_GRID_TEAMMATES = 3;

interface FleetGridProps {
  activeView: string;
  agents: ReadonlyArray<readonly [string, RegisteredAgent]>;
  width: number;
  height: number;
}

interface PaneItem {
  item: HistoryItem;
  key: string;
  pending: boolean;
}

export function canShowFleetGrid(
  width: number,
  height: number,
  teammateCount: number,
): boolean {
  const visibleTeammates = Math.min(
    teammateCount,
    MAX_FLEET_GRID_TEAMMATES,
  );
  const leaderWidth = Math.floor(width * LEADER_WIDTH_RATIO);
  const teammateWidth = width - leaderWidth;
  return (
    visibleTeammates >= 2 &&
    leaderWidth >= MIN_PANE_COLUMNS &&
    teammateWidth >= MIN_PANE_COLUMNS &&
    height >= visibleTeammates * MIN_PANE_ROWS
  );
}

export const FleetGrid = ({
  activeView,
  agents,
  width,
  height,
}: FleetGridProps) => {
  const uiState = useUIState();
  const visibleAgents = agents.slice(0, MAX_FLEET_GRID_TEAMMATES);
  const leaderWidth = Math.floor(width * LEADER_WIDTH_RATIO);
  const teammateWidth = width - leaderWidth;
  const teammateHeights = distributeRows(height, visibleAgents.length);
  const mainItems = useMemo(
    () => buildMainItems(uiState.history, uiState.pendingHistoryItems),
    [uiState.history, uiState.pendingHistoryItems],
  );

  return (
    <Box flexDirection="row" width={width} height={height} overflow="hidden">
      <TranscriptPane
        title="Leader"
        status={leaderStatus(uiState.streamingState)}
        color={theme.text.accent}
        items={mainItems}
        width={leaderWidth}
        height={height}
        focused={activeView === 'main'}
        commands={uiState.slashCommands}
      />
      <Box flexDirection="column" width={teammateWidth} height={height}>
        {visibleAgents.map(([agentId, agent], index) => (
          <AgentTranscriptPane
            key={agentId}
            agentId={agentId}
            agent={agent}
            width={teammateWidth}
            height={teammateHeights[index]!}
            focused={activeView === agentId}
          />
        ))}
      </Box>
    </Box>
  );
};

const AgentTranscriptPane = ({
  agentId,
  agent,
  width,
  height,
  focused,
}: {
  agentId: string;
  agent: RegisteredAgent;
  width: number;
  height: number;
  focused: boolean;
}) => {
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((tick) => tick + 1), []);
  useEffect(() => agent.view.onChange(refresh), [agent.view, refresh]);

  const pendingApprovals = new Map(
    [...agent.view.getPendingApprovals()].map(([callId, details]) => [
      callId,
      {
        ...details,
        onConfirm: async (
          outcome: Parameters<ToolCallConfirmationDetails['onConfirm']>[0],
          payload?: Parameters<ToolCallConfirmationDetails['onConfirm']>[1],
        ) => agent.answerApproval({ callId, outcome, payload }),
      } as ToolCallConfirmationDetails,
    ]),
  );
  const history = agentMessagesToHistoryItems(
    agent.view.getMessages(),
    pendingApprovals,
    agent.view.getLiveOutputs(),
    agent.view.getShellPids(),
    agent.view.getExecutionStartTimes(),
  );
  const firstPending = history.findIndex(isLiveItem);
  const items = history.map((item, index) => ({
    item,
    key: `${agentId}-${item.id}`,
    pending: firstPending !== -1 && index >= firstPending,
  }));

  return (
    <TranscriptPane
      title={agent.modelName ?? agent.modelId}
      status={
        pendingApprovals.size > 0
          ? '● blocked'
          : agentStatus(agent.view.getStatus())
      }
      color={agent.color}
      items={items}
      width={width}
      height={height}
      focused={focused}
    />
  );
};

const TranscriptPane = ({
  title,
  status,
  color,
  items,
  width,
  height,
  focused,
  commands,
}: {
  title: string;
  status: string;
  color: string;
  items: PaneItem[];
  width: number;
  height: number;
  focused: boolean;
  commands?: readonly SlashCommand[];
}) => {
  const contentWidth = Math.max(1, width - 2);
  const contentHeight = Math.max(1, height - 3);
  const thoughtHeads = useMemo(
    () => buildThoughtHeadIdMap(items.map(({ item }) => item)),
    [items],
  );

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
      borderStyle="single"
      borderColor={focused ? theme.border.focused : theme.border.default}
    >
      <Box height={1} paddingX={1} flexShrink={0}>
        <Text
          bold={focused}
          color={focused ? color || theme.text.accent : theme.text.secondary}
          wrap="truncate"
        >
          {`${title}  ${status}`}
        </Text>
      </Box>
      <ScrollableList
        hasFocus={focused}
        data={items}
        renderItem={({ item: entry }) => (
          <HistoryItemDisplay
            item={entry.item}
            isPending={entry.pending}
            isFocused={focused}
            terminalWidth={contentWidth}
            mainAreaWidth={contentWidth}
            availableTerminalHeight={contentHeight}
            commands={commands}
            thoughtHeadId={thoughtHeads.get(entry.item)}
          />
        )}
        estimatedItemHeight={() => 3}
        keyExtractor={(entry) => entry.key}
        initialScrollIndex={items.length === 0 ? 0 : SCROLL_TO_ITEM_END}
        width={contentWidth}
        containerHeight={contentHeight}
        showScrollbar={false}
      />
    </Box>
  );
};

function buildMainItems(
  history: HistoryItem[],
  pending: HistoryItemWithoutId[],
): PaneItem[] {
  return [
    ...history.map((item) => ({
      item,
      key: `leader-history-${item.id}`,
      pending: false,
    })),
    ...pending.map((item, index) => ({
      item: { ...item, id: -(index + 1) } as HistoryItem,
      key: `leader-pending-${index}`,
      pending: true,
    })),
  ];
}

function distributeRows(total: number, count: number): number[] {
  if (count === 0) return [];
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) =>
    index < remainder ? base + 1 : base,
  );
}

function isLiveItem(item: HistoryItem): boolean {
  return (
    item.type === 'tool_group' &&
    item.tools.some(
      (tool) =>
        tool.status === ToolCallStatus.Executing ||
        tool.status === ToolCallStatus.Confirming,
    )
  );
}

function leaderStatus(state: StreamingState): string {
  switch (state) {
    case StreamingState.Responding:
      return '● working';
    case StreamingState.WaitingForConfirmation:
      return '● blocked';
    default:
      return '✓ idle';
  }
}

function agentStatus(status: AgentStatus): string {
  switch (status) {
    case AgentStatus.RUNNING:
    case AgentStatus.INITIALIZING:
      return '● working';
    case AgentStatus.COMPLETED:
      return '✓ completed';
    case AgentStatus.FAILED:
      return '✗ failed';
    case AgentStatus.CANCELLED:
      return '○ cancelled';
    default:
      return '✓ idle';
  }
}
