/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Config ,
  ParallelGroupRuntime,
  ParallelTaskRuntime,
} from '@qwen-code/qwen-code-core';
import { ParallelTaskRunner } from '@qwen-code/qwen-code-core';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

// ============================================================================
// Types
// ============================================================================

interface ActivityEntry {
  timestamp: Date;
  type: 'mode_switch' | 'task_start' | 'task_complete' | 'template_generate';
  description: string;
}

// ============================================================================
// Progress Bar Component
// ============================================================================

interface ProgressBarProps {
  progress: number; // 0 to 1
  width?: number;
  color?: string;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  width = 30,
  color = theme.status.success,
}) => {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const filledWidth = Math.round(clampedProgress * width);
  const emptyWidth = width - filledWidth;

  const filled = '\u2588'.repeat(filledWidth);
  const empty = '\u2591'.repeat(emptyWidth);

  return (
    <Text>
      <Text color={color}>{filled}</Text>
      <Text color={theme.text.secondary}>{empty}</Text>
      <Text color={theme.text.secondary}>
        {' '}
        {Math.round(clampedProgress * 100)}%
      </Text>
    </Text>
  );
};

// ============================================================================
// Section Components
// ============================================================================

interface SectionProps {
  title: string;
  icon: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, icon, children }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text>{icon} </Text>
      <Text bold color={theme.text.primary}>
        {title}
      </Text>
    </Box>
    <Box paddingLeft={2} flexDirection="column">
      {children}
    </Box>
  </Box>
);

interface StatRowProps {
  label: string;
  value: string;
  valueColor?: string;
}

const StatRow: React.FC<StatRowProps> = ({ label, value, valueColor }) => (
  <Box>
    <Box width={20}>
      <Text color={theme.text.secondary}>{label}</Text>
    </Box>
    <Text color={valueColor ?? theme.text.primary}>{value}</Text>
  </Box>
);

// ============================================================================
// Current Mode Display
// ============================================================================

interface CurrentModeDisplayProps {
  config: Config | null;
}

const CurrentModeDisplay: React.FC<CurrentModeDisplayProps> = ({ config }) => {
  if (!config) {
    return (
      <Box>
        <Text color={theme.text.secondary}>No configuration available</Text>
      </Box>
    );
  }

  const currentMode = config.getCurrentMode();

  if (!currentMode) {
    return (
      <Box>
        <Text color={theme.text.secondary}>Mode: General (default)</Text>
      </Box>
    );
  }

  const { icon, displayName, color, description } = currentMode.config;
  const displayColor = color ?? theme.text.accent;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={displayColor} bold>
          {icon} {displayName}
        </Text>
        <Text color={theme.text.secondary}> ({currentMode.config.name})</Text>
      </Box>
      <Text color={theme.text.secondary} wrap="wrap">
        {description}
      </Text>
    </Box>
  );
};

// ============================================================================
// Parallel Tasks Display
// ============================================================================

interface ParallelTasksDisplayProps {
  config: Config | null;
}

const ParallelTasksDisplay: React.FC<ParallelTasksDisplayProps> = ({
  config,
}) => {
  const [groups, setGroups] = useState<Map<string, ParallelGroupRuntime>>(
    new Map(),
  );

  useEffect(() => {
    if (!config) return;

    const interval = setInterval(() => {
      const runner = new ParallelTaskRunner(config);
      setGroups(new Map(runner.getActiveGroups()));
    }, 1000);

    return () => clearInterval(interval);
  }, [config]);

  if (groups.size === 0) {
    return <Text color={theme.text.secondary}>No active parallel tasks</Text>;
  }

  return (
    <Box flexDirection="column">
      {Array.from(groups.values()).map((group) => (
        <Box key={group.config.groupId} flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color={theme.text.primary}>
              {group.config.description}
            </Text>
            <Text color="dim"> ({group.status})</Text>
          </Box>
          {group.tasks.map((task) => (
            <TaskRow key={task.config.taskId} task={task} />
          ))}
        </Box>
      ))}
    </Box>
  );
};

interface TaskRowProps {
  task: ParallelTaskRuntime;
}

