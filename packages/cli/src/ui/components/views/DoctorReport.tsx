/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { DoctorCheckResult, DoctorCheckStatus } from '../../types.js';
import { t } from '../../../i18n/index.js';

interface DoctorReportProps {
  checks: DoctorCheckResult[];
  summary: { pass: number; warn: number; fail: number };
  width?: number;
}

const STATUS_ICONS: Record<DoctorCheckStatus, string> = {
  pass: '\u2713', // checkmark
  warn: '\u26A0', // warning triangle
  fail: '\u2717', // X mark
};

function getStatusColor(status: DoctorCheckStatus): string {
  switch (status) {
    case 'pass':
      return theme.status.success;
    case 'warn':
      return theme.status.warning;
    case 'fail':
      return theme.status.error;
    default:
      return theme.text.primary;
  }
}

/**
 * Group checks by category, preserving insertion order.
 */
function groupByCategory(
  checks: DoctorCheckResult[],
): Map<string, DoctorCheckResult[]> {
  const groups = new Map<string, DoctorCheckResult[]>();
  for (const check of checks) {
    const group = groups.get(check.category);
    if (group) {
      group.push(check);
    } else {
      groups.set(check.category, [check]);
    }
  }
  return groups;
}

export const DoctorReport: React.FC<DoctorReportProps> = ({
  checks,
  summary,
  width,
}) => {
  const groups = groupByCategory(checks);
  const categoryEntries = Array.from(groups.entries());

  // Compute the widest check name so the message column aligns consistently.
  const nameColWidth = Math.max(20, ...checks.map((c) => c.name.length + 2));

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
      width={width}
    >
      <Text bold color={theme.text.accent}>
        {t('Doctor Report')}
      </Text>
      <Box height={1} />

      {categoryEntries.map(([category, items], groupIdx) => (
        <Box
          key={category}
          flexDirection="column"
          marginTop={groupIdx > 0 ? 1 : 0}
        >
          <Text bold color={theme.text.link}>
            {category}
          </Text>
          {items.map((check) => (
            <Box key={`${category}-${check.name}`} flexDirection="column">
              <Box flexDirection="row">
                <Text color={getStatusColor(check.status)}>
                  {'  '}
                  {STATUS_ICONS[check.status]}{' '}
                </Text>
                <Box width={nameColWidth}>
                  <Text color={theme.text.primary}>{check.name}</Text>
                </Box>
                <Text dimColor>{check.message}</Text>
              </Box>
              {check.detail && (
                <Box marginLeft={6}>
                  <Text dimColor>
                    {'-> '}
                    {check.detail}
                  </Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      ))}

      <Box marginTop={1}>
        <Text dimColor>{'-- '}</Text>
        <Text color={theme.status.success}>
          {summary.pass} {t('passed')}
        </Text>
        <Text dimColor>{', '}</Text>
        <Text color={theme.status.warning}>
          {summary.warn} {t('warnings')}
        </Text>
        <Text dimColor>{', '}</Text>
        <Text color={theme.status.error}>
          {summary.fail} {t('failures')}
        </Text>
      </Box>
    </Box>
  );
};
