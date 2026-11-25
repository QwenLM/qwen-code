/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { theme } from '../semantic-colors.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from '../components/shared/RadioButtonSelect.js';
import { BaseTabDialog } from '../components/shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';

export type AddDirTrustChoice = 'memory' | 'persist';

interface AddDirTrustSelectorProps {
  directory: string;
  onSelect: (choice: AddDirTrustChoice) => void;
  onClose: () => void;
}

export const AddDirTrustSelector: React.FC<AddDirTrustSelectorProps> = ({
  directory,
  onSelect,
  onClose,
}) => {
  const options: Array<RadioSelectItem<AddDirTrustChoice>> = [
    {
      label: 'Trust (this session only)',
      value: 'memory',
      key: 'memory',
      sublabel: 'Add to workspace context in memory only — not saved to disk.',
    },
    {
      label: 'Trust (remember across sessions)',
      value: 'persist',
      key: 'persist',
      sublabel:
        'Add to workspace context and save to settings.local.json so it is remembered across sessions.',
    },
  ];

  return (
    <BaseTabDialog
      title="Add Directory"
      tabs={[]}
      activeKey=""
      onTabChange={() => {}}
      onClose={onClose}
      extraHints={[{ label: SHORTCUT_HINTS.SELECT, order: 30 }]}
    >
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            How do you want to trust this directory?
          </Text>
          <Text color={theme.text.secondary}>{directory}</Text>
        </Box>

        <RadioButtonSelect items={options} onSelect={onSelect} isFocused />
      </Box>
    </BaseTabDialog>
  );
};
