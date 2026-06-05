/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import { Box, Text } from 'ink';
import type React from 'react';
import { theme } from '../semantic-colors.js';
import type { RadioSelectItem } from './shared/RadioButtonSelect.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { MaxSizedBox } from './shared/MaxSizedBox.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';

// Border, title, subtitle, question, and option rows that must remain visible.
const SHELL_CONFIRMATION_FIXED_ROWS = 9;

export interface ShellConfirmationRequest {
  commands: string[];
  onConfirm: (
    outcome: ToolConfirmationOutcome,
    approvedCommands?: string[],
  ) => void;
}

export interface ShellConfirmationDialogProps {
  request: ShellConfirmationRequest;
  availableTerminalHeight?: number;
  contentWidth?: number;
}

export const ShellConfirmationDialog: React.FC<
  ShellConfirmationDialogProps
> = ({ request, availableTerminalHeight, contentWidth = 80 }) => {
  const { commands, onConfirm } = request;
  const constrainedHeight = clampDialogHeight(availableTerminalHeight);
  const commandPreviewHeight =
    constrainedHeight === undefined
      ? undefined
      : constrainedHeight >= SHELL_CONFIRMATION_FIXED_ROWS + 2
        ? Math.max(2, constrainedHeight - SHELL_CONFIRMATION_FIXED_ROWS)
        : 0;
  const commandsHidden =
    constrainedHeight !== undefined &&
    commandPreviewHeight === 0 &&
    commands.length > 0;
  const compactHiddenCommandsLayout =
    commandsHidden && constrainedHeight <= SHELL_CONFIRMATION_FIXED_ROWS;

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onConfirm(ToolConfirmationOutcome.Cancel);
      }
    },
    { isActive: true },
  );

  const handleSelect = (item: ToolConfirmationOutcome) => {
    if (item === ToolConfirmationOutcome.Cancel) {
      onConfirm(item);
    } else {
      // For both ProceedOnce and ProceedAlways, we approve all the
      // commands that were requested.
      onConfirm(item, commands);
    }
  };

  const options: Array<RadioSelectItem<ToolConfirmationOutcome>> = [
    {
      label: t('Yes, allow once'),
      value: ToolConfirmationOutcome.ProceedOnce,
      key: 'Yes, allow once',
    },
    {
      label: t('Always allow in this project'),
      value: ToolConfirmationOutcome.ProceedAlwaysProject,
      key: 'Always allow in this project',
    },
    {
      label: t('Always allow for this user'),
      value: ToolConfirmationOutcome.ProceedAlwaysUser,
      key: 'Always allow for this user',
    },
    {
      label: t('No (esc)'),
      value: ToolConfirmationOutcome.Cancel,
      key: 'No (esc)',
    },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.status.warning}
      paddingX={1}
      paddingY={constrainedHeight === undefined ? 1 : 0}
      width="100%"
      marginLeft={1}
      height={constrainedHeight}
      overflow="hidden"
    >
      <Text bold color={theme.text.primary} wrap="truncate">
        {t('Shell Command Execution')}
      </Text>
      {!compactHiddenCommandsLayout && (
        <Text color={theme.text.primary} wrap="truncate">
          {t('A custom command wants to run the following shell commands:')}
        </Text>
      )}
      {constrainedHeight === undefined ? (
        <Box
          flexDirection="column"
          marginTop={1}
          marginBottom={1}
          flexShrink={1}
        >
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.border.default}
            paddingX={1}
          >
            {commands.map((cmd) => (
              <Text key={cmd} color={theme.text.link}>
                {cmd}
              </Text>
            ))}
          </Box>
        </Box>
      ) : commandPreviewHeight !== undefined && commandPreviewHeight > 0 ? (
        <Box flexDirection="column" flexShrink={1}>
          <MaxSizedBox
            maxHeight={commandPreviewHeight}
            maxWidth={Math.max(1, contentWidth - 8)}
            overflowDirection="top"
          >
            {commands.map((cmd) => (
              <Box key={cmd}>
                <Text color={theme.text.link}>{cmd}</Text>
              </Box>
            ))}
          </MaxSizedBox>
        </Box>
      ) : commandsHidden ? (
        <Text color={theme.status.warning} wrap="truncate">
          {commands.length}{' '}
          {t('shell commands hidden - resize terminal to review')}
        </Text>
      ) : null}

      {!compactHiddenCommandsLayout && (
        <Box
          marginBottom={constrainedHeight === undefined ? 1 : 0}
          flexShrink={0}
        >
          <Text color={theme.text.primary}>{t('Do you want to proceed?')}</Text>
        </Box>
      )}

      <Box flexShrink={0}>
        <RadioButtonSelect items={options} onSelect={handleSelect} isFocused />
      </Box>
    </Box>
  );
};
