/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';

/**
 * `partMetadata` key on the part that holds what the user typed, set where
 * the request is built. When a compaction request has to be cut down, the
 * parts carrying it are the only ones read as the user's own words; a turn
 * with none is cut like any other text.
 *
 * Client-side only: the native generator deletes `partMetadata` before the
 * SDK sees it (Vertex AI rejects the field), and the other converters never
 * serialize it. The session file keeps it, so a resumed session still has it.
 */
export const TYPED_PROMPT_METADATA = 'qwen-code:typed-prompt';

/** A copy of `part` marked as the text the user typed. */
export function markTypedPrompt(part: Part): Part {
  return {
    ...part,
    partMetadata: { ...part.partMetadata, [TYPED_PROMPT_METADATA]: true },
  };
}

/** Whether `part` is a text part marked as the text the user typed. */
export function isTypedPrompt(part: Part): boolean {
  return (
    part.partMetadata?.[TYPED_PROMPT_METADATA] === true &&
    typeof part.text === 'string' &&
    !part.thought &&
    !part.functionCall &&
    !part.functionResponse
  );
}

/**
 * Whether `part` is text and nothing else, allowing only the typed-prompt
 * mark: `{ text }` or `{ text, partMetadata: { [TYPED_PROMPT_METADATA]: true } }`.
 * Shape checks that require a lone `text` key use this, so the mark does not
 * change what they accept.
 */
export function isBareTextPart(part: Part): boolean {
  if (typeof part.text !== 'string') return false;
  const keys = Object.keys(part);
  if (keys.length === 1) return true;
  return (
    keys.length === 2 &&
    isTypedPrompt(part) &&
    Object.keys(part.partMetadata ?? {}).length === 1
  );
}
