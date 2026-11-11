/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelInputContentBlock,
  ModelStreamUserContent,
} from '../provider/modelStreamRequest.js';

/**
 * 提取标准输入中的文本，图片不参与纯文本展示。
 */
export function extractTextFromBlocks(
  blocks: readonly ModelInputContentBlock[],
): string {
  return blocks.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');
}

function isSystemReminderText(text: string): boolean {
  return text.trimStart().startsWith('<system-reminder');
}

/**
 * Extract the user-visible prompt text for diagnostics, lifecycle metadata,
 * task routing, and hooks. String prompts are legacy/plain text and pass
 * through unchanged. For block prompts, host-injected system-reminder text
 * blocks are omitted.
 */
export function extractUserVisiblePromptText(
  prompt: ModelStreamUserContent,
): string {
  if (typeof prompt === 'string') {
    return prompt;
  }

  return prompt
    .flatMap((block) => block.type === 'text' && !isSystemReminderText(block.text) ? [block.text] : [])
    .join('\n');
}
