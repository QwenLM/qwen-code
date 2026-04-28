/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback } from 'react';
import { Text } from 'ink';
import {
  useBackgroundTaskViewState,
  useBackgroundTaskViewActions,
} from '../../contexts/BackgroundTaskViewContext.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { theme } from '../../semantic-colors.js';
import type { BackgroundTaskEntry } from '@qwen-code/qwen-code-core';

/**
 * Pill label: counts running entries while any are running; once everything
 * has terminated, switches to a "done" form so the pill still invites
 * reopening the dialog to inspect final state.
 */
export function getPillLabel(entries: readonly BackgroundTaskEntry[]): string {
  const running = entries.filter((e) => e.status === 'running').length;
  if (running > 0) {
    return running === 1 ? '1 local agent' : `${running} local agents`;
  }
  return entries.length === 1
    ? '1 local agent done'
    : `${entries.length} local agents done`;
}

export const BackgroundTasksPill: React.FC = () => {
  const { entries, pillFocused } = useBackgroundTaskViewState();
  const { openDialog, setPillFocused } = useBackgroundTaskViewActions();

  const onKeypress = useCallback(
    (key: Key) => {
      if (key.name === 'return') {
        openDialog();
      } else if (key.name === 'up' || key.name === 'escape') {
        setPillFocused(false);
      } else if (
        key.sequence &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta
      ) {
        setPillFocused(false);
      }
    },
    [openDialog, setPillFocused],
  );

  useKeypress(onKeypress, { isActive: pillFocused });

  if (entries.length === 0) return null;

  const label = getPillLabel(entries);

  return (
    <>
      <Text color={theme.text.secondary}> · </Text>
      <Text inverse={pillFocused}>{label}</Text>
    </>
  );
};
