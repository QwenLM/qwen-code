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
import { t } from '../../../i18n/index.js';

const KIND_NAMES = {
  agent: { singular: 'local agent', plural: 'local agents' },
  shell: { singular: 'shell', plural: 'shells' },
  monitor: { singular: 'monitor', plural: 'monitors' },
  dream: { singular: 'dream', plural: 'dreams' },
} as const;

/**
 * True if any background agent has a tool call parked awaiting user
 * approval (permission bubbling). Drives the pill's "needs approval"
 * marker so the user is nudged to open the dialog and answer.
 */
export function hasPendingApproval(entries: readonly DialogEntry[]): boolean {
  return entries.some(
    (e) => e.kind === 'agent' && (e.pendingApprovals?.length ?? 0) > 0,
  );
}

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
  const counts = { agent: 0, shell: 0, monitor: 0, dream: 0 };
  for (const e of entries) counts[e.kind]++;
  const parts: string[] = [];
  // Order: shell first (matches Claude Code's pill convention), then
  // agent, then monitor, then dream. Dream sits last because it is
  // system-initiated (not user-triggered) and the user is least likely
  // to need it at a glance.
  if (counts.shell > 0) parts.push(formatCount('shell', counts.shell));
  if (counts.agent > 0) parts.push(formatCount('agent', counts.agent));
  if (counts.monitor > 0) parts.push(formatCount('monitor', counts.monitor));
  if (counts.dream > 0) parts.push(formatCount('dream', counts.dream));
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
      // `return`, down, and the readline-style Ctrl+N all open the dialog.
      // This is focus-chain handling rather than selection-list handling
      // (see keyBindings.ts SELECTION_DOWN), so keep the matcher inline.
      // Down completes the focus chain Composer ↓ → AgentTabBar ↓ → Pill ↓ → Dialog,
      // so users can `↓ ↓ (↓)` their way from an empty composer
      // straight into the roster without having to remember the
      // Enter shortcut. The LiveAgentPanel's overflow callout
      // (`↓ to view all`) relies on this; without a Down handler
      // the chain dead-ends at the highlighted pill.
      if (
        key.name === 'return' ||
        key.name === 'down' ||
        (key.ctrl && key.name === 'n')
      ) {
        openDialog();
      } else if (
        key.name === 'up' ||
        (key.ctrl && key.name === 'p') ||
        key.name === 'escape'
      ) {
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
  const needsApproval = hasPendingApproval(entries);

  return (
    <>
      <Text color={theme.text.secondary}> · </Text>
      <Text inverse={pillFocused}>{label}</Text>
      {needsApproval && (
        <Text color={theme.status.warning}>{` ⚠ ${t('needs approval')}`}</Text>
      )}
    </>
  );
};
