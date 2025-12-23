/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import path from 'path';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { theme } from '../../../semantic-colors.js';
import { useLaunchEditor } from '../../../hooks/useLaunchEditor.js';
import type { SkillWithScope } from '../types.js';
import { t } from '../../../../i18n/index.js';
import { MANAGEMENT_STEPS } from '../types.js';

interface EditOption {
  id: string;
  label: string;
}

interface EditOptionsStepProps {
  selectedSkill: SkillWithScope | null;
  onNavigateToStep: (step: string) => void;
}

export function EditOptionsStep({
  selectedSkill,
  onNavigateToStep,
}: EditOptionsStepProps) {
  const [selectedOption, setSelectedOption] = useState<string>('editor');
  const [error, setError] = useState<string | null>(null);

  const launchEditor = useLaunchEditor();

  const editOptions: EditOption[] = [
    {
      id: 'editor',
      label: t('skills.openInEditor'),
    },
    {
      id: 'color',
      label: t('Edit color'),
    },
  ];

  const handleHighlight = (selectedValue: string) => {
    setSelectedOption(selectedValue);
  };

  const handleSelect = useCallback(
    async (selectedValue: string) => {
      if (!selectedSkill) return;

      setError(null);

      if (selectedValue === 'editor') {
        try {
          const skillFilePath = path.join(selectedSkill.path, 'SKILL.md');
          await launchEditor(skillFilePath);
        } catch (err) {
          setError(
            t('skills.error.launchEditor', {
              error: err instanceof Error ? err.message : 'Unknown error',
            }),
          );
        }
      } else if (selectedValue === 'color') {
        onNavigateToStep(MANAGEMENT_STEPS.EDIT_COLOR);
      }
    },
    [selectedSkill, launchEditor, onNavigateToStep],
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <RadioButtonSelect
          items={editOptions.map((option) => ({
            key: option.id,
            label: option.label,
            value: option.id,
          }))}
          initialIndex={editOptions.findIndex(
            (opt) => opt.id === selectedOption,
          )}
          onSelect={handleSelect}
          onHighlight={handleHighlight}
          isFocused={true}
        />
      </Box>

      {error && (
        <Box flexDirection="column">
          <Text bold color={theme.status.error}>
            {t('skills.error.generic')}
          </Text>
          <Box flexDirection="column" padding={1} paddingBottom={0}>
            <Text color={theme.status.error} wrap="wrap">
              {error}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
