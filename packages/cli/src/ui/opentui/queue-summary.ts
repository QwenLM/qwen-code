/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ctrl+Q queue display parity with ink's QueuedMessageDisplay: the queue
 * block shows at most three messages, each collapsed to a single-line
 * summary truncated to the available width (ink renders the previews with
 * `wrap="truncate"`), plus a "+N more" counter line.
 */

export const MAX_DISPLAYED_QUEUED_MESSAGES = 3;

/**
 * One queued message's display summary: whitespace collapsed to single
 * spaces, then truncated to `maxWidth` code points with a trailing ellipsis.
 * `maxWidth` is clamped so narrow terminals still show a usable preview.
 */
export function summarizeQueuedPrompt(
  message: string,
  maxWidth: number,
): string {
  const preview = message.replace(/\s+/g, ' ').trim();
  const limit = Math.max(8, Math.floor(maxWidth));
  const codePoints = [...preview];
  if (codePoints.length <= limit) {
    return preview;
  }
  return `${codePoints.slice(0, Math.max(1, limit - 1)).join('')}…`;
}
