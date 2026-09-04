/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

const EXIT_INDEX = 0;
const CONTINUE_INDEX = 1;

interface SettingsCorruptedDialogProps {
  corruptedPath: string;
  wasRecovered: boolean;
  onExit: () => void;
  onContinue: () => void;
}

export const SettingsCorruptedDialog: React.FC<
  SettingsCorruptedDialogProps
> = ({ corruptedPath, wasRecovered, onExit, onContinue }) => {
  const [selectedIndex, setSelectedIndex] = useState(EXIT_INDEX);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onContinue();
        return;
      }
      if (key.ctrl && key.name === 'c') {
        onExit();
        return;
      }
      if (key.name === 'up') {
        setSelectedIndex(EXIT_INDEX);
      }
      if (key.name === 'down') {
        setSelectedIndex(CONTINUE_INDEX);
      }
      if (key.name === 'return') {
        if (selectedIndex === EXIT_INDEX) {
          onExit();
        } else {
          onContinue();
        }
      }
    },
    { isActive: true },
  );

  const continueLabel = wasRecovered
    ? t('Continue with recovered settings (esc)')
    : t('Continue with empty settings (esc)');

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.error}
      padding={1}
      width="100%"
      marginLeft={1}
    >
      <Box marginBottom={1} flexDirection="column">
        <Text>
          <Text color={theme.status.error}>{'> '}</Text>
          <Text bold color={theme.status.error}>
            {t('Settings file corrupted')}
          </Text>
        </Text>
        <Text color={theme.text.secondary}>
          {t(
            'Your settings file had invalid JSON. A copy of the corrupted file has been saved for reference.',
          )}
        </Text>
        <Text color={theme.text.secondary}>{corruptedPath}</Text>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text>
            {selectedIndex === EXIT_INDEX ? (
              <Text color={theme.status.success}>{'> '}</Text>
            ) : (
              '  '
            )}
          </Text>
          <Text
            color={
              selectedIndex === EXIT_INDEX
                ? theme.status.success
                : theme.text.primary
            }
          >
            {t('Exit and restore corrupted file')}
          </Text>
        </Box>
        <Box>
          <Text>
            {selectedIndex === CONTINUE_INDEX ? (
              <Text color={theme.status.success}>{'> '}</Text>
            ) : (
              '  '
            )}
          </Text>
          <Text
            color={
              selectedIndex === CONTINUE_INDEX
                ? theme.status.success
                : theme.text.primary
            }
          >
            {continueLabel}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
