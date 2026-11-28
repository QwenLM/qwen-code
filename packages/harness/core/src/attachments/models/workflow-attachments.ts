/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { AttachmentData } from '../types.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { systemReminder } from '../message-helpers.js';

/** A local-TUI `ultracode` keyword opted the current turn into Workflow. */
export class WorkflowKeywordRequestAttachment extends BaseAttachment {
  readonly type = 'workflow_keyword_request' as const;

  constructor(data: AttachmentData<WorkflowKeywordRequestAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.',
      ),
    ];
  }
}

/** Persistent UltraCode session reminder derived from transcript state. */
export class UltraEffortEnterAttachment extends BaseAttachment {
  readonly type = 'ultra_effort_enter' as const;
  declare reminderType: 'full' | 'sparse';

  constructor(data: AttachmentData<UltraEffortEnterAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        this.reminderType === 'full'
          ? "Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's **Ultracode** section and quality patterns. Solo only on conversational/trivial turns."
          : 'Ultracode is still on — use the Workflow tool; see its Ultracode section.',
      ),
    ];
  }
}

/** One-shot reminder after the session leaves UltraCode. */
export class UltraEffortExitAttachment extends BaseAttachment {
  readonly type = 'ultra_effort_exit' as const;

  constructor(data: AttachmentData<UltraEffortExitAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        "Ultracode is off — the Workflow tool's standard opt-in rule applies again.",
      ),
    ];
  }
}
