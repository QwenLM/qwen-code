/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext } from '../commands/types.js';
import type { TrackedToolCall } from '../hooks/useReactToolScheduler.js';
import { StreamingState } from '../types.js';
import { t } from '../../i18n/index.js';

type SessionBusyToolCall = {
  request: { name: string };
  status: TrackedToolCall['status'];
  responseSubmittedToLlm?: boolean;
};

function getCompactionBusyReason(): string {
  return t('context compaction is in progress. Wait for it to finish.');
}

export function getSessionBusyReason(
  streamingState: StreamingState,
  toolCalls: readonly SessionBusyToolCall[],
  isReceivingContent: boolean,
  isCompacting = false,
): string | null {
  if (isCompacting) return getCompactionBusyReason();
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
    if (active.status === 'executing') {
      return t('tool "{{tool}}" is executing. Wait for it to finish.', {
        tool: active.request.name,
      });
    }
    if (active.status === 'scheduled') {
      return t('tool "{{tool}}" is scheduled. Wait for it to finish.', {
        tool: active.request.name,
      });
    }
    return t('tool "{{tool}}" is validating. Wait for it to finish.', {
      tool: active.request.name,
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
  let reason = ui.readSessionBusyReason?.();
  if (
    ui.pendingItem?.type === 'compression' &&
    ui.pendingItem.compression.isPending
  ) {
    reason = getCompactionBusyReason();
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
