/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * web-shell's host renderer for slash-command / session-control system messages.
 * Injected into `@qwen-code/chat-panel` via `ChatPanelProviders`; the panel calls
 * it before its generic system rendering and falls through when it returns null.
 * These renderers carry daemon-coupled types and stay in web-shell (out of the
 * shared panel's scope).
 */
import type { ReactNode } from 'react';
import type { SystemMessageInfo } from '@qwen-code/chat-panel';
import {
  ContextUsageMessage,
  parseContextUsageMessage,
} from './ContextUsageMessage';
import { StatsMessage, parseStatsMessage } from './StatsMessage';
import { StatusMessage, parseStatusMessage } from './StatusMessage';
import { McpStatusMessage, parseMcpStatusMessage } from './McpStatusMessage';
import {
  TasksStatusMessage,
  parseTasksStatusMessage,
} from './TasksStatusMessage';
import { GoalStatusMessage, parseGoalStatusMessage } from './GoalStatusMessage';

export function renderWebShellSystemMessage(
  info: SystemMessageInfo,
): ReactNode | null {
  const { content, variant, source, data, isLatest, onShowContextDetail } =
    info;
  if (variant !== 'info') return null;

  const contextUsage = parseContextUsageMessage(content);
  if (contextUsage) {
    return (
      <ContextUsageMessage
        status={contextUsage}
        onShowDetail={onShowContextDetail}
      />
    );
  }

  const statsData = parseStatsMessage(content);
  if (statsData) {
    return <StatsMessage view={statsData.view} status={statsData.status} />;
  }

  const statusInfo = parseStatusMessage(content);
  if (statusInfo) {
    return <StatusMessage info={statusInfo} />;
  }

  const mcpStatus = parseMcpStatusMessage(content);
  if (mcpStatus) {
    return <McpStatusMessage message={mcpStatus} />;
  }

  const tasksStatus = parseTasksStatusMessage(content);
  if (tasksStatus) {
    return <TasksStatusMessage message={tasksStatus} />;
  }

  const goalStatus =
    source === 'goal'
      ? parseGoalStatusMessage(data)
      : parseGoalStatusMessage(content);
  if (goalStatus) {
    return <GoalStatusMessage status={goalStatus} activateFooter={isLatest} />;
  }

  return null;
}
