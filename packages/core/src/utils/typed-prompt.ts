/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part, PartListUnion, PartUnion } from '@google/genai';

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

/**
 * `partMetadata` key on a marked part: how many characters at the start of
 * its text the client put in front of it after it was marked, such as the
 * IDE context. It is set where that text is put in front, so a compaction
 * that cuts the part reads where the user's words begin instead of working
 * it out from the text, where a prompt that itself opens with a reminder
 * block would pass for the client's (#9455). Absent, nothing was put in
 * front after the mark.
 */
export const TYPED_PROMPT_PREFIX_METADATA = 'qwen-code:typed-prompt-prefix';

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

/**
 * `part`, whose text now starts with `added` characters put in front of what
 * it held, with them added to its recorded prefix when it is marked. An
 * unmarked part is returned as it is.
 */
export function withTypedPromptPrefix(part: Part, added: number): Part {
  if (added <= 0 || !isTypedPrompt(part)) return part;
  return {
    ...part,
    partMetadata: {
      ...part.partMetadata,
      [TYPED_PROMPT_PREFIX_METADATA]: (typedPromptPrefix(part) ?? 0) + added,
    },
  };
}

/** The prefix recorded on `part` by `withTypedPromptPrefix`, if any. */
export function typedPromptPrefix(part: Part): number | undefined {
  const prefix = part.partMetadata?.[TYPED_PROMPT_PREFIX_METADATA];
  return Number.isSafeInteger(prefix) && (prefix as number) > 0
    ? (prefix as number)
    : undefined;
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
 * ahead of what they attached; what the client puts in front of that part
 * later, such as the IDE context, is recorded with `withTypedPromptPrefix`
 * and set apart by compaction. A request whose
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

/**
 * `request`, a retry, with its first text part marked when a user entry the
 * retry dropped from history held that text marked. A retry re-sends the
 * prompt of the send that failed, and that send marked it if the person
 * typed it, so the retried turn keeps the mark the session file already
 * records for it (#9455). What was put in front of the dropped text after it
 * was marked is set aside before the two are compared. A request already
 * marked, or whose first text no dropped entry marked, is returned as it is.
 */
export function markRetriedPrompt(
  request: PartListUnion,
  dropped: readonly Content[],
): PartListUnion {
  const typedTexts = new Set(
    dropped
      .filter((entry) => entry.role === 'user')
      .flatMap((entry) => entry.parts ?? [])
      .filter(isTypedPrompt)
      .map((part) => part.text!.slice(typedPromptPrefix(part) ?? 0)),
  );
  if (typedTexts.size === 0) return request;
  const parts = Array.isArray(request) ? request : [request];
  const first = parts.find(isPlainTextPart);
  const text = typeof first === 'string' ? first : first?.text;
  return text !== undefined && typedTexts.has(text)
    ? markFirstTextPartUnlessMarked(request)
    : request;
}
