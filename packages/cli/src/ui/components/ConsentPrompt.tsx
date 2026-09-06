/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { type ReactNode } from 'react';
import { theme } from '../semantic-colors.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { t } from '../../i18n/index.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';

type ConsentPromptProps = {
  // If a simple string is given, it will render using markdown by default.
  prompt: ReactNode;
  onConfirm: (value: boolean) => void;
  terminalWidth: number;
  availableTerminalHeight?: number;
};

// Border, vertical padding, option margin, and two Yes/No option rows.
const CONSENT_PROMPT_CHROME_ROWS = 7;

export const ConsentPrompt = (props: ConsentPromptProps) => {
  const { prompt, onConfirm, terminalWidth, availableTerminalHeight } = props;
  const constrainedHeight = clampDialogHeight(availableTerminalHeight);
  const availablePromptRows =
    constrainedHeight === undefined
      ? undefined
      : Math.max(1, constrainedHeight - CONSENT_PROMPT_CHROME_ROWS);
  const showPromptTruncationNotice =
    typeof prompt === 'string' &&
    availablePromptRows !== undefined &&
    availablePromptRows <= 2;
  const promptHeight =
    availablePromptRows === undefined
      ? undefined
      : Math.max(1, availablePromptRows - (showPromptTruncationNotice ? 1 : 0));

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
      height={constrainedHeight}
      overflow="hidden"
    >
      <Box flexDirection="column" flexShrink={1} overflow="hidden">
        {typeof prompt === 'string' ? (
          <MarkdownDisplay
            isPending={true}
            text={prompt}
            contentWidth={terminalWidth}
            {...(promptHeight !== undefined
              ? { availableTerminalHeight: promptHeight }
              : {})}
          />
        ) : (
          prompt
        )}
      </Box>
      {showPromptTruncationNotice && (
        <Text color={theme.text.secondary} wrap="truncate">
          {t('Content truncated - resize terminal to review')}
        </Text>
      )}
      <Box marginTop={1} flexShrink={0}>
        <RadioButtonSelect
          items={[
            { label: 'Yes', value: true, key: 'Yes' },
            { label: 'No', value: false, key: 'No' },
          ]}
          onSelect={onConfirm}
        />
      </Box>
    </Box>
  );
};
