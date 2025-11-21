/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { Colors } from '../colors.js';
import {
  RadioButtonSelect,
  type RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';

export enum QuitChoice {
  CANCEL = 'cancel',
  QUIT = 'quit',
  SAVE_AND_QUIT = 'save_and_quit',
  SUMMARY_AND_QUIT = 'summary_and_quit',
}

interface QuitConfirmationDialogProps {
  onSelect: (choice: QuitChoice) => void;
}

export const QuitConfirmationDialog: React.FC<QuitConfirmationDialogProps> = ({
  onSelect,
}) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSelect(QuitChoice.CANCEL);
      }
    },
    { isActive: true },
  );

  const options: Array<RadioSelectItem<QuitChoice>> = [
    {
      key: 'quit',
      label: t('Quit immediately (/quit)'),
      value: QuitChoice.QUIT,
    },
    {
      key: 'summary-and-quit',
      label: t('Generate summary and quit (/summary)'),
      value: QuitChoice.SUMMARY_AND_QUIT,
    },
    {
      key: 'save-and-quit',
      label: t('Save conversation and quit (/chat save)'),
      value: QuitChoice.SAVE_AND_QUIT,
    },
    {
      key: 'cancel',
      label: t('Cancel (stay in application)'),
      value: QuitChoice.CANCEL,
    },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentYellow}
      padding={1}
      width="100%"
      marginLeft={1}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text>{t('What would you like to do before exiting?')}</Text>
      </Box>

      <RadioButtonSelect items={options} onSelect={onSelect} isFocused />
    </Box>
  );
};
