/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { useState } from 'react';
import { theme } from '../semantic-colors.js';
import { TextInput } from './shared/TextInput.js';
import { t } from '../../i18n/index.js';
import { useKeypress, type Key } from '../hooks/useKeypress.js';
import chalk from 'chalk';

type SettingInputPromptProps = {
  settingName: string;
  settingDescription: string;
  sensitive: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  terminalWidth: number;
};

/**
 * A simple password input component that masks the input with asterisks.
 */
const PasswordInput = ({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
}) => {
  useKeypress(
    (key: Key) => {
      // Handle submit
      if (key.name === 'return') {
        onSubmit();
        return;
      }

      // Handle backspace
      if (key.name === 'backspace' || key.name === 'delete') {
        onChange(value.slice(0, -1));
        return;
      }

      // Handle clear (Ctrl+U)
      if (key.ctrl && key.name === 'u') {
        onChange('');
        return;
      }

      // Handle printable characters
      if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
        const charCode = key.sequence.charCodeAt(0);
        // Only accept printable ASCII characters (32-126)
        if (charCode >= 32 && charCode <= 126) {
          onChange(value + key.sequence);
        }
      }
    },
    { isActive: true },
  );

  const maskedValue = '*'.repeat(value.length);
  const displayValue = maskedValue || '';
  const cursorChar = chalk.inverse(' ');

  return (
    <Box>
      <Text color={theme.text.accent}>{'> '}</Text>
      {value.length === 0 ? (
        <Text>
          {cursorChar}
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      ) : (
        <Text>
          {displayValue}
          {cursorChar}
        </Text>
      )}
    </Box>
  );
};

export const SettingInputPrompt = (props: SettingInputPromptProps) => {
  const {
    settingName,
    settingDescription,
    sensitive,
    onSubmit,
    onCancel,
    terminalWidth,
  } = props;

  const [value, setValue] = useState('');

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onCancel();
      }
    },
    { isActive: true },
  );

  const handleSubmit = () => {
    if (value.trim()) {
      onSubmit(value);
    }
  };

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
    >
      <Text bold color={theme.text.accent}>
        {settingName}
      </Text>
      <Box marginTop={1}>
        <Text>{settingDescription}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {sensitive ? (
          <PasswordInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder={t('Enter sensitive value...')}
          />
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder={t('Enter value...')}
            inputWidth={Math.min(terminalWidth - 10, 60)}
            isActive={true}
          />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{t('Press Enter to submit, Escape to cancel')}</Text>
      </Box>
    </Box>
  );
};
