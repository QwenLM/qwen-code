/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../commands/types.js';
import type { TrackedToolCall } from '../hooks/useReactToolScheduler.js';
import { StreamingState } from '../types.js';
import { t } from '../../i18n/index.js';

export function getSessionBusyReason(
  streamingState: StreamingState,
  toolCalls: readonly TrackedToolCall[],
  isReceivingContent: boolean,
): string | null {
  const approval = toolCalls.find((tc) => tc.status === 'awaiting_approval');
  if (approval) {
    return t(
      'tool "{{tool}}" is awaiting approval. Resolve the pending approval.',
      {
        tool: approval.request.name,
      },
    );
  }
  if (streamingState === StreamingState.WaitingForConfirmation) {
    return t('a subagent is awaiting approval. Resolve the pending approval.');
  }
  const active = toolCalls.find(
    (tc) =>
      tc.status === 'executing' ||
      tc.status === 'scheduled' ||
      tc.status === 'validating',
  );
  if (active) {
    return t('tool "{{tool}}" is {{status}}. Wait for it to finish.', {
      tool: active.request.name,
      status: t(active.status),
    });
  }
  const unsubmitted = toolCalls.find(
    (tc) =>
      (tc.status === 'success' ||
        tc.status === 'error' ||
        tc.status === 'cancelled') &&
      !tc.responseSubmittedToLlm,
  );
  if (unsubmitted) {
    return t(
      'the result of tool "{{tool}}" has not been submitted to the model. Wait for submission or press Esc to cancel the turn.',
      { tool: unsubmitted.request.name },
    );
  }
  if (streamingState === StreamingState.Idle) return null;
  return isReceivingContent
    ? t(
        'the model is streaming a response. Wait for it to finish or press Esc to cancel.',
      )
    : t(
        'a model request is in progress with no response content arriving. Wait for it to finish or press Esc to cancel.',
      );
}

export function getSessionBusyMessage(
  context: CommandContext,
  operation: 'branch' | 'fork' | 'change directory',
): string | null {
  const { ui } = context;
  let reason = ui.getSessionBusyReason?.();
  if (
    ui.pendingItem?.type === 'compression' &&
    ui.pendingItem.compression.isPending
  ) {
    reason = t('context compaction is in progress. Wait for it to finish.');
  } else if (
    ui.pendingItem &&
    ui.pendingItem.type !== 'compression' &&
    !reason
  ) {
    reason = t('a slash command is still running. Wait for it to finish.');
  }
  if (!reason && ui.isIdleRef?.current === false) {
    reason = t(
      'a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.',
    );
  }
  if (!reason) return null;
  switch (operation) {
    case 'branch':
      return t('Cannot branch: {{reason}}', { reason });
    case 'fork':
      return t('Cannot fork: {{reason}}', { reason });
    default:
      return t('Cannot change directory: {{reason}}', { reason });
  }
}
