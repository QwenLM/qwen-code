/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns true when a raw SSE data field is the protocol terminator. Callers
 * pass the already-trimmed SSE data field. A [DONE] value inside a
 * response envelope remains a skippable payload so that it does not truncate
 * later events in the same stream.
 */
export function isSseDone(data: string): boolean {
  return data === '[DONE]';
}
