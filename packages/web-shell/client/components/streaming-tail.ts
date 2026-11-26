/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../adapters/types.js';

/** Negative index of the only streaming row that changed, skipping Mod logs. */
export function streamingTailUpdatePosition(
  previous: readonly Message[] | undefined,
  current: readonly Message[],
): number | undefined {
  if (!previous || previous.length !== current.length || current.length === 0) {
    return undefined;
  }
  let index = current.length - 1;
  for (; index > 0; index -= 1) {
    const message = current[index];
    if (message.role !== 'system' || message.source !== 'mod_log') break;
    if (previous[index] !== message) return undefined;
  }
  for (let i = 0; i < index; i += 1) {
    if (previous[i] !== current[i]) return undefined;
  }
  const before = previous[index];
  const after = current[index];
  if (
    before.id !== after.id ||
    before.role !== after.role ||
    (after.role !== 'assistant' && after.role !== 'thinking') ||
    (before.role !== 'assistant' && before.role !== 'thinking') ||
    before.isStreaming !== true ||
    after.isStreaming !== true
  ) {
    return undefined;
  }
  if (
    before.role === 'assistant' &&
    after.role === 'assistant' &&
    (typeof before.content !== 'string' ||
      typeof after.content !== 'string' ||
      before.branchRecordId !== after.branchRecordId ||
      before.usage !== after.usage ||
      Boolean(before.content.trim()) !== Boolean(after.content.trim()))
  ) {
    return undefined;
  }
  return index - current.length;
}
