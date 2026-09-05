/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useRef } from 'react';
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
  efforts?: readonly ReasoningEffort[];
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
  efforts = REASONING_EFFORT_TIERS,
}: EffortDialogProps): React.JSX.Element {
  const items = efforts.map((tier) => ({
    label: `${tier} — ${t(EFFORT_DESCRIPTIONS[tier])}`,
    value: tier,
    key: tier,
  }));

  // Pre-select only a tier this model actually exposes. An unset effort starts
  // at the top rather than highlighting 'high', and so does a tier the global
  // `model.reasoningEffort` carried over from another model (only ACP sessions
  // reconcile it) — either way the cursor must not read as "this tier is
  // current".
  const configuredIndex = currentEffort ? efforts.indexOf(currentEffort) : -1;
  const initialIndex = Math.max(0, configuredIndex);
  const cursorMoved = useRef(false);

  const handleHighlight = useCallback(() => {
    cursorMoved.current = true;
  }, []);

  const handleSelect = useCallback(
    (effort: ReasoningEffort) => {
      // On a forced cursor, confirming without moving is the "just looking"
      // gesture: cancel rather than persist a tier the user never chose over
      // the stored global value, which is still valid on other models.
      if (currentEffort && configuredIndex === -1 && !cursorMoved.current) {
        onSelect(undefined);
        return;
      }
      onSelect(effort);
    },
    [onSelect, currentEffort, configuredIndex],
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
        onHighlight={handleHighlight}
        isFocused
        showNumbers
      />
      {configuredIndex === -1 && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary} wrap="truncate">
            {currentEffort
              ? t(
                  '{{effort}} is not available for this model — using the model/provider default.',
                  { effort: currentEffort },
                )
              : t('No effort configured — using the model/provider default.')}
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
