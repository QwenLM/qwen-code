/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { formatDuration } from '../../utils/formatters.js';
import { getArenaStatusLabel } from '../../utils/displayUtils.js';
import type { ArenaAgentCardData } from '../../types.js';

// ─── Helpers ────────────────────────────────────────────────

// ─── Agent Complete Card ────────────────────────────────────

interface ArenaAgentCardProps {
  agent: ArenaAgentCardData;
  width?: number;
}

export const ArenaAgentCard: React.FC<ArenaAgentCardProps> = ({
  agent,
  width,
}) => {
  const { icon, text, color } = getArenaStatusLabel(agent.status);
  const duration = formatDuration(agent.durationMs);
  const tokens = agent.totalTokens.toLocaleString();
  const inTokens = agent.inputTokens.toLocaleString();
  const outTokens = agent.outputTokens.toLocaleString();

  return (
    <Box flexDirection="column" width={width}>
      {/* Line 1: Status icon + text + label + duration */}
      <Box>
        <Text color={color}>
          {icon} {agent.label} · {text} · {duration}
        </Text>
      </Box>

      {/* Line 2: Tokens */}
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>
          Tokens: {tokens} (in {inTokens}, out {outTokens})
        </Text>
      </Box>

      {/* Line 3: Tool Calls with colored success/error counts */}
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>
          Tool Calls: {agent.toolCalls}
          {agent.failedToolCalls > 0 && (
            <>
              {' '}
              (
              <Text color={theme.status.success}>
                ✓ {agent.successfulToolCalls}
              </Text>
              <Text color={theme.text.secondary}> </Text>
              <Text color={theme.status.error}>✕ {agent.failedToolCalls}</Text>)
            </>
          )}
        </Text>
      </Box>

      {/* Error line (if terminated with error) */}
      {agent.error && (
        <Box marginLeft={2}>
          <Text color={theme.status.error}>{agent.error}</Text>
        </Box>
      )}
    </Box>
  );
};

// ─── Session Complete Card ──────────────────────────────────

interface ArenaSessionCardProps {
  sessionStatus: string;
  task: string;
  totalDurationMs: number;
  agents: ArenaAgentCardData[];
  width?: number;
}

/**
 * Pad or truncate a string to a fixed visual width.
 */
function pad(
  str: string,
  len: number,
  align: 'left' | 'right' = 'left',
): string {
  if (str.length >= len) return str.slice(0, len);
  const padding = ' '.repeat(len - str.length);
  return align === 'right' ? padding + str : str + padding;
}

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Calculate diff stats from a unified diff string.
 * Returns the stats string and individual counts for colored rendering.
 */
function getDiffStats(diff: string | undefined): {
  text: string;
  additions: number;
  deletions: number;
} {
  if (!diff) return { text: '', additions: 0, deletions: 0 };
  const lines = diff.split('\n');
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }
  return { text: `+${additions}/-${deletions}`, additions, deletions };
}

const MAX_MODEL_NAME_LENGTH = 35;

export const ArenaSessionCard: React.FC<ArenaSessionCardProps> = ({
  sessionStatus,
  task,
  agents,
  width,
}) => {
  // Truncate task for display
  const maxTaskLen = 60;
  const displayTask =
    task.length > maxTaskLen ? task.slice(0, maxTaskLen - 1) + '…' : task;

  // Column widths for the agent table (unified with Arena Results)
  const colStatus = 14;
  const colTime = 8;
  const colTokens = 10;
  const colChanges = 10;

  const titleLabel =
    sessionStatus === 'completed'
      ? 'Arena Complete'
      : sessionStatus === 'cancelled'
        ? 'Arena Cancelled'
        : 'Arena Failed';

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      width={width}
    >
      {/* Title - neutral color (not green) */}
      <Box>
        <Text bold color={theme.text.primary}>
          {titleLabel}
        </Text>
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

      {/* Table header - unified columns: Agent, Status, Time, Tokens, Changes */}
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
        <Box width={colChanges} justifyContent="flex-end">
          <Text bold color={theme.text.secondary}>
            Changes
          </Text>
        </Box>
      </Box>

      {/* Table separator */}
      <Box>
        <Text color={theme.border.default}>
          {'─'.repeat((width ?? 60) - 8)}
        </Text>
      </Box>

      {/* Agent rows */}
      {agents.map((agent) => {
        const { text: statusText, color } = getArenaStatusLabel(agent.status);
        const diffStats = getDiffStats(agent.diff);
        return (
          <Box key={agent.label}>
            <Box flexGrow={1}>
              <Text color={theme.text.primary}>
                {truncate(agent.label, MAX_MODEL_NAME_LENGTH)}
              </Text>
            </Box>
            <Box width={colStatus} justifyContent="flex-end">
              <Text color={color}>{statusText}</Text>
            </Box>
            <Box width={colTime} justifyContent="flex-end">
              <Text color={theme.text.primary}>
                {pad(formatDuration(agent.durationMs), colTime - 1, 'right')}
              </Text>
            </Box>
            <Box width={colTokens} justifyContent="flex-end">
              <Text color={theme.text.primary}>
                {pad(
                  agent.totalTokens.toLocaleString(),
                  colTokens - 1,
                  'right',
                )}
              </Text>
            </Box>
            <Box width={colChanges} justifyContent="flex-end">
              {diffStats.additions > 0 || diffStats.deletions > 0 ? (
                <Text>
                  <Text color={theme.status.success}>
                    +{diffStats.additions}
                  </Text>
                  <Text color={theme.text.secondary}>/</Text>
                  <Text color={theme.status.error}>-{diffStats.deletions}</Text>
                </Text>
              ) : (
                <Text color={theme.text.secondary}>-</Text>
              )}
            </Box>
          </Box>
        );
      })}

      <Box height={1} />

      {/* Hint */}
      {sessionStatus === 'completed' && (
        <Box>
          <Text color={theme.text.secondary}>
            Run <Text color={theme.text.accent}>/arena select</Text> to pick a
            winner.
          </Text>
        </Box>
      )}
    </Box>
  );
};
