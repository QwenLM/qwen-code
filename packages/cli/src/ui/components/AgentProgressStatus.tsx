/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useAgentStatus } from '../contexts/AgentStatusContext.js';

export const AgentProgressStatus: React.FC = () => {
  const { activeAgents } = useAgentStatus();

  if (activeAgents.length === 0) {
    return null; // Don't render anything if no active agents
  }

  // Count agents by status
  const runningAgents = activeAgents.filter(
    (agent) => agent.status === 'running',
  );
  const completedAgents = activeAgents.filter(
    (agent) => agent.status === 'completed',
  );
  const failedAgents = activeAgents.filter(
    (agent) => agent.status === 'failed',
  );
  const cancelledAgents = activeAgents.filter(
    (agent) => agent.status === 'cancelled',
  );

  // Calculate progress if there are running agents with tool call data
  const runningWithProgress = runningAgents.filter(
    (agent) =>
      agent.toolCalls !== undefined && agent.completedCalls !== undefined,
  );

  return (
    <Box flexDirection="row" alignItems="center" gap={0.5}>
      <Text color={theme.text.accent}>🤖</Text>

      {/* Running agents with progress */}
      {runningWithProgress.length > 0 ? (
        <Box flexDirection="row" gap={0.5}>
          {runningWithProgress.map((agent, index) => (
            <Box key={agent.id} flexDirection="row" gap={0.2}>
              <Text color={theme.status.warning}>{agent.name}</Text>
              <Text color={theme.text.secondary}>
                {agent.completedCalls !== undefined &&
                agent.toolCalls !== undefined
                  ? ` ${agent.completedCalls}/${agent.toolCalls}`
                  : ''}
              </Text>
              {index < runningWithProgress.length - 1 && (
                <Text color={theme.ui.symbol}>|</Text>
              )}
            </Box>
          ))}
        </Box>
      ) : runningAgents.length > 0 ? (
        <Box flexDirection="row" gap={0.2}>
          <Text color={theme.status.warning}>{runningAgents.length} ⋯</Text>
        </Box>
      ) : null}

      {/* Completed agents */}
      {completedAgents.length > 0 && (
        <Box flexDirection="row" gap={0.2}>
          <Text color={theme.status.success}>{completedAgents.length} ✓</Text>
        </Box>
      )}

      {/* Failed agents */}
      {failedAgents.length > 0 && (
        <Box flexDirection="row" gap={0.2}>
          <Text color={theme.status.error}>{failedAgents.length} ✗</Text>
        </Box>
      )}

      {/* Cancelled agents */}
      {cancelledAgents.length > 0 && (
        <Box flexDirection="row" gap={0.2}>
          <Text color={theme.status.warning}>{cancelledAgents.length} ⏹</Text>
        </Box>
      )}
    </Box>
  );
};
