/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part, PartListUnion } from '@google/genai';
import { markTypedPrompt } from '@qwen-code/qwen-code-core/utils/attached-content.js';
import { normalizePartList } from '../../utils/normalize-part-list.js';
import { isInjectedFilePart } from './injected-file-parts.js';

/**
 * `content` with each text part marked as the request, so compaction quotes
 * it: a command's expanded prompt, or input steered in while tools ran. File
 * content an `@{path}` injection added stays unmarked, as attached content.
 */
export function markPromptParts(content: PartListUnion): Part[] {
  return normalizePartList(content).map((part) =>
    typeof part.text === 'string' && !part.thought && !isInjectedFilePart(part)
      ? markTypedPrompt(part)
      : part,
  );
}
