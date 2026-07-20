/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { SkillCallStats } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { useSessionStats } from '../contexts/SessionContext.js';
import { theme } from '../semantic-colors.js';
import {
  getStatusColor,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
} from '../utils/displayUtils.js';

const SKILL_NAME_COL_WIDTH = 30;
const CALLS_COL_WIDTH = 8;
const SUCCESS_COL_WIDTH = 8;
const FAIL_COL_WIDTH = 8;
const SUCCESS_RATE_COL_WIDTH = 15;

const StatRow: React.FC<{
  name: string;
  stats: SkillCallStats;
}> = ({ name, stats }) => {
  const successRate = stats.count > 0 ? (stats.success / stats.count) * 100 : 0;
  const successColor = getStatusColor(successRate, {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM,
  });

  return (
    <Box>
      <Box width={SKILL_NAME_COL_WIDTH}>
        <Text color={theme.text.link}>{name}</Text>
      </Box>
      <Box width={CALLS_COL_WIDTH} justifyContent="flex-end">
        <Text color={theme.text.primary}>{stats.count}</Text>
      </Box>
      <Box width={SUCCESS_COL_WIDTH} justifyContent="flex-end">
        <Text color={theme.status.success}>{stats.success}</Text>
      </Box>
      <Box width={FAIL_COL_WIDTH} justifyContent="flex-end">
        <Text color={stats.fail > 0 ? theme.status.error : theme.text.primary}>
          {stats.fail}
        </Text>
      </Box>
      <Box width={SUCCESS_RATE_COL_WIDTH} justifyContent="flex-end">
        <Text color={successColor}>{successRate.toFixed(1)}%</Text>
      </Box>
    </Box>
  );
};

interface SkillStatsDisplayProps {
  width?: number;
}

export const SkillStatsDisplay: React.FC<SkillStatsDisplayProps> = ({
  width,
}) => {
  const { stats } = useSessionStats();
  const skills = stats.metrics.skills ?? {
    totalCalls: 0,
    totalSuccess: 0,
    totalFail: 0,
    byName: {},
  };
  const activeSkills = Object.entries(skills.byName)
    .filter(([, metrics]) => metrics.count > 0)
    .sort(([leftName, left], [rightName, right]) => {
      const countDelta = right.count - left.count;
      return countDelta !== 0 ? countDelta : leftName.localeCompare(rightName);
    });

  if (activeSkills.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        paddingY={1}
        paddingX={2}
        width={width}
      >
        <Text color={theme.text.primary}>
          {t('No skill calls have been made in this session.')}
        </Text>
      </Box>
    );
  }

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
        {t('Skill Stats For Nerds')}
      </Text>
      <Box height={1} />

      <Box>
        <Box width={SKILL_NAME_COL_WIDTH}>
          <Text bold color={theme.text.primary}>
            {t('Skill Name')}
          </Text>
        </Box>
        <Box width={CALLS_COL_WIDTH} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            {t('Calls')}
          </Text>
        </Box>
        <Box width={SUCCESS_COL_WIDTH} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            {t('OK')}
          </Text>
        </Box>
        <Box width={FAIL_COL_WIDTH} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            {t('Fail')}
          </Text>
        </Box>
        <Box width={SUCCESS_RATE_COL_WIDTH} justifyContent="flex-end">
          <Text bold color={theme.text.primary}>
            {t('Success Rate')}
          </Text>
        </Box>
      </Box>

      <Box
        borderStyle="single"
        borderBottom={true}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.border.default}
        width="100%"
      />

      {activeSkills.map(([name, skillStats]) => (
        <StatRow key={name} name={name} stats={skillStats} />
      ))}
    </Box>
  );
};
