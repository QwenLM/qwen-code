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
import type { DialogEntry } from '../../hooks/useBackgroundTaskView.js';

const KIND_NAMES = {
  agent: { singular: 'local agent', plural: 'local agents' },
  shell: { singular: 'shell', plural: 'shells' },
} as const;

/**
 * Pill label: prefer live running counts, then paused resumable agent counts;
 * once everything is terminal, switch to a generic "done" form so the pill
 * still invites reopening the dialog to inspect final state.
 */
export function getPillLabel(entries: readonly DialogEntry[]): string {
  if (entries.length === 0) return '';

  const running = entries.filter((e) => e.status === 'running');
  if (running.length > 0) {
    return groupAndFormat(running);
  }
  const pausedAgents = entries.filter(
    (e): e is Extract<DialogEntry, { kind: 'agent' }> =>
      e.kind === 'agent' && e.status === 'paused',
  );
  if (pausedAgents.length > 0) {
    return pausedAgents.length === 1
      ? '1 local agent paused'
      : `${pausedAgents.length} local agents paused`;
  }
  // All terminal — collapse into a single tally; per-kind detail isn't
  // useful at this point and would clutter the footer.
  return entries.length === 1 ? '1 task done' : `${entries.length} tasks done`;
}

function groupAndFormat(entries: readonly DialogEntry[]): string {
  const counts = { agent: 0, shell: 0 };
  for (const e of entries) counts[e.kind]++;
  const parts: string[] = [];
  // Order: shell first (matches Claude Code's pill convention), agent second.
  if (counts.shell > 0) parts.push(formatCount('shell', counts.shell));
  if (counts.agent > 0) parts.push(formatCount('agent', counts.agent));
  return parts.join(', ');
}

function formatCount(kind: keyof typeof KIND_NAMES, n: number): string {
  const names = KIND_NAMES[kind];
  return `${n} ${n === 1 ? names.singular : names.plural}`;
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
