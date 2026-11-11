/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../utils/fileUtils.js';
import { truncateString } from '../utils/textUtils.js';

export function boundedProducerPayload(
  output: string,
  maxChars = DEFAULT_MAX_RESULT_SIZE_CHARS,
): string {
  if (output.length <= maxChars) {
    return output;
  }

  return truncateString(
    output,
    maxChars,
    `\n... [output truncated - ${output.length - maxChars} chars removed]`,
  );
}
