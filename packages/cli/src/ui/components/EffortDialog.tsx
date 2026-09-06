/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  REASONING_EFFORT_TIERS,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';

interface EffortDialogProps {
  /** Callback when a tier is chosen; `undefined` means the dialog was cancelled. */
  onSelect: (effort: ReasoningEffort | undefined) => void;

  /** The currently active effort, used to pre-select the list. */
  currentEffort?: ReasoningEffort;
}

const EFFORT_DESCRIPTIONS: Record<ReasoningEffort, string> = {
  low: 'Fastest and cheapest; least reasoning.',
  medium: 'Balanced speed, cost, and reasoning.',
  high: 'Default — strong reasoning for hard tasks.',
  xhigh: 'Extended reasoning for agentic/coding work.',
  max: 'Maximum reasoning; highest cost and latency.',
};

export function EffortDialog({
  onSelect,
  currentEffort,
}: EffortDialogProps): React.JSX.Element {
  const items = REASONING_EFFORT_TIERS.map((tier) => ({
    label: `${tier} — ${t(EFFORT_DESCRIPTIONS[tier])}`,
    value: tier,
    key: tier,
  }));

  // Only pre-select when an effort is actually configured. When it's unset,
  // start the cursor at the top (index 0) rather than highlighting 'high',
  // which would mislead the user into thinking 'high' is their current setting
  // when in fact the model/provider default applies.
  const initialIndex = currentEffort
    ? Math.max(0, REASONING_EFFORT_TIERS.indexOf(currentEffort))
    : 0;

  const handleSelect = useCallback(
    (effort: ReasoningEffort) => {
      onSelect(effort);
    },
    [onSelect],
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
        {t('Reasoning Effort')}{' '}
        <Text color={theme.text.secondary}>
          {t('(applied across all providers; clamped per model)')}
        </Text>
      </Text>
      <Box height={1} />
      <RadioButtonSelect
        items={items}
        initialIndex={initialIndex}
        onSelect={handleSelect}
        isFocused
        showNumbers
      />
      {!currentEffort && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary} wrap="truncate">
            {t('No effort configured — using the model/provider default.')}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.text.secondary} wrap="truncate">
          {t('(Use Enter to select, Esc to cancel)')}
        </Text>
      </Box>
    </Box>
  );
}
