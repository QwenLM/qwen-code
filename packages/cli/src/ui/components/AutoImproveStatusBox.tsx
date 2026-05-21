/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';
import { theme } from '../semantic-colors.js';
import type { HistoryItemAutoImproveStatus } from '../types.js';

type AutoImproveStatusBoxProps = Omit<
  HistoryItemAutoImproveStatus,
  'type' | 'text'
> & {
  width?: number;
};

function getStatusColor(status: string): string {
  switch (status) {
    case 'running':
      return theme.status.success;
    case 'stopping':
    case 'stale':
      return theme.status.warning;
    case 'stopped':
      return theme.text.secondary;
    default:
      return theme.text.primary;
  }
}

const Row: React.FC<{ label: string; value: string; color?: string }> = ({
  label,
  value,
  color,
}) => (
  <Box flexDirection="row">
    <Box width={16}>
      <Text bold color={theme.text.link}>
        {label}
      </Text>
    </Box>
    <Box flexGrow={1}>
      <Text color={color ?? theme.text.primary}>{value}</Text>
    </Box>
  </Box>
);

export const AutoImproveStatusBox: React.FC<AutoImproveStatusBoxProps> = ({
  width,
  loopId,
  status,
  cadence,
  cron,
  targetBranch,
  sources,
  prompt,
  cronJobId,
  customSources,
  currentRun,
  lastRun,
}) => {
  const statusColor = getStatusColor(status);

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width={width}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.text.accent}>
          {t('Auto-Improve')}
        </Text>
        <Text color={theme.text.secondary}> </Text>
        <Text color={statusColor}>{status}</Text>
      </Box>

      <Row label={t('Loop')} value={loopId} />
      <Row label={t('Cadence')} value={`${cadence} (${cron})`} />
      <Row label={t('Target')} value={targetBranch} />
      <Row label={t('Sources')} value={sources} />
      <Row label={t('Cron job')} value={cronJobId ?? t('none')} />

      <Box marginTop={1} flexDirection="column">
        <Text bold color={theme.text.link}>
          {t('Prompt')}
        </Text>
        <Box marginLeft={2}>
          <Text color={theme.text.primary}>{prompt || t('(none)')}</Text>
        </Box>
      </Box>

      {customSources.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.text.link}>
            {t('Custom sources')}
          </Text>
          {customSources.map((source) => (
            <Box key={source} marginLeft={2}>
              <Text color={theme.text.primary}>{`- ${source}`}</Text>
            </Box>
          ))}
        </Box>
      )}

      {(currentRun || lastRun) && (
        <Box marginTop={1} flexDirection="column">
          {currentRun && <Row label={t('Current run')} value={currentRun} />}
          {lastRun && <Row label={t('Last run')} value={lastRun} />}
        </Box>
      )}
    </Box>
  );
};
