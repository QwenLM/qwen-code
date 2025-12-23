/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type { SkillWithScope, StepNavigationProps } from '../types.js';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';

interface SkillDeleteStepProps extends StepNavigationProps {
  selectedSkill: SkillWithScope | null;
  onDelete: (skill: SkillWithScope) => Promise<void>;
}

export function SkillDeleteStep({
  selectedSkill,
  onDelete,
  onNavigateBack,
}: SkillDeleteStepProps) {
  useKeypress(
    async (key) => {
      if (!selectedSkill) return;

      if (key.name === 'y' || key.name === 'return') {
        try {
          await onDelete(selectedSkill);
        } catch (error) {
          console.error('Failed to delete skill:', error);
        }
      } else if (key.name === 'n' || key.name === 'escape') {
        onNavigateBack();
      }
    },
    { isActive: true },
  );

  if (!selectedSkill) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('skills.noSkillSelected')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={theme.status.error}>
        {t('skills.deleteConfirmation', {
          name: selectedSkill.metadata.name,
        })}
      </Text>
    </Box>
  );
}
