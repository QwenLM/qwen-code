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

import type { Content, Part } from '@google/genai';

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

export interface ExtractedImage {
  /** The original `inlineData` part, ready to embed verbatim. */
  part: Part;
  /** Turn index in the original history (for metadata header). */
  turnIndex: number;
  /** Name of the tool whose call immediately preceded this image, if any. */
  sourceToolName?: string;
  /** Args of that tool call, for the metadata header. */
  sourceToolArgs?: Record<string, unknown>;
}

/**
 * Walk the history newest-first, collect up to `maxImages` inlineData
 * parts whose mimeType starts with "image/", and pair each one with the
 * preceding model+functionCall (if any) as source-tool metadata.
 *
 * Returns oldest-first so callers can compose a chronological strip
 * (last user-visible state ends up at the bottom of the attachment).
 */
export function extractRecentImages(
  history: Content[],
  maxImages: number,
): ExtractedImage[] {
  if (maxImages <= 0) return [];

  const collected: ExtractedImage[] = [];

  outer: for (let i = history.length - 1; i >= 0; i--) {
    const content = history[i];
    for (const part of content.parts ?? []) {
      if (!part.inlineData?.mimeType?.startsWith('image/')) continue;

      // Look backward for the most recent model+functionCall to attribute
      // this image. Only count a call as the source if it sits at i-1
      // (the typical (model+fc, user+fr) pair shape).
      let sourceToolName: string | undefined;
      let sourceToolArgs: Record<string, unknown> | undefined;
      const prev = history[i - 1];
      if (prev?.role === 'model') {
        const fc = prev.parts?.find((p) => p.functionCall)?.functionCall;
        if (fc) {
          sourceToolName = fc.name ?? undefined;
          sourceToolArgs =
            (fc.args as Record<string, unknown> | undefined) ?? undefined;
        }
      }

      collected.unshift({
        part,
        turnIndex: i,
        sourceToolName,
        sourceToolArgs,
      });
      if (collected.length >= maxImages) break outer;
    }
  }

  return collected;
}
