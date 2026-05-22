/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { t } from '../../i18n/index.js';
import { theme } from '../semantic-colors.js';
import type {
  HistoryItemAutoImproveRun,
  HistoryItemAutoImproveStatus,
} from '../types.js';

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

function getRunStatusColor(status: string): string {
  switch (status) {
    case 'success':
      return theme.status.success;
    case 'failed':
    case 'blocked':
      return theme.status.error;
    case 'cancelled':
      return theme.status.warning;
    default:
      return theme.text.primary;
  }
}

function getRunTitle(run: HistoryItemAutoImproveRun): string {
  if (run.issueNumber !== undefined) return `issue #${run.issueNumber}`;
  if (run.prNumber !== undefined) return `PR #${run.prNumber}`;
  return run.source ?? t('run');
}

const RunField: React.FC<{ label: string; value: string; color?: string }> = ({
  label,
  value,
  color,
}) => (
  <Box marginLeft={2} flexDirection="row">
    <Box width={10}>
      <Text color={theme.text.secondary}>{label}</Text>
    </Box>
    <Box flexGrow={1}>
      <Text color={color ?? theme.text.primary}>{value}</Text>
    </Box>
  </Box>
);

const RecentRun: React.FC<{ run: HistoryItemAutoImproveRun }> = ({ run }) => (
  <Box marginLeft={2} marginTop={1} flexDirection="column">
    <Box flexDirection="row">
      <Text color={getRunStatusColor(run.status)}>{t(run.status)}</Text>
      <Text color={theme.text.secondary}> · </Text>
      <Text color={theme.text.accent}>{getRunTitle(run)}</Text>
    </Box>
    {run.task && (
      <Box marginLeft={2}>
        <Text color={theme.text.primary}>{run.task}</Text>
      </Box>
    )}
    {run.branch && (
      <RunField
        label={t('Branch')}
        value={run.branch}
        color={theme.text.accent}
      />
    )}
    {run.commit && (
      <RunField label={t('Commit')} value={run.commit.slice(0, 12)} />
    )}
    {run.runDoc && <RunField label={t('Run doc')} value={run.runDoc} />}
  </Box>
);

export const AutoImproveStatusBox: React.FC<AutoImproveStatusBoxProps> = ({
  width,
  loopId,
  status,
  statusNote,
  cadence,
  cron,
  targetBranch,
  sources,
  prompt,
  cronJobId,
  customSources,
  currentRun,
  lastRun,
  recentRuns,
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
        <Text color={statusColor}>{t(status)}</Text>
      </Box>

      <Row label={t('Loop')} value={loopId} />
      <Row label={t('Cadence')} value={`${cadence} (${cron})`} />
      <Row label={t('Default branch')} value={targetBranch} />
      <Row label={t('Sources')} value={sources} />
      <Row label={t('Cron job')} value={cronJobId ?? t('none')} />
      {statusNote && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{statusNote}</Text>
        </Box>
      )}

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

      {recentRuns && recentRuns.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.text.link}>
            {t('Recent runs')}
          </Text>
          {recentRuns.map((run, index) => (
            <RecentRun
              key={`${run.issueNumber ?? run.prNumber ?? run.source ?? 'run'}-${
                run.branch ?? run.commit ?? index
              }`}
              run={run}
            />
          ))}
        </Box>
      )}
    </Box>
  );
};
