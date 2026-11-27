/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { AgentUnifiedTask } from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { FEED_MARKER } from '../constants/feedGrammar.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { resolveAgentColor, AgentNameBadge } from '../utils/agentColors.js';

interface AgentTaskDetailViewProps {
  task: AgentUnifiedTask;
  onBack: () => void;
}

function AgentStatusBadge({ status }: { status: AgentUnifiedTask['status'] }) {
  switch (status) {
    case 'running':
      return <Text color={theme.status.warning}>Running</Text>;
    case 'completed':
      return (
        <Text color={theme.status.success}>
          {FEED_MARKER.subagentCompleted} Completed
        </Text>
      );
    case 'failed':
      return (
        <Text color={theme.status.error}>
          {FEED_MARKER.subagentError} Failed
        </Text>
      );
    case 'killed':
      return (
        <Text color={theme.text.secondary}>
          {FEED_MARKER.subagentCanceled} Stopped
        </Text>
      );
    default:
      return <Text color={theme.text.secondary}>Pending</Text>;
  }
}

function currentStatusText(task: AgentUnifiedTask): string {
  const progress = task.progress;
  const activeItem = progress?.recentActivity
    ?.slice()
    .reverse()
    .find((item) => item.status === 'running');

  if (activeItem) {
    return activeItem.displayName ?? activeItem.content;
  }

  switch (task.status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return task.error ? `Failed: ${task.error}` : 'Failed';
    case 'killed':
      return 'Stopped';
    default:
      return 'Pending';
  }
}

/**
 * Detail view for a running/completed agent task in the UnifiedTaskPanel.
 * Shows the prompt and current execution status only.
 */
export const AgentTaskDetailView: React.FC<AgentTaskDetailViewProps> = ({
  task,
  onBack,
}) => {
  const agentBgColor = resolveAgentColor(task.color);
  const promptLines = task.prompt.split('\n');

  return (
    <BaseTabDialog
      title={`Agent · ${task.agentName}`}
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onBack}
    >
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={1}>
          <AgentNameBadge name={task.agentName} bgColor={agentBgColor} />
          <Text color={theme.text.secondary}>·</Text>
          <AgentStatusBadge status={task.status} />
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.secondary} wrap="wrap">
            {task.description}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.secondary}>Current</Text>
          <Text wrap="wrap">{currentStatusText(task)}</Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.secondary}>Prompt</Text>
          {promptLines.map((line, index) => (
            <Text key={index} color={theme.text.secondary} wrap="wrap">
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    </BaseTabDialog>
  );
};
