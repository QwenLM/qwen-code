/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import type { InitMode } from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from '../components/shared/RadioButtonSelect.js';
import { BaseTabDialog } from '../components/shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';

interface InitModeSelectorProps {
  contextFileName: string;
  onSelect: (mode: InitMode) => void;
  onClose: () => void;
}

export const InitModeSelector: React.FC<InitModeSelectorProps> = ({
  contextFileName,
  onSelect,
  onClose,
}) => {
  const options: Array<RadioSelectItem<InitMode>> = [
    {
      label: 'Quick',
      value: 'quick',
      key: 'quick',
      sublabel: `Automatically analyze the codebase and generate ${contextFileName} — no questions asked.`,
    },
    {
      label: 'Interactive',
      value: 'interactive',
      key: 'interactive',
      sublabel:
        'Interactive setup with interview, plus optional skills and hooks.',
    },
  ];

  return (
    <BaseTabDialog
      title="Init"
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onClose}
      extraHints={[{ label: SHORTCUT_HINTS.SELECT, order: 30 }]}
    >
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            How would you like to set up {contextFileName}?
          </Text>
        </Box>

        <RadioButtonSelect items={options} onSelect={onSelect} isFocused />
      </Box>
    </BaseTabDialog>
  );
};
