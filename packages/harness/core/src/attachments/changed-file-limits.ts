/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Limits apply to newly injected snippets per detection pass, not per session. */
export const CHANGED_FILE_SNIPPET_MAX_BYTES = 8 * 1024;
export const CHANGED_FILES_TOTAL_MAX_BYTES = 16 * 1024;

/** Keep valid UTF-8 and count the truncation marker inside the budget. */
export function truncateChangedFileSnippet(content: string, maxBytes: number) {
  const bytes = Buffer.from(content);
  if (bytes.length <= maxBytes) return { content, truncated: false };
  const marker =
    '\n... [Changes truncated. Use Read with offset and limit to inspect more.]';
  let end = Math.max(0, maxBytes - Buffer.byteLength(marker));
  if (end === 0) return { content: '', truncated: true };
  while ((bytes[end] & 0xc0) === 0x80) end--;
  const prefix = bytes.subarray(0, end).toString('utf8');
  const newline = prefix.lastIndexOf('\n');
  return {
    content: (newline > 0 ? prefix.slice(0, newline) : prefix) + marker,
    truncated: true,
  };
}
