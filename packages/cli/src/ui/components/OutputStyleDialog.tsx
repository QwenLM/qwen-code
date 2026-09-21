/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { BUILT_IN_OUTPUT_STYLES } from '@qwen-code/qwen-code-core/core/output-styles.js';
import type { OutputStyleDefinition } from '@qwen-code/qwen-code-core/core/output-styles.js';
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

  /** Selectable styles, built-ins first. Defaults to the built-ins alone. */
  styles?: readonly OutputStyleDefinition[];
}

function describe(style: OutputStyleDefinition): string {
  // Built-in descriptions are translatable; a custom file's is the author's.
  if (style.source === 'built-in') {
    return t(style.description);
  }
  return `${style.description} (${style.source})`;
}

export function OutputStyleDialog({
  onSelect,
  currentStyleName,
  styles = BUILT_IN_OUTPUT_STYLES,
}: OutputStyleDialogProps): React.JSX.Element {
  const items = [
    {
      label: `default — ${t('The standard prompt, with no extra style')}`,
      value: 'default',
      key: 'default',
    },
    ...styles.map((style) => ({
      label: `${style.name} — ${describe(style)}`,
      value: style.name,
      key: style.name,
    })),
  ];

  // Unlike /effort, "no style configured" genuinely is the first entry
  // (default), so pre-selecting index 0 in that case tells the truth.
  // The name is matched case-insensitively, like every other style lookup:
  // the level that wins can change its casing between startup and open (a
  // project `name: reviewer` over a user-level `Reviewer`), and an exact
  // compare would then mark `default` as active and let one Enter persist it.
  const activeName = currentStyleName?.toLowerCase();
  const initialIndex = Math.max(
    0,
    items.findIndex((item) => item.value.toLowerCase() === activeName),
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
          {t('(applies now and persists to settings)')}
        </Text>
      </Text>
      <Box height={1} />
      {styles.length === 0 ? (
        <Text color={theme.text.secondary}>{t('Loading output styles…')}</Text>
      ) : (
        <RadioButtonSelect
          items={items}
          initialIndex={initialIndex}
          onSelect={onSelect}
          isFocused
          showNumbers
        />
      )}
      <Box marginTop={1}>
        <Text color={theme.text.secondary} wrap="truncate">
          {t('(Use Enter to select, Esc to cancel)')}
        </Text>
      </Box>
    </Box>
  );
}
