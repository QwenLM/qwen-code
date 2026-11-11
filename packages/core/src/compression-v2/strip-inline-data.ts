/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamMessage } from '../provider/modelStreamRequest.js';

const IMAGE_PLACEHOLDER = '[image]';

/**
 * Replace inline image bytes in an API-ready compact context with
 * text placeholders. Running after attachment projection also covers images
 * stored as image_file, pdf_file, or queued_command attachments.
 *
 * A compaction summary only needs to retain the fact that media appeared in
 * the conversation. Sending the original base64 again can make the summary
 * request exceed the provider's body-size limit. The input is never mutated.
 */
export function stripInlineDataForCompaction(
  messages: readonly ModelStreamMessage[],
): ModelStreamMessage[] {
  return messages.map((message) => {
    if ((message.role !== 'user' && message.role !== 'tool') || typeof message.content === 'string' ||
      !message.content.some((block) => block.type === 'image')) return message;
    return { ...message, content: message.content.map((block) =>
      block.type === 'image' ? { type: 'text', text: IMAGE_PLACEHOLDER } : block,
    ) };
  });
}
