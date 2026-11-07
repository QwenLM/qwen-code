/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export const EXEC_MAX_OUTPUT_CHARS = 32_000;

export function boundCodeModeOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '\n… code mode output truncated …\n';
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  const head = Math.ceil((maxChars - marker.length) / 2);
  const tail = maxChars - marker.length - head;
  return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : '');
}