const TaskRow: React.FC<TaskRowProps> = ({ task }) => {
  const { config, status, toolCallCount } = task;
  const icon = config.icon ?? '📋';

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

  // Estimate progress based on tool calls (heuristic)
  const estimatedProgress =
    status === 'completed'
      ? 1
      : status === 'failed' || status === 'cancelled'
        ? 0
        : Math.min(0.9, toolCallCount * 0.1);

  const statusColor =
    status === 'running'
      ? theme.status.warning
      : status === 'completed'
        ? theme.status.success
        : theme.status.error;

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text>
          {statusIndicator} {icon}{' '}
        </Text>
        <Text color={statusColor}>{config.taskName}</Text>
        <Text color={theme.text.secondary}> ({toolCallCount} tools)</Text>
      </Box>
      {status === 'running' && (
        <ProgressBar
          progress={estimatedProgress}
          width={25}
          color={statusColor}
        />
      )}
    </Box>
  );
};

// ============================================================================
// Recent Activity Display
// ============================================================================

interface RecentActivityDisplayProps {
  activities: ActivityEntry[];
}

const RecentActivityDisplay: React.FC<RecentActivityDisplayProps> = ({
  activities,
}) => {
  if (activities.length === 0) {
    return <Text color={theme.text.secondary}>No recent activity</Text>;
  }

  const formatTime = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
  };

  const getActivityIcon = (type: ActivityEntry['type']): string => {
    switch (type) {
      case 'mode_switch':
        return '🔄';
      case 'task_start':
        return '🚀';
      case 'task_complete':
        return '✅';
      case 'template_generate':
        return '📄';
      default:
        return 'ℹ️';
    }
  };

  return (
    <Box flexDirection="column">
      {activities.slice(0, 10).map((activity, index) => (
        <Box key={index}>
          <Text color={theme.text.secondary}>
            {getActivityIcon(activity.type)} {formatTime(activity.timestamp)}
          </Text>
          <Text color={theme.text.primary}> {activity.description}</Text>
        </Box>
      ))}
    </Box>
  );
};

// ============================================================================
// Mode Statistics Display
// ============================================================================

interface ModeStatsDisplayProps {
  config: Config | null;
}

const ModeStatsDisplay: React.FC<ModeStatsDisplayProps> = ({ config }) => {
  const [sessionStats, setSessionStats] = useState({
    duration: '0s',
    toolCalls: 0,
    filesModified: 0,
  });

  useEffect(() => {
    if (!config) return;

    const interval = setInterval(() => {
      // Compute basic session stats from available data
      const modeManager = config.getModeManager();
      const currentMode = config.getCurrentMode();

      if (currentMode && modeManager) {
        // We could integrate with ModeAnalytics here for richer data
        setSessionStats((prev) => prev); // Placeholder for real integration
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [config]);

  return (
    <Box flexDirection="column">
      <StatRow label="Session duration:" value={sessionStats.duration} />
      <StatRow label="Tool calls:" value={String(sessionStats.toolCalls)} />
      <StatRow
        label="Files modified:"
        value={String(sessionStats.filesModified)}
      />
    </Box>
  );
};

// ============================================================================
// Main Dashboard Component
// ============================================================================

interface ModeDashboardProps {
  config: Config | null;
}

/**
 * Displays a comprehensive dashboard of mode usage, parallel tasks,
 * recent activity, and session statistics.
 */
export const ModeDashboard: React.FC<ModeDashboardProps> = ({ config }) => {
  const [recentActivities] = useState<ActivityEntry[]>([
    // Placeholder - would be populated from ModeAnalytics or session history
    {
      timestamp: new Date(Date.now() - 5 * 60 * 1000),
      type: 'mode_switch',
      description: 'Switched to current mode',
    },
  ]);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
    >
      <Text bold color={theme.text.accent}>
        {t('Mode Dashboard')}
      </Text>
      <Box height={1} />

      {/* Current Mode */}
      <Section title="Current Mode" icon="🎯">
        <CurrentModeDisplay config={config} />
      </Section>

      {/* Parallel Tasks */}
      <Section title="Parallel Tasks" icon="⚡">
        <ParallelTasksDisplay config={config} />
      </Section>

      {/* Session Statistics */}
      <Section title="Session Statistics" icon="📊">
        <ModeStatsDisplay config={config} />
      </Section>

      {/* Recent Activity */}
      <Section title="Recent Activity" icon="🕒">
        <RecentActivityDisplay activities={recentActivities} />
      </Section>
    </Box>
  );
};
