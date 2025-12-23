/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import type { SkillWithScope } from '../types.js';
import { t } from '../../../../i18n/index.js';

interface SkillViewerStepProps {
  selectedSkill: SkillWithScope | null;
}

export const SkillViewerStep = ({ selectedSkill }: SkillViewerStepProps) => {
  if (!selectedSkill) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('skills.noSkillSelected')}</Text>
      </Box>
    );
  }

  const skill = selectedSkill;

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text color={theme.text.primary}>{t('skills.path')}</Text>
          <Text>{skill.path}</Text>
        </Box>

        <Box>
          <Text color={theme.text.primary}>{t('skills.scope')}</Text>
          <Text>{skill.scope}</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('Description:')}</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">{skill.metadata.description}</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('skills.instructions')}</Text>
        </Box>
        <Box padding={1} paddingBottom={0}>
          <Text wrap="wrap">{skill.instructions}</Text>
        </Box>
      </Box>
    </Box>
  );
};
