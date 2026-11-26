/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Project ordered transcript attachments into provider user messages.
 * Attachment classes decide provider visibility; this module projects and merges.
 */

import type { Attachment, AttachmentMessage } from './types.js';
import type { ModelInputContentBlock, ModelStreamUserMessage } from '../provider/modelStreamRequest.js';
import { restoreAttachment } from './transcript-conversion.js';

/** Normalize one attachment instance to 0..N messages. */
export function normalizeAttachmentForAPI(
  attachment: Attachment,
): ModelStreamUserMessage[] {
  return attachment.toUserMessages();
}

/**
 * Restore transcript payloads in an AttachmentMessage array and merge the
 * resulting user messages. Unknown attachments contribute no messages.
 *
 * Adjacent user messages are merged: if the previous message was also a
 * user message, content blocks are appended to it rather than creating a
 * new message. This produces the minimum number of turns.
 *
 * @param attachmentMessages - Array of AttachmentMessage to normalize
 * @returns Flattened, merged array of user messages ready for injection
 */
export function normalizeAttachmentsForAPI(
  attachmentMessages: readonly AttachmentMessage[],
): ModelStreamUserMessage[] {
  const result: ModelStreamUserMessage[] = [];

  for (const message of attachmentMessages) {
    const attachment = restoreAttachment(message.attachment);
    if (!attachment) continue;

    const expanded = normalizeAttachmentForAPI(attachment);

    for (const msg of expanded) {
      const last = result[result.length - 1];
      const blocks = (content: ModelStreamUserMessage['content']): readonly ModelInputContentBlock[] =>
        typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      if (last !== undefined) {
        result[result.length - 1] = {
          role: 'user', content: [...blocks(last.content), ...blocks(msg.content)],
        };
      } else {
        result.push({ ...msg, content: [...blocks(msg.content)] });
      }
    }
  }

  return result;
}
