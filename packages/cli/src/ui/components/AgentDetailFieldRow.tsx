/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { figures } from '../utils/figures.js';
import type { AgentDetailField } from './AgentDetailTypes.js';

export const AgentDetailFieldRow = ({
  field,
  value,
  defaultValue,
  isActive,
  disabled,
  disabledLabel,
}: {
  field: AgentDetailField;
  value: unknown;
  defaultValue: unknown;
  isActive: boolean;
  disabled?: boolean;
  disabledLabel?: string;
}): React.JSX.Element => {
  const effectiveValue = value !== undefined ? value : defaultValue;
  const isOverridden = value !== undefined;
  const isDisabled = disabled === true;
  const labelColor = isDisabled
    ? theme.text.secondary
    : isActive
      ? theme.ui.focus
      : theme.text.primary;
  const prefix = isActive ? figures.pointer : '-';

  let displayValue: string;
  if (field.type === 'action') {
    displayValue = isDisabled
      ? (disabledLabel ??
        (field.key === 'editAgent'
          ? '(built-in agent, cannot edit)'
          : '(built-in agent, cannot delete)'))
      : (field.actionLabel ?? '⏎ Enter');
  } else if (field.type === 'select' && field.options) {
    const match = field.options.find((o) => o.value === effectiveValue);
    if (match) {
      if (isDisabled) {
        displayValue = `${match.label} (read-only)`;
      } else {
        const idx = field.options.indexOf(match);
        const prev = idx > 0 ? '◀' : ' ';
        const next = idx < field.options.length - 1 ? figures.play : ' ';
        displayValue = `${prev} ${match.label} ${next}`;
      }
    } else {
      displayValue =
        effectiveValue !== undefined ? String(effectiveValue) : '(default)';
      if (isDisabled) {
        displayValue += ' (read-only)';
      }
    }
  } else {
    displayValue =
      effectiveValue !== undefined ? String(effectiveValue) : '(default)';
  }

  const valueColor = isDisabled
    ? theme.text.secondary
    : field.type === 'action'
      ? isActive
        ? field.key === 'deleteAgent'
          ? theme.status.error
          : theme.ui.focus
        : theme.text.secondary
      : isActive
        ? theme.ui.focus
        : isOverridden
          ? theme.status.warning
          : theme.text.secondary;

  return (
    <Box flexDirection="row">
      <Text color={labelColor} bold={isActive}>
        {` ${prefix} `}
      </Text>
      <Box width={22}>
        <Text color={labelColor} bold={isActive}>
          {field.label}
        </Text>
      </Box>
      <Text color={valueColor} bold={isActive}>
        {displayValue}
      </Text>
      {isOverridden && field.type !== 'action' && (
        <Text color={theme.status.warning}> *</Text>
      )}
      {isActive && field.key === 'maxTurns' && !isDisabled && (
        <Text color={theme.text.secondary}>
          {' '}
          · ←/→ quick adjust · Enter custom value
        </Text>
      )}
    </Box>
  );
};
