/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';
import type {
  ParallelGroupRuntime,
  ParallelTaskRuntime,
} from '@qwen-code/qwen-code-core';
import { ParallelTaskRunner } from '@qwen-code/qwen-code-core';

interface ParallelPanelProps {
  config: Config | null;
  groupId: string;
}

/**
 * Displays real-time status of a parallel task group.
 * Shows progress bars, tool calls, and completion status.
 */
export const ParallelPanel: React.FC<ParallelPanelProps> = ({
  config,
  groupId,
}) => {
  const [group, setGroup] = useState<ParallelGroupRuntime | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!config) return;

    const runner = new ParallelTaskRunner(config);
    const interval = setInterval(() => {
      const g = runner.getGroup(groupId);
      if (g) {
        setGroup(g);
        setRefreshKey((k) => k + 1);
      }
    }, 500);

    return () => clearInterval(interval);
  }, [config, groupId]);

  if (!group) {
    return null;
  }

  const statusIcon =
    group.status === 'running'
      ? '⏳'
      : group.status === 'completed'
        ? '✅'
        : group.status === 'failed'
          ? '❌'
          : '⏹️';

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text bold>
          {statusIcon} {group.config.description}
        </Text>
        <Text color="dim"> ({group.status})</Text>
      </Box>

      {group.tasks.map((task, index) => (
        <TaskRow key={task.config.taskId} task={task} index={index} />
      ))}
    </Box>
  );
};

interface TaskRowProps {
  task: ParallelTaskRuntime;
  index: number;
}

const TaskRow: React.FC<TaskRowProps> = ({ task, index }) => {
  const { config, status, toolCallCount, error } = task;
  const icon = config.icon ?? '📋';
  const color = config.color;

  const statusIndicator =
    status === 'running'
      ? '🔄'
      : status === 'completed'
        ? '✅'
        : status === 'failed'
          ? '❌'
          : status === 'cancelled'
            ? '⏹️'
            : '⏳';

  // Calculate duration
  let durationText = '';
  if (task.startTime && task.endTime) {
    const durationMs = task.endTime.getTime() - task.startTime.getTime();
    const seconds = Math.floor(durationMs / 1000);
    durationText = `${seconds}s`;
  } else if (task.startTime && status === 'running') {
    const durationMs = Date.now() - task.startTime.getTime();
    const seconds = Math.floor(durationMs / 1000);
    durationText = `${seconds}s`;
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={color}>
          {statusIndicator} {icon} **{config.taskName}**
        </Text>
        {durationText && (
          <Text color="dim"> ({durationText})</Text>
        )}
      </Box>

      {status === 'running' && (
        <Box>
          <Text dimColor>
            ⏳ Running... ({toolCallCount} tool calls)
          </Text>
        </Box>
      )}

      {status === 'completed' && (
        <Box>
          <Text color="green" dimColor>
            ✓ Completed ({toolCallCount} tool calls)
          </Text>
        </Box>
      )}

      {status === 'failed' && error && (
        <Box>
          <Text color="red">
            ✗ Error: {error}
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * Mini status indicator for the header bar.
 * Shows a compact view of active parallel tasks.
 */
export const ParallelStatusBar: React.FC<{
  config: Config | null;
}> = ({ config }) => {
  const [activeCount, setActiveCount] = useState(0);

  useEffect(() => {
    if (!config) return;

    const interval = setInterval(() => {
      const runner = new ParallelTaskRunner(config);
      setActiveCount(runner.getActiveGroups().size);
    }, 1000);

    return () => clearInterval(interval);
  }, [config]);

  if (activeCount === 0) {
    return null;
  }

  return (
    <Box>
      <Text color="yellow">
        ⏳ {activeCount} parallel task{activeCount > 1 ? 's' : ''} running
      </Text>
    </Box>
  );
};
