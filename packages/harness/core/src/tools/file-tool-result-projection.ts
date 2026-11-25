/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isFileEditResult,
  isFileWriteResult,
  type StructuredPatchHunk,
} from './tools.js';

/**
 * File tool results are retained in full inside the running process so the
 * interactive UI can render exact diffs. External transports and transcripts
 * receive this bounded projection instead of complete file contents.
 */
export const MAX_EXTERNAL_FILE_TOOL_DIFF_BYTES = 128 * 1024;

const DIFF_TRUNCATION_MARKER = '\n... [diff truncated]';

export interface CompactFileEditResult {
  success: true;
  file_path: string;
  diff?: string;
  diff_truncated?: true;
  additions: number;
  deletions: number;
}

export interface CompactFileWriteResult extends CompactFileEditResult {
  bytesWritten: number;
}

export type CompactFileToolResult =
  | CompactFileEditResult
  | CompactFileWriteResult;

export function isCompactFileToolResult(
  value: unknown,
): value is CompactFileToolResult {
  if (value === null || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return (
    result['success'] === true &&
    typeof result['file_path'] === 'string' &&
    typeof result['additions'] === 'number' &&
    typeof result['deletions'] === 'number' &&
    (result['diff'] === undefined || typeof result['diff'] === 'string') &&
    (result['diff_truncated'] === undefined ||
      result['diff_truncated'] === true)
  );
}

/**
 * Removes the full before/after file bodies from successful Edit and Write
 * results while preserving a useful, byte-bounded diff for SDK hosts and
 * resumed transcript display.
 */
export function projectFileToolResultForExternalUse(
  value: unknown,
): unknown {
  if (isFileEditResult(value)) {
    const patch = renderBoundedStructuredPatch(value.structuredPatch);
    return {
      success: true,
      file_path: value.filePath,
      ...(patch.diff ? { diff: patch.diff } : {}),
      ...(patch.truncated ? { diff_truncated: true as const } : {}),
      additions: patch.additions,
      deletions: patch.deletions,
    } satisfies CompactFileEditResult;
  }

  if (isFileWriteResult(value)) {
    const patch = renderBoundedStructuredPatch(value.structuredPatch);
    return {
      success: true,
      file_path: value.filePath,
      bytesWritten: Buffer.byteLength(value.content, 'utf8'),
      ...(patch.diff ? { diff: patch.diff } : {}),
      ...(patch.truncated ? { diff_truncated: true as const } : {}),
      additions: patch.additions,
      deletions: patch.deletions,
    } satisfies CompactFileWriteResult;
  }

  return value;
}

interface RenderedPatch {
  diff: string;
  truncated: boolean;
  additions: number;
  deletions: number;
}

function renderBoundedStructuredPatch(
  hunks: readonly StructuredPatchHunk[],
): RenderedPatch {
  const contentLimit =
    MAX_EXTERNAL_FILE_TOOL_DIFF_BYTES -
    Buffer.byteLength(DIFF_TRUNCATION_MARKER, 'utf8');
  let diff = '';
  let diffBytes = 0;
  let truncated = false;
  let additions = 0;
  let deletions = 0;

  const append = (text: string): void => {
    if (truncated) return;
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (diffBytes + textBytes <= contentLimit) {
      diff += text;
      diffBytes += textBytes;
      return;
    }

    diff += truncateUtf8(text, contentLimit - diffBytes);
    truncated = true;
  };

  for (const hunk of hunks) {
    append(
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`,
    );
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      if (line.startsWith('-')) deletions += 1;
      append(`${line}\n`);
    }
  }

  if (truncated) diff += DIFF_TRUNCATION_MARKER;
  return { diff, truncated, additions, deletions };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';

  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
