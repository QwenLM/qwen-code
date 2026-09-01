/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { BUILT_IN_OUTPUT_STYLES } from '@qwen-code/qwen-code-core';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';

interface OutputStyleDialogProps {
  /**
   * Callback when a style is chosen. Receives the style name, `'default'` for
   * no style, or `undefined` when the dialog was cancelled.
   */
  onSelect: (styleName: string | undefined) => void;

  /** Name of the currently active style, used to pre-select the list. */
  currentStyleName?: string;
}

export function OutputStyleDialog({
  onSelect,
  currentStyleName,
}: OutputStyleDialogProps): React.JSX.Element {
  const items = [
    {
      label: `default — ${t('The standard prompt, with no extra style')}`,
      value: 'default',
      key: 'default',
    },
    ...BUILT_IN_OUTPUT_STYLES.map((style) => ({
      label: `${style.name} — ${t(style.description)}`,
      value: style.name,
      key: style.name,
    })),
  ];

  // Unlike /effort, "no style configured" genuinely is the first entry
  // (default), so pre-selecting index 0 in that case tells the truth.
  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.value === currentStyleName),
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSelect(undefined);
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>
        {'> '}
        {t('Output Style')}{' '}
        <Text color={theme.text.secondary}>
          {t('(applies now and persists to user settings)')}
        </Text>
      </Text>
      <Box height={1} />
      <RadioButtonSelect
        items={items}
        initialIndex={initialIndex}
        onSelect={onSelect}
        isFocused
        showNumbers
      />
      <Box marginTop={1}>
        <Text color={theme.text.secondary} wrap="truncate">
          {t('(Use Enter to select, Esc to cancel)')}
        </Text>
      </Box>
    </Box>
  );
}
