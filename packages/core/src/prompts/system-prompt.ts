/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

import { parseBoolean } from '../config-service/features/gateParseUtils.js';
import type { SystemPrompt } from './types.js';

/** Controls system prompt block assembly and outbound wire representation. */
export function areSystemPromptBlocksEnabled(): boolean {
  return (
    parseBoolean(
      process.env[`${BRAND_FIXED_ENV_PREFIX}SYSTEM_PROMPT_BLOCKS`],
    ) !== false
  );
}

/** Converts authored text into the canonical model-request representation. */
export function systemPromptFromText(text: string): SystemPrompt {
  return text.length > 0 ? [{ type: 'text', text }] : [];
}

/** Text projection for display and token estimation; not for request inheritance. */
export function systemPromptToText(prompt: SystemPrompt): string {
  return prompt.map((block) => block.text).join('\n\n');
}

/** Appends instructions without flattening or mutating existing blocks. */
export function appendSystemPromptText(
  prompt: SystemPrompt,
  text: string,
  separator = '\n\n',
): SystemPrompt {
  if (text.length === 0) return prompt;
  const last = prompt.at(-1);
  if (!last) return systemPromptFromText(text);
  return [
    ...prompt.slice(0, -1),
    { ...last, text: `${last.text}${separator}${text}` },
  ];
}
