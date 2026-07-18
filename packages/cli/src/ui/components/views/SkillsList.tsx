/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { SkillLevel } from '@qwen-code/qwen-code-core';
import { type SkillDefinition } from '../../types.js';
import { t } from '../../../i18n/index.js';
import { levelLabel } from '../../utils/skill-level-label.js';

const NAME_COLUMN = 24;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

interface SkillsListProps {
  skills: readonly SkillDefinition[];
}

export const SkillsList: React.FC<SkillsListProps> = ({ skills }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color={theme.text.primary}>
      {t('Available skills:')}
    </Text>
    <Box height={1} />
    {skills.length > 0 ? (
      skills.map((skill) => (
        <Box key={skill.name} flexDirection="row">
          <Text color={theme.text.primary}>{'  '}- </Text>
          <Text bold color={theme.text.accent}>
            {skill.description
              ? truncate(skill.name, NAME_COLUMN).padEnd(NAME_COLUMN)
              : skill.name}
          </Text>
          {skill.description && (
            <Text color={theme.text.secondary}>
              {' '}
              {truncate(skill.description, 80)}
            </Text>
          )}
          {skill.level && (
            <Text color={theme.text.secondary}>
              {'  '}({levelLabel(skill.level as SkillLevel)})
            </Text>
          )}
        </Box>
      ))
    ) : (
      <Text color={theme.text.primary}> {t('No skills available')}</Text>
    )}
  </Box>
);
