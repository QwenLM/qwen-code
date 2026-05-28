/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * postCompactAttachments — pure builders for the message blocks injected
 * AFTER the summary in a compacted history. Replaces qwen-code's tail-
 * preservation model (split-point + last 30%) with claude-code's
 * "summary + restored attachments" model.
 *
 * Everything in this module is message-history-driven: no separate state
 * caches, no new message types. Extractors walk `Content[]`, builders
 * produce ordinary user/model `Content` objects with text/inlineData parts.
 */

import type { Content } from '@google/genai';

export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;
export const POST_COMPACT_TOKEN_BUDGET = 50_000;
export const POST_COMPACT_MAX_IMAGES_TO_RESTORE = 3;

/** Tool names that signal "this turn touched a file at args.file_path". */
const FILE_TOUCHING_TOOLS = new Set<string>([
  'read_file',
  'write_file',
  'edit',
  'replace', // legacy alias for 'edit' — may appear in old sessions (see ToolNamesMigration)
]);

/**
 * Walk the history newest-first, collect the most recently touched file
 * paths, deduplicated. Older mentions of the same path are dropped in
 * favor of the most recent one.
 */
export function extractRecentFilePaths(
  history: Content[],
  maxFiles: number,
): string[] {
  if (maxFiles <= 0) return [];

  const seen = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i];
    if (content.role !== 'model') continue;
    for (const part of content.parts ?? []) {
      const call = part.functionCall;
      if (!call || !FILE_TOUCHING_TOOLS.has(call.name ?? '')) continue;
      const args = call.args as { file_path?: unknown } | undefined;
      const filePath =
        typeof args?.file_path === 'string' ? args.file_path : undefined;
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      if (seen.size >= maxFiles) return [...seen];
    }
  }
  return [...seen];
}
