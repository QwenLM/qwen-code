/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview System-level attachment generators.
 *
 * Generators:
 *   - getDateChangeAttachments(): Detect day rollover across session
 *   - getCriticalSystemReminderAttachment(): Build a critical reminder
 *   - getTokenUsageAttachment(): Report token budget status
 *   - getCompactionReminderAttachment(): Prompt compaction reminder
 */

import {
  type AttachmentToolUseContext,
  type AttachmentMessage,
  DateChangeAttachment,
  CriticalSystemReminderAttachment,
  TokenUsageAttachment,
  CompactionReminderAttachment,
} from '../types.js';
import { getCurrentLocalDate } from '../../utils/date.js';
import type { Message } from '../../protocol/transcript/message.js';

function historyContainsDateChange(
  messages: ReadonlyArray<Message | AttachmentMessage> | undefined,
  date: string,
): boolean {
  if (!messages) return false;

  return messages.some(
    (message) =>
      message.type === 'attachment' &&
      message.attachment.type === 'date_change' &&
      message.attachment['newDate'] === date,
  );
}

/**
 * Detect whether the local calendar date differs from the date embedded in the
 * stable startup context. Deduplication uses the model-visible history so a
 * reminder discarded by compaction can be emitted again.
 */
export async function getDateChangeAttachments(
  ctx: AttachmentToolUseContext,
  messages?: ReadonlyArray<Message | AttachmentMessage>,
): Promise<DateChangeAttachment[]> {
  const currentDate = getCurrentLocalDate();
  const startupDate = ctx.config
    ?.getMemoryContextManager?.()
    ?.getStartupDate?.();
  const currentDateIsVisible = historyContainsDateChange(messages, currentDate);

  if (startupDate !== undefined) {
    if (startupDate === currentDate || currentDateIsVisible) {
      return [];
    }
    return [
      new DateChangeAttachment({ type: 'date_change', newDate: currentDate }),
    ];
  }

  const previousDate = ctx.lastDateSeen;
  ctx.lastDateSeen = currentDate;
  if (previousDate === currentDate || currentDateIsVisible) {
    return [];
  }

  if (previousDate === undefined) {
    // Contexts without a memory manager do not carry a startup date. Use the
    // first observation as the baseline for subsequent turns.
    return [];
  }

  return [
    new DateChangeAttachment({ type: 'date_change', newDate: currentDate }),
  ];
}

/**
 * Build a CriticalSystemReminderAttachment with the given content.
 *
 * This is a utility function, not a generator — callers decide when to inject.
 */
export function getCriticalSystemReminderAttachment(
  content: string,
): CriticalSystemReminderAttachment {
  return new CriticalSystemReminderAttachment({
    type: 'critical_system_reminder',
    content,
  });
}

/**
 * Build a TokenUsageAttachment reporting current budget status.
 */
export function getTokenUsageAttachment(
  used: number,
  total: number,
): TokenUsageAttachment {
  return new TokenUsageAttachment({
    type: 'token_usage',
    used,
    total,
    remaining: Math.max(0, total - used),
  });
}

/**
 * Build a CompactionReminderAttachment.
 *
 * Callers should throttle this — it should only be emitted when context
 * is nearing the window limit.
 */
export function getCompactionReminderAttachment(): CompactionReminderAttachment {
  return new CompactionReminderAttachment({ type: 'compaction_reminder' });
}
