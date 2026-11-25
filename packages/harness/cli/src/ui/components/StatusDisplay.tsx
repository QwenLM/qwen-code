/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { ENV_WRITE_SYSTEM_MD, isAgentSessionsEnabled } from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import {
  ContextSummaryDisplay,
  buildContextSummaryString,
} from './ContextSummaryDisplay.js';
import { getBackgroundTaskStatusCount } from '../utils/backgroundTaskStatus.js';
import { UpdateStatusBar } from './UpdateStatusBar.js';
import { useI18nService } from '../i18n/index.js';

export interface StatusDisplayProps {
  hideContextSummary: boolean;
}

export const StatusDisplay: React.FC<StatusDisplayProps> = ({
  hideContextSummary,
}) => {
  const i18n = useI18nService();
  const uiState = useUIState();
  const settings = useSettings();
  const config = useConfig();

  const summaryHidden =
    settings.merged.ui.hideContextSummary || hideContextSummary;

  const projectedBackgroundProcessCount = getBackgroundTaskStatusCount({
    tasks: uiState.unifiedTasks ?? [],
    excludeAgentSessionRailTasks: isAgentSessionsEnabled(),
  });
  const hasTaskProjectionInput = (uiState.unifiedTasks?.length ?? 0) > 0;
  const backgroundProcessCount = hasTaskProjectionInput
    ? projectedBackgroundProcessCount
    : uiState.unifiedRunningCount;

  const summaryProps = {
    memoryMdFileCount: uiState.memoryMdFileCount,
    contextFileNames: uiState.contextFileNames,
    mcpServers: config.getMcpClientManager()?.getMcpServers() ?? {},
    blockedMcpServers:
      config.getMcpClientManager()?.getBlockedMcpServers() ?? [],
    failedMcpServerCount:
      config.getMcpClientManager()?.getMcpConfigurationErrorCount() ?? 0,
    needsAuthServerCount:
      config.getMcpClientManager()?.getNeedsAuthServerCount() ?? 0,
    skillCount: config.getSkillManager().getDisplayableSkills().length,
    backgroundProcessCount,
  };

  if (process.env[ENV_WRITE_SYSTEM_MD]) {
    return <Text color={theme.status.error}>|⌐■_■|</Text>;
  }
  if (uiState.updateInfo?.status !== undefined) {
    return <UpdateStatusBar />;
  }
  if (
    summaryHidden ||
    buildContextSummaryString(summaryProps, i18n.get).length === 0
  ) {
    return null;
  }
  return <ContextSummaryDisplay {...summaryProps} />;
};
