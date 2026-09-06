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
import { keyMatchers, Command } from '../keyMatchers.js';
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
  // Armed only by the user's own input — a digit quick-select, a navigation
  // key, or a click (onSelectIntent below). Pointer hover reaches the list
  // through the same highlight channel as real navigation, so highlight
  // state cannot tell "just looking" apart from an explicit pick; input can.
  const explicitChoice = useRef(false);

  const handleSelectIntent = useCallback(() => {
    explicitChoice.current = true;
  }, []);

  const handleSelect = useCallback(
    (effort: ReasoningEffort) => {
      // On a forced cursor, confirming without an explicit choice gesture is
      // the "just looking" act: cancel rather than persist a tier the user
      // never chose over the stored global value, which is still valid on
      // other models. A single-row list has no "just looking" gesture to
      // distinguish, so it confirms the row it shows.
      if (
        currentEffort &&
        configuredIndex === -1 &&
        efforts.length > 1 &&
        !explicitChoice.current
      ) {
        onSelect(undefined);
        return;
      }
      onSelect(effort);
    },
    [onSelect, currentEffort, configuredIndex, efforts.length],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSelect(undefined);
        return;
      }
      // A nav key fails to move the cursor only on a single-row list, where
      // the guard above never runs — so arming here never credits a clamped
      // no-op arrow as a choice.
      if (
        /^[0-9]$/.test(key.sequence) ||
        keyMatchers[Command.SELECTION_UP](key) ||
        keyMatchers[Command.SELECTION_DOWN](key)
      ) {
        explicitChoice.current = true;
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
        onSelectIntent={handleSelectIntent}
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
