/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isFileContentInContext,
  trackFileStateResult,
  type FileState,
  type FileStateCache,
} from '../utils/fileStateCache.js';
import type { ToolResult } from './tools.js';

const currentFileHint =
  'The file state is current in your context; no need to read it back.';
const ownedFeedback = new WeakMap<
  ToolResult,
  { original: string; withHint: string }
>();

/** Bind feedback to the state captured by this write, not a later operation. */
export function withFileWriteFeedback<T extends ToolResult>(
  result: T,
  cache: FileStateCache,
  path: string,
  writtenState: FileState | undefined,
): T {
  if (!writtenState || cache.get(path) !== writtenState) return result;
  trackFileStateResult(result, cache, path);
  if (
    isFileContentInContext(writtenState) &&
    typeof result.llmContent === 'string'
  ) {
    const original = result.llmContent;
    const withHint = `${original} ${currentFileHint}`;
    ownedFeedback.set(result, { original, withHint });
    result.llmContent = withHint;
  }
  return result;
}

/** Remove only our own feedback; hook replacement text belongs to the hook. */
export function removeFileWriteFeedback(result: ToolResult): void {
  const feedback = ownedFeedback.get(result);
  if (feedback && result.llmContent === feedback.withHint) {
    result.llmContent = feedback.original;
  }
  ownedFeedback.delete(result);
}
