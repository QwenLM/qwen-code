/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  type ArenaManager,
  type ArenaAgentState,
  type InProcessBackend,
  type AgentStatsSummary,
  isTerminalStatus,
  ArenaSessionStatus,
  DISPLAY_MODE,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { formatDuration } from '../../utils/formatters.js';
import { getArenaStatusLabel } from '../../utils/displayUtils.js';

const STATUS_REFRESH_INTERVAL_MS = 2000;
const IN_PROCESS_REFRESH_INTERVAL_MS = 1000;

interface ArenaStatusDialogProps {
  manager: ArenaManager;
  closeArenaDialog: () => void;
  width?: number;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function pad(
  str: string,
  len: number,
  align: 'left' | 'right' = 'left',
): string {
  if (str.length >= len) return str.slice(0, len);
  const padding = ' '.repeat(len - str.length);
  return align === 'right' ? padding + str : str + padding;
}

function getElapsedMs(agent: ArenaAgentState): number {
  if (isTerminalStatus(agent.status)) {
    return agent.stats.durationMs;
  }
  return Date.now() - agent.startedAt;
}

function getSessionStatusLabel(status: ArenaSessionStatus): {
  text: string;
  color: string;
} {
  switch (status) {
    case ArenaSessionStatus.RUNNING:
      return { text: 'Running', color: theme.status.success };
    case ArenaSessionStatus.INITIALIZING:
      return { text: 'Initializing', color: theme.status.warning };
    case ArenaSessionStatus.COMPLETED:
      return { text: 'Completed', color: theme.status.success };
    case ArenaSessionStatus.CANCELLED:
      return { text: 'Cancelled', color: theme.status.warning };
    case ArenaSessionStatus.FAILED:
      return { text: 'Failed', color: theme.status.error };
    default:
      return { text: String(status), color: theme.text.secondary };
  }
}

const MAX_MODEL_NAME_LENGTH = 35;

export function ArenaStatusDialog({
  manager,
  closeArenaDialog,
  width,
}: ArenaStatusDialogProps): React.JSX.Element {
  const [tick, setTick] = useState(0);

  // Detect in-process backend for live stats reading
  const backend = manager.getBackend();
  const isInProcess = backend?.type === DISPLAY_MODE.IN_PROCESS;
  const inProcessBackend = isInProcess ? (backend as InProcessBackend) : null;

  useEffect(() => {
    const interval = isInProcess
      ? IN_PROCESS_REFRESH_INTERVAL_MS
      : STATUS_REFRESH_INTERVAL_MS;
    const timer = setInterval(() => {
      setTick((prev) => prev + 1);
    }, interval);
    return () => clearInterval(timer);
  }, [isInProcess]);

  // Force re-read on every tick
  void tick;

  const sessionStatus = manager.getSessionStatus();
  const sessionLabel = getSessionStatusLabel(sessionStatus);
  const agents = manager.getAgentStates();
  const task = manager.getTask() ?? '';

  // For in-process mode, read live stats directly from AgentInteractive
  const liveStats = useMemo(() => {
    if (!inProcessBackend) return null;
    const statsMap = new Map<string, AgentStatsSummary>();
    for (const agent of agents) {
      const interactive = inProcessBackend.getAgent(agent.agentId);
      if (interactive) {
        statsMap.set(agent.agentId, interactive.getStats());
      }
    }
    return statsMap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inProcessBackend, agents, tick]);

  const maxTaskLen = 60;
  const displayTask =
    task.length > maxTaskLen ? task.slice(0, maxTaskLen - 1) + '…' : task;

  const colStatus = 14;
  const colTime = 8;
  const colTokens = 10;
  const colRounds = 8;
  const colTools = 8;

  useKeypress(
    (key) => {
      if (key.name === 'escape' || key.name === 'q' || key.name === 'return') {
        closeArenaDialog();
      }
    },
    { isActive: true },
  );

  // Inner content width: total width minus border (2) and paddingX (2*2)
  const innerWidth = (width ?? 80) - 6;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      width="100%"
    >
      {/* Title */}
      <Box>
        <Text bold color={theme.text.primary}>
          Arena Status
        </Text>
        <Text color={theme.text.secondary}> · </Text>
        <Text color={sessionLabel.color}>{sessionLabel.text}</Text>
        {isInProcess && (
          <>
            <Text color={theme.text.secondary}> · </Text>
            <Text color={theme.text.accent}>In-Process</Text>
          </>
        )}
      </Box>

      <Box height={1} />

      {/* Task */}
      <Box>
        <Text>
          <Text color={theme.text.secondary}>Task: </Text>
          <Text color={theme.text.primary}>&quot;{displayTask}&quot;</Text>
        </Text>
      </Box>

      <Box height={1} />

      {/* Table header */}
      <Box>
        <Box flexGrow={1}>
          <Text bold color={theme.text.secondary}>
            Agent
          </Text>
        </Box>
        <Box width={colStatus} justifyContent="flex-end">
          <Text bold color={theme.text.secondary}>
            Status
          </Text>
        </Box>
        <Box width={colTime} justifyContent="flex-end">
          <Text bold color={theme.text.secondary}>
            Time
          </Text>
        </Box>
        <Box width={colTokens} justifyContent="flex-end">
          <Text bold color={theme.text.secondary}>
            Tokens
          </Text>
        </Box>
        <Box width={colRounds} justifyContent="flex-end">
          <Text bold color={theme.text.secondary}>
            Rounds
          </Text>
        </Box>
        <Box width={colTools} justifyContent="flex-end">
          <Text bold color={theme.text.secondary}>
            Tools
          </Text>
        </Box>
      </Box>

      {/* Separator */}
      <Box>
        <Text color={theme.border.default}>{'─'.repeat(innerWidth)}</Text>
      </Box>

      {/* Agent rows */}
      {agents.map((agent) => {
        const label = agent.model.displayName || agent.model.modelId;
        const { text: statusText, color } = getArenaStatusLabel(agent.status);
        const elapsed = getElapsedMs(agent);

        // Use live stats from AgentInteractive when in-process, otherwise
        // fall back to the cached ArenaAgentState.stats (file-polled).
        const live = liveStats?.get(agent.agentId);
        const totalTokens = live?.totalTokens ?? agent.stats.totalTokens;
        const rounds = live?.rounds ?? agent.stats.rounds;
        const toolCalls = live?.totalToolCalls ?? agent.stats.toolCalls;
        const successfulToolCalls =
          live?.successfulToolCalls ?? agent.stats.successfulToolCalls;
        const failedToolCalls =
          live?.failedToolCalls ?? agent.stats.failedToolCalls;

        return (
          <Box key={agent.agentId} flexDirection="column">
            <Box>
              <Box flexGrow={1}>
                <Text color={theme.text.primary}>
                  {truncate(label, MAX_MODEL_NAME_LENGTH)}
                </Text>
              </Box>
              <Box width={colStatus} justifyContent="flex-end">
                <Text color={color}>{statusText}</Text>
              </Box>
              <Box width={colTime} justifyContent="flex-end">
                <Text color={theme.text.primary}>
                  {pad(formatDuration(elapsed), colTime - 1, 'right')}
                </Text>
              </Box>
              <Box width={colTokens} justifyContent="flex-end">
                <Text color={theme.text.primary}>
                  {pad(totalTokens.toLocaleString(), colTokens - 1, 'right')}
                </Text>
              </Box>
              <Box width={colRounds} justifyContent="flex-end">
                <Text color={theme.text.primary}>
                  {pad(String(rounds), colRounds - 1, 'right')}
                </Text>
              </Box>
              <Box width={colTools} justifyContent="flex-end">
                {failedToolCalls > 0 ? (
                  <Text>
                    <Text color={theme.status.success}>
                      {successfulToolCalls}
                    </Text>
                    <Text color={theme.text.secondary}>/</Text>
                    <Text color={theme.status.error}>{failedToolCalls}</Text>
                  </Text>
                ) : (
                  <Text color={theme.text.primary}>
                    {pad(String(toolCalls), colTools - 1, 'right')}
                  </Text>
                )}
              </Box>
            </Box>
            {/* In-process mode: show extra detail row with cost + thought tokens */}
            {live && (live.estimatedCost > 0 || live.thoughtTokens > 0) && (
              <Box marginLeft={2}>
                <Text color={theme.text.secondary}>
                  {live.estimatedCost > 0 &&
                    `Cost: $${live.estimatedCost.toFixed(4)}`}
                  {live.estimatedCost > 0 && live.thoughtTokens > 0 && '  ·  '}
                  {live.thoughtTokens > 0 &&
                    `Thinking: ${live.thoughtTokens.toLocaleString()} tok`}
                  {live.cachedTokens > 0 &&
                    `  ·  Cached: ${live.cachedTokens.toLocaleString()} tok`}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      {agents.length === 0 && (
        <Box>
          <Text color={theme.text.secondary}>No agents registered yet.</Text>
        </Box>
      )}
    </Box>
  );
}
