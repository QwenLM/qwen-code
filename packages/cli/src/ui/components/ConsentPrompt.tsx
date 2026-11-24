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
import { useKeypress } from '../hooks/useKeypress.js';
import { useConfirmationPreview } from '../hooks/use-confirmation-preview.js';

type ConsentPromptProps = {
  // If a simple string is given, it will render using markdown by default.
  prompt: ReactNode;
  reviewText?: string;
  onConfirm: (value: boolean) => void;
  dismissOnEscape?: boolean;
  terminalWidth: number;
  availableTerminalHeight?: number;
};

// Border, vertical padding, option margin, and two Yes/No option rows.
const CONSENT_PROMPT_CHROME_ROWS = 7;

export const ConsentPrompt = (props: ConsentPromptProps) => {
  const {
    prompt,
    reviewText,
    onConfirm,
    dismissOnEscape = false,
    terminalWidth,
    availableTerminalHeight,
  } = props;
  const constrainedHeight = clampDialogHeight(availableTerminalHeight);
  const availablePromptRows =
    constrainedHeight === undefined
      ? undefined
      : Math.max(1, constrainedHeight - CONSENT_PROMPT_CHROME_ROWS);
  const preview = useConfirmationPreview(
    reviewText,
    terminalWidth - 6,
    (availablePromptRows ?? 20) - 2,
  );
  useKeypress(
    (key) => {
      if (key.name === 'escape' && dismissOnEscape) onConfirm(false);
      if (reviewText !== undefined) preview.handleKey(key.name);
    },
    { isActive: dismissOnEscape || reviewText !== undefined },
  );
  const showPromptTruncationNotice =
    reviewText === undefined &&
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
        {reviewText !== undefined ? (
          <>
            {typeof prompt === 'string' ? <Text>{prompt}</Text> : prompt}
            <Text wrap="truncate-end">{preview.text}</Text>
            {preview.hint && <Text dimColor>{preview.hint}</Text>}
          </>
        ) : typeof prompt === 'string' ? (
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
