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
import { userMessage } from '../message-helpers.js';

/**
 * Auto mode (AFK autonomous mode) state.
 * Feature gate: TRANSCRIPT_CLASSIFIER.
 */
export class AutoModeAttachment extends BaseAttachment {
  readonly type = 'auto_mode' as const;
  declare reminderType: 'full' | 'sparse';

  constructor(data: AttachmentData<AutoModeAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const isFull = this.reminderType === 'full';
    if (isFull) {
      return [
        userMessage(
          `## Auto Mode Active\n\n` +
            `You are running unattended: tool calls are approved by a classifier, not by the user.\n\n` +
            `1. **Execute immediately.** Carry out the work rather than describing what you would do.\n` +
            `2. **Minimize interruptions.** Do not ask for confirmation of steps you are able to take.\n` +
            `3. **Prefer action over planning.** Investigate by doing, and stop planning once the next step is clear.\n` +
            `4. **Expect course corrections.** The user reviews results afterwards, so a reasonable choice now beats waiting.\n` +
            `5. **Do not take irreversible or destructive actions.** Anything that cannot be undone still needs the user.\n` +
            `6. **Do not move data off this machine.** No exfiltration, uploads, or sends that the task did not ask for.`,
        ),
      ];
    }
    return [
      systemReminder(
        `Auto mode still active (see the full instructions earlier in this conversation). ` +
          `Execute autonomously, minimize interruptions, prefer action over planning.`,
      ),
    ];
  }
}

/**
 * Auto mode exit notification.
 */
export class AutoModeExitAttachment extends BaseAttachment {
  readonly type = 'auto_mode_exit' as const;

  constructor(data: AttachmentData<AutoModeExitAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      userMessage(
        `## Exited Auto Mode\n\n` +
          `You have left auto mode. The user may now want to work more directly with you, ` +
          `so ask clarifying questions when an approach is ambiguous instead of assuming.`,
      ),
    ];
  }
}
