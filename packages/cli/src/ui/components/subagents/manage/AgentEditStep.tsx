/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { MANAGEMENT_STEPS } from '../types.js';
import { theme } from '../../../semantic-colors.js';
import { useLaunchEditor } from '../../../hooks/useLaunchEditor.js';
import { type SubagentConfig } from '@qwen-code/qwen-code-core';
import { t } from '../../../../i18n/index.js';

interface EditOption {
  id: string;
  label: string;
}

const editOptions: EditOption[] = [
  {
    id: 'editor',
    get label() {
      return t('Open in editor');
    },
  },
  {
    id: 'tools',
    get label() {
      return t('Edit tools');
    },
  },
  {
    id: 'color',
    get label() {
      return t('Edit color');
    },
  },
];

interface EditOptionsStepProps {
  selectedAgent: SubagentConfig | null;
  onNavigateToStep: (step: string) => void;
}

/**
 * Edit options selection step - choose what to edit about the agent.
 */
export function EditOptionsStep({
  selectedAgent,
  onNavigateToStep,
}: EditOptionsStepProps) {
  const [selectedOption, setSelectedOption] = useState<string>('editor');
  const [error, setError] = useState<string | null>(null);

  const launchEditor = useLaunchEditor();

  const handleHighlight = (selectedValue: string) => {
    setSelectedOption(selectedValue);
  };

  const handleSelect = useCallback(
    async (selectedValue: string) => {
      if (!selectedAgent) return;

      setError(null);

      if (selectedValue === 'editor') {
        // Launch editor directly
        try {
          await launchEditor(selectedAgent?.filePath);
        } catch (err) {
          setError(
            t('Failed to launch editor: {{error}}', {
              error: err instanceof Error ? err.message : 'Unknown error',
            }),
          );
        }
      } else if (selectedValue === 'tools') {
        onNavigateToStep(MANAGEMENT_STEPS.EDIT_TOOLS);
      } else if (selectedValue === 'color') {
        onNavigateToStep(MANAGEMENT_STEPS.EDIT_COLOR);
      }
    },
    [selectedAgent, onNavigateToStep, launchEditor],
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
            {t('❌ Error:')}
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
