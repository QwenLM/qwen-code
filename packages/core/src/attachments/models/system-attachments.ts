/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import type {
  AttachmentData,
  AttachmentToolUseContext,
} from '../types.js';
import { systemReminder } from '../message-helpers.js';

/**
 * Notifies the LLM that the date has changed since the session started.
 */
export class DateChangeAttachment extends BaseAttachment {
  readonly type = 'date_change' as const;
  declare newDate: string;
  // ISO date string, e.g. "2026-04-13"
  /** True when this is the first turn of the session (not a day rollover). */
  declare isInitial?: boolean;

  constructor(data: AttachmentData<DateChangeAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    if (typeof this.newDate === 'string') ctx.lastDateSeen = this.newDate;
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        this.isInitial
          ? `Current date: ${this.newDate}`
          : `The date has changed. Current date: ${this.newDate}`,
      ),
    ];
  }
}

/**
 * A critical system reminder injected with high priority.
 * Normalized as <system-reminder>{content}</system-reminder>.
 */
export class CriticalSystemReminderAttachment extends BaseAttachment {
  readonly type = 'critical_system_reminder' as const;
  declare content: string;

  constructor(data: AttachmentData<CriticalSystemReminderAttachment>) {
    super(data);
  }

  // Legacy serverNames cannot establish or replace a tool-level MCP baseline.

  override toUserMessages(): ModelStreamUserMessage[] {
    return [systemReminder(this.content)];
  }
}

/**
 * Tells the model why its previous response ended early and that the retained
 * output and tool results are authoritative. Per-tool outcomes stay in their
 * tool_results; this carries request-level facts only.
 */
export class StreamInterruptionAttachment extends BaseAttachment {
  readonly type = 'stream_interruption' as const;
  /** Redacted, human-readable cause, e.g. "the upstream connection was closed". */
  declare cause: string;

  constructor(data: AttachmentData<StreamInterruptionAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        'The previous model response was interrupted before completion because ' +
          `${this.cause}.\n` +
          'Tool execution details are recorded in the corresponding tool results.\n' +
          'Continue the original task using those results. Do not repeat completed ' +
          'tool calls because of this interruption.',
      ),
    ];
  }
}

/**
 * Token usage reporting for budget-aware agents.
 * Normalized as <system-reminder> token usage report.
 */
export class TokenUsageAttachment extends BaseAttachment {
  readonly type = 'token_usage' as const;
  declare used: number;
  declare total: number;
  declare remaining: number;

  constructor(data: AttachmentData<TokenUsageAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `Token usage: ${this.used.toLocaleString()} used / ` +
          `${this.total.toLocaleString()} total (${this.remaining.toLocaleString()} remaining)`,
      ),
    ];
  }
}

/**
 * Reminder that context compression (compaction) is available.
 */
export class CompactionReminderAttachment extends BaseAttachment {
  readonly type = 'compaction_reminder' as const;

  constructor(data: AttachmentData<CompactionReminderAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        'Context is getting long. Consider using the compact command to compress the conversation history.',
      ),
    ];
  }
}
