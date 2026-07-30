/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reserved tag wrapping UserPromptSubmit `additionalContext` when it is
 * appended to the model-bound user message. The wrapper keeps hook-injected
 * text distinguishable from user-authored prose in model history, session
 * transcripts, and offline analysis.
 *
 * `getAdditionalContext()` escapes `<`/`>` in hook output, so injected
 * content can never contain a literal closing tag — a genuine wrapped part
 * is always a single, whole tagged block.
 */
export const USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG =
  '<qwen:user-prompt-submit-context>';
export const USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG =
  '</qwen:user-prompt-submit-context>';

/**
 * Wraps sanitized UserPromptSubmit additional context in the reserved tag.
 */
export function wrapUserPromptSubmitContext(context: string): string {
  return `${USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG}\n${context}\n${USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG}`;
}

/**
 * Returns true when `text` is, in its entirety, a wrapped UserPromptSubmit
 * context block (allowing surrounding whitespace).
 *
 * Intended for display projection of records that carry the tag but no
 * `UserPromptRecordPayload` metadata: injection always appends the wrapped
 * context as its own whole part, so only a whole-part match may be treated
 * as hook-injected. Text where the tag is mixed with other prose is
 * user-authored and must never match.
 */
export function isUserPromptSubmitContextPartText(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith(USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG) &&
    trimmed.endsWith(USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG) &&
    trimmed.length >=
      USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG.length +
        USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG.length
  );
}

/**
 * Drops a trailing part that is entirely a tagged UserPromptSubmit context
 * block. Injection always appends after the user's own part(s), so a sole
 * matching part is treated as user-authored and kept. Returns the same
 * array reference when nothing is stripped.
 */
export function stripTrailingUserPromptSubmitContextPart<T>(
  parts: readonly T[],
): readonly T[] {
  if (parts.length <= 1) {
    return parts;
  }
  const last = parts[parts.length - 1] as { text?: unknown } | undefined;
  if (
    !last ||
    typeof last.text !== 'string' ||
    !isUserPromptSubmitContextPartText(last.text)
  ) {
    return parts;
  }
  return parts.slice(0, -1);
}
