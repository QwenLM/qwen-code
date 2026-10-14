/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isUserPromptSubmitContextPartText as isUserPromptSubmitContextPartTextInternal,
  wrapUserPromptSubmitContext,
} from '../utils/transcript-records.js';

/**
 * Reserved tag wrapping UserPromptSubmit `additionalContext` when it is
 * appended to the model-bound user message. The canonical tag and matcher
 * definitions live in the Node-free transcript-records module.
 */
export {
  USER_PROMPT_SUBMIT_CONTEXT_OPEN as USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG,
  USER_PROMPT_SUBMIT_CONTEXT_CLOSE as USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG,
  isUserPromptSubmitContextPartText,
  wrapUserPromptSubmitContext,
} from '../utils/transcript-records.js';

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
    !isUserPromptSubmitContextPartTextInternal(last.text)
  ) {
    return parts;
  }
  return parts.slice(0, -1);
}

/**
 * Matches the whole wrapped block rather than a substring, so `context` must be
 * the escaped string that injection appends, not the raw hook output. Unlike
 * `isUserPromptSubmitContextPartText`, which recognizes any tagged block, this
 * recognizes one exact payload and does not trim.
 *
 * A match also requires the shape injection produces: a user entry whose
 * trailing part is the block, preceded by at least one part of the user's own.
 * Tagged text that merely appears — in a model entry, or as a whole user
 * message, which `stripTrailingUserPromptSubmitContextPart` treats as
 * user-authored — is not proof the hook delivered it, so it does not suppress a
 * fresh delivery.
 */
export function hasUserPromptSubmitContext(
  entry: unknown,
  context: string,
): boolean {
  const candidate = entry as { role?: unknown; parts?: unknown } | null;
  if (candidate?.role !== 'user' || !Array.isArray(candidate.parts)) {
    return false;
  }
  const parts = candidate.parts;
  if (parts.length < 2) {
    return false;
  }
  const last = parts[parts.length - 1] as { text?: unknown } | null;
  return last?.text === wrapUserPromptSubmitContext(context);
}
