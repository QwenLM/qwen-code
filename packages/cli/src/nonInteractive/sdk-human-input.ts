/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HumanPromptInput } from '@qwen-code/qwen-code-core/core/workflow-intent.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readHumanInputFromSdkMessage(
  value: unknown,
): HumanPromptInput | undefined {
  if (
    !isRecord(value) ||
    value['type'] !== 'user' ||
    !isRecord(value['origin']) ||
    value['origin']['kind'] !== 'human' ||
    value['parent_tool_use_id'] != null ||
    !isRecord(value['message']) ||
    value['message']['role'] !== 'user'
  ) {
    return undefined;
  }

  const content = value['message']['content'];
  if (typeof content === 'string') {
    return { text: content };
  }
  if (!Array.isArray(content)) return undefined;
  if (
    content.some(
      (block) =>
        isRecord(block) &&
        (block['type'] === 'tool_result' || block['type'] === 'tool_use'),
    )
  ) {
    return undefined;
  }

  const text = content
    .flatMap((block) =>
      isRecord(block) &&
      block['type'] === 'text' &&
      typeof block['text'] === 'string'
        ? [block['text']]
        : [],
    )
    .join('\n');
  return text.length > 0 ? { text } : undefined;
}
