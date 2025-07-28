/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import React from 'react';
import { SlashCommand } from '../commands/types.js';
import { Colors } from '../colors.js';
import { useLanguage } from '../contexts/LanguageContext.js';

interface HelpProps {
  commands: SlashCommand[];
}

export const Help = ({ commands }: HelpProps) => {
  const { t } = useLanguage();

  return (
    <Box flexDirection="column" marginBottom={1} borderColor={Colors.Gray} borderStyle="round" padding={1}>
      <Text bold color={Colors.Foreground}>
        {t('help.basics')}
      </Text>
      <Text color={Colors.Foreground}>
        <Text bold color={Colors.AccentPurple}>
          {t('help.addContext')}
        </Text>
        : Use{' '}
        <Text bold color={Colors.AccentPurple}>
          @
        </Text>{' '}
        to specify files for context (e.g.,{' '}
        <Text bold color={Colors.AccentPurple}>
          @src/myFile.ts
        </Text>
        ) to target specific files or folders.
      </Text>
      <Text color={Colors.Foreground}>
        <Text bold color={Colors.AccentPurple}>
          {t('help.shellMode')}
        </Text>
        : Execute shell commands via{' '}
        <Text bold color={Colors.AccentPurple}>
          !
        </Text>{' '}
        (e.g.,{' '}
        <Text bold color={Colors.AccentPurple}>
          !npm run start
        </Text>
        ) or use natural language (e.g.{' '}
        <Text bold color={Colors.AccentPurple}>
          start server
        </Text>
        ).
      </Text>
      <Box height={1} />
      <Text bold color={Colors.Foreground}>
        {t('help.commands')}
      </Text>
      {commands.map((command, index) => (
        <Box key={index} marginLeft={2}>
          <Text color={Colors.AccentBlue}>
            <Text bold>/{command.name}</Text>
            {command.altName && (
              <Text color={Colors.Gray}> (or /{command.altName})</Text>
            )}
          </Text>
          {command.description && (
            <Text color={Colors.Foreground}> - {command.description}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
};
