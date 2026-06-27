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
import type { ArenaDiffSummary } from '@qwen-code/qwen-code-core';

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
 * Calculate diff stats from a unified diff string.
 * Returns the stats string and individual counts for colored rendering.
 */
function getDiffStats(
  diff: string | undefined,
  diffSummary?: ArenaDiffSummary,
): {
  text: string;
  additions: number;
  deletions: number;
} {
  if (diffSummary) {
    return {
      text: `+${diffSummary.additions}/-${diffSummary.deletions}`,
      additions: diffSummary.additions,
      deletions: diffSummary.deletions,
    };
  }
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

const MAX_FILE_LIST_ITEMS = 4;

function formatFileList(files: string[] | undefined): string {
  if (!files || files.length === 0) {
    return 'none';
  }
  const visible = files.slice(0, MAX_FILE_LIST_ITEMS);
  const suffix =
    files.length > MAX_FILE_LIST_ITEMS
      ? `, +${files.length - MAX_FILE_LIST_ITEMS} more`
      : '';
  return `${visible.join(', ')}${suffix}`;
}

function getAgentFiles(agent: ArenaAgentCardData): string[] {
  return (
    agent.modifiedFiles ??
    agent.diffSummary?.files.map((file) => file.path) ??
    []
  );
}

function getComparisonFileGroups(
  agents: ArenaAgentCardData[],
): Array<{ label: string; files: string[] }> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    for (const file of new Set(getAgentFiles(agent))) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }

  const common = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([file]) => file)
    .sort();
  const groups = [{ label: 'common', files: common }];

  for (const agent of agents) {
    const unique = getAgentFiles(agent)
      .filter((file) => counts.get(file) === 1)
      .sort();
    if (unique.length > 0) {
      groups.push({ label: `${agent.label}-only`, files: unique });
    }
  }

  return groups;
}

function getTreeBranch(index: number, total: number): string {
  return index === total - 1 ? '└─' : '├─';
}

export const ArenaSessionCard: React.FC<ArenaSessionCardProps> = ({
  sessionStatus,
  agents,
  width,
}) => {
  const titleLabel =
    sessionStatus === 'idle' || sessionStatus === 'completed'
      ? 'Arena Comparison Summary'
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

      {(sessionStatus === 'idle' || sessionStatus === 'completed') && (
        <>
          <Box flexDirection="column">
            <Text bold color={theme.text.primary}>
              Status Summary:
            </Text>
            {agents.map((agent, index) => {
              const { text: statusText, color } = getArenaStatusLabel(
                agent.status,
              );
              return (
                <Box key={agent.label} marginLeft={2}>
                  <Text color={theme.text.secondary}>
                    {index === agents.length - 1 ? '└─' : '├─'} {agent.label}
                    :{' '}
                  </Text>
                  <Text color={color}>{statusText}</Text>
                </Box>
              );
            })}
          </Box>

          <Box height={1} />

          <Box flexDirection="column">
            <Text bold color={theme.text.primary}>
              Files Modified:
            </Text>
            {getComparisonFileGroups(agents).map((group, index, groups) => (
              <Box key={group.label} marginLeft={2}>
                <Text color={theme.text.secondary}>
                  {getTreeBranch(index, groups.length)} {group.label}:{' '}
                </Text>
                <Text color={theme.text.primary}>
                  {formatFileList(group.files)}
                </Text>
              </Box>
            ))}
          </Box>

          <Box height={1} />

          <Box flexDirection="column">
            <Text bold color={theme.text.primary}>
              Approach Summary:
            </Text>
            {agents.map((agent, index) => {
              const diffStats = getDiffStats(agent.diff, agent.diffSummary);
              const files = getAgentFiles(agent).length;
              const branch = index === agents.length - 1 ? '└─' : '├─';
              const summary =
                agent.approachSummary ?? 'No approach summary available.';
              return (
                <Box key={agent.label} marginLeft={2}>
                  <Text>
                    <Text color={theme.text.secondary}>
                      {branch} {agent.label}:{' '}
                    </Text>
                    <Text color={theme.text.primary}>{summary} </Text>
                    <Text color={theme.text.secondary}>(</Text>
                    <Text color={theme.text.accent}>{files}</Text>
                    <Text color={theme.text.secondary}>
                      {files === 1 ? ' file, ' : ' files, '}
                    </Text>
                    <Text color={theme.status.success}>
                      +{diffStats.additions}
                    </Text>
                    <Text color={theme.text.secondary}> </Text>
                    <Text color={theme.status.error}>
                      -{diffStats.deletions}
                    </Text>
                    <Text color={theme.text.secondary}> lines, </Text>
                    <Text color={theme.text.accent}>{agent.toolCalls}</Text>
                    <Text color={theme.text.secondary}>
                      {agent.toolCalls === 1 ? ' tool call)' : ' tool calls)'}
                    </Text>
                  </Text>
                </Box>
              );
            })}
          </Box>

          <Box height={1} />

          <Box flexDirection="column">
            <Text bold color={theme.text.primary}>
              Token Efficiency:
            </Text>
            {agents.map((agent, index) => (
              <Box key={agent.label} marginLeft={2}>
                <Text color={theme.text.secondary}>
                  {index === agents.length - 1 ? '└─' : '├─'} {agent.label}
                  :{' '}
                </Text>
                <Text color={theme.text.primary}>
                  {agent.totalTokens.toLocaleString()} tokens · runtime{' '}
                  {formatDuration(agent.durationMs)}
                </Text>
              </Box>
            ))}
          </Box>
        </>
      )}

      <Box height={1} />

      {/* Hint */}
      {sessionStatus === 'idle' && (
        <Box flexDirection="column">
          <Text color={theme.text.secondary}>
            Run <Text color={theme.text.accent}>/arena select</Text> to view
            detailed diff or pick a winner.
          </Text>
        </Box>
      )}
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
