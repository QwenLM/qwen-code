/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion, PartUnion } from '@google/genai';

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
    part.partMetadata?.[TYPED_PROMPT_METADATA] === true && isPlainTextPart(part)
  );
}

/** Whether `part` can hold what the user typed: plain text, not a call or thought. */
function isPlainTextPart(part: PartUnion): boolean {
  return (
    typeof part === 'string' ||
    (typeof part.text === 'string' &&
      !part.thought &&
      !part.functionCall &&
      !part.functionResponse)
  );
}

/**
 * `request` with its first text part marked as what the user typed. The
 * front ends that send a person's prompt put the text they submitted first,
 * ahead of what they attached; leading reminders spliced into that part are
 * set apart by compaction, which reads them as blocks. A request whose
 * first text part is empty, or that has none, is returned as it is: a later
 * part is never taken in its place.
 */
export function markFirstTextPart(request: PartListUnion): PartListUnion {
  const parts = Array.isArray(request) ? request : [request];
  const index = parts.findIndex(isPlainTextPart);
  const first = parts[index];
  const text = typeof first === 'string' ? first : first?.text;
  if (!text) return request;
  return parts.map((part, i) =>
    i === index
      ? markTypedPrompt(typeof part === 'string' ? { text: part } : part)
      : part,
  );
}

/**
 * `markFirstTextPart`, unless a part of `request` is marked already. A front
 * end that marks its own prompt has placed the mark where the person's text
 * is: ACP puts what the person attached first and marks the instruction it
 * ends with, so marking the first part as well would mark the attachment.
 */
export function markFirstTextPartUnlessMarked(
  request: PartListUnion,
): PartListUnion {
  const parts = Array.isArray(request) ? request : [request];
  return parts.some((part) => typeof part !== 'string' && isTypedPrompt(part))
    ? request
    : markFirstTextPart(request);
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
