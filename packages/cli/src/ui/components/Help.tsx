/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { type SlashCommand, CommandKind } from '../commands/types.js';
import { t } from '../../i18n/index.js';

interface Help {
  commands: readonly SlashCommand[];
}

export const Help: React.FC<Help> = ({ commands }) => (
  <Box
    flexDirection="column"
    marginBottom={1}
    borderColor={theme.border.default}
    borderStyle="round"
    padding={1}
  >
    {/* Basics */}
    <Text bold color={theme.text.primary}>
      {t('Basics:')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('Add context')}
      </Text>
      :{' '}
      {t(
        'Use {{symbol}} to specify files for context (e.g., {{example}}) to target specific files or folders.',
        {
          symbol: t('@'),
          example: t('@src/myFile.ts'),
        },
      )}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('Shell mode')}
      </Text>
      :{' '}
      {t(
        'Execute shell commands via {{symbol}} (e.g., {{example1}}) or use natural language (e.g., {{example2}}).',
        {
          symbol: t('!'),
          example1: t('!npm run start'),
          example2: t('start server'),
        },
      )}
    </Text>

    <Box height={1} />

    {/* Commands */}
    <Text bold color={theme.text.primary}>
      {t('Commands:')}
    </Text>
    {commands
      .filter((command) => command.description && !command.hidden)
      .map((command: SlashCommand) => (
        <Box key={command.name} flexDirection="column">
          <Text color={theme.text.primary}>
            <Text bold color={theme.text.accent}>
              {' '}
              /{command.name}
            </Text>
            {command.kind === CommandKind.MCP_PROMPT && (
              <Text color={theme.text.secondary}> [MCP]</Text>
            )}
            {command.description && ' - ' + command.description}
          </Text>
          {command.subCommands &&
            command.subCommands
              .filter((subCommand) => !subCommand.hidden)
              .map((subCommand) => (
                <Text key={subCommand.name} color={theme.text.primary}>
                  <Text bold color={theme.text.accent}>
                    {'   '}
                    {subCommand.name}
                  </Text>
                  {subCommand.description && ' - ' + subCommand.description}
                </Text>
              ))}
        </Box>
      ))}
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {' '}
        !{' '}
      </Text>
      - {t('shell command')}
    </Text>
    <Text color={theme.text.primary}>
      <Text color={theme.text.secondary}>[MCP]</Text> -{' '}
      {t('Model Context Protocol command (from external servers)')}
    </Text>

    <Box height={1} />

    {/* Shortcuts */}
    <Text bold color={theme.text.primary}>
      {t('Keyboard Shortcuts:')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        Alt+Left/Right
      </Text>{' '}
      - {t('Jump through words in the input')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        Ctrl+C
      </Text>{' '}
      - {t('Close dialogs, cancel requests, or quit application')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {process.platform === 'win32' ? 'Ctrl+Enter' : 'Ctrl+J'}
      </Text>{' '}
      -{' '}
      {process.platform === 'linux'
        ? t('New line (Alt+Enter works for certain linux distros)')
        : t('New line')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        Ctrl+L
      </Text>{' '}
      - {t('Clear the screen')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {process.platform === 'darwin' ? 'Ctrl+X / Meta+Enter' : 'Ctrl+X'}
      </Text>{' '}
      - {t('Open input in external editor')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        Enter
      </Text>{' '}
      - {t('Send message')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        Esc
      </Text>{' '}
      - {t('Cancel operation / Clear input (double press)')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        Shift+Tab
      </Text>{' '}
      - {t('Cycle approval modes')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        Up/Down
      </Text>{' '}
      - {t('Cycle through your prompt history')}
    </Text>
    <Box height={1} />
    <Text color={theme.text.primary}>
      {t('For a full list of shortcuts, see {{docPath}}', {
        docPath: t('docs/keyboard-shortcuts.md'),
      })}
    </Text>
  </Box>
);
