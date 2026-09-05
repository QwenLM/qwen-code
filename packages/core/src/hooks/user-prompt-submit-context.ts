/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { isUserPromptSubmitContextPartText as isUserPromptSubmitContextPartTextInternal } from '../utils/transcript-records.js';

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
