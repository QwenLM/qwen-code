/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function normalizeRecallText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export function* codePointBigrams(text: string): Generator<string> {
  let previous: string | undefined;
  for (const codePoint of text) {
    if (previous !== undefined) {
      yield previous + codePoint;
    }
    previous = codePoint;
  }
}
