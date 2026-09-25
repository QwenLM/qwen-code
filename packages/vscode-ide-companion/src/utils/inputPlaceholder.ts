/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const ZERO_WIDTH_SPACE = '\u200B';

export function stripZeroWidthSpaces(text: string): string {
  return text.replaceAll(ZERO_WIDTH_SPACE, '');
}
