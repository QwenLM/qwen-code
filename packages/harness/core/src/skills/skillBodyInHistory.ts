/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../protocol/transcript/message.js';
import { isWellFormedAttachmentPayload } from '../protocol/transcript/message-utils.js';

/** A retained invocation body takes precedence over a historical reminder. */
export function findSkillBodyInHistory(
  messages: readonly Message[],
  content: string,
): 'body' | 'attachment' | undefined {
  let hasAttachment = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.isVirtual || message.isCompactSummary) continue;

    if (message.type === 'user' && message.isMeta) {
      const previous = message.message.content;
      if (typeof previous === 'string') {
        if (previous === content) return 'body';
      } else if (
        previous.every((block) => block.type === 'text') &&
        previous.map((block) => block.text).join('\n\n') === content
      ) {
        return 'body';
      }
    }

    if (
      !hasAttachment &&
      message.type === 'attachment' &&
      message.attachment.type === 'invoked_skills' &&
      isWellFormedAttachmentPayload(message.attachment)
    ) {
      const skills = message.attachment['skills'] as Array<
        Record<string, unknown>
      >;
      hasAttachment = skills.some((skill) => skill['content'] === content);
    }
  }
  return hasAttachment ? 'attachment' : undefined;
}
