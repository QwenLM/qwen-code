/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import {
  HOOK_OUTPUT_SPILL_PATH_PREFIX,
  HookEventName,
} from '../hooks/types.js';
import { sha1 } from '../utils/paths.js';
import type { AttachmentToolUseContext } from './types.js';

/** Historical fields remain unknown until checked at the restoration boundary. */
interface FileReadAttachmentData {
  type: string;
  filename?: unknown;
  mtime?: unknown;
  offset?: unknown;
  limit?: unknown;
  truncated?: unknown;
  isPartialView?: unknown;
  contentNotInModelContext?: unknown;
}

export function attachmentReadMetadata(attachment: FileReadAttachmentData) {
  const isReadReference = attachment.type === 'already_read_file';
  const offset = attachment.offset;
  const limit = attachment.limit;
  return {
    offset: typeof offset === 'number' ? offset : undefined,
    limit: typeof limit === 'number' ? limit : undefined,
    isPartialView:
      attachment['offset'] !== undefined ||
      attachment['limit'] !== undefined ||
      isReadReference ||
      attachment['truncated'] === true ||
      attachment['isPartialView'] === true,
    contentNotInModelContext:
      isReadReference ||
      attachment.type === 'edited_text_file' ||
      attachment['contentNotInModelContext'] === true,
  };
}

export function restoreReadFileState(
  ctx: AttachmentToolUseContext,
  attachment: FileReadAttachmentData,
  content: unknown,
  cwd: string,
): void {
  const filename = attachment['filename'];
  if (typeof filename !== 'string' || typeof content !== 'string') return;
  const filePath = resolve(cwd, filename);
  const isReadReference = attachment.type === 'already_read_file';
  // A deduplication notice adds no new file contents to model context.
  if (isReadReference && ctx.readFileState.has(filePath)) return;
  const mtime = attachment['mtime'];
  ctx.readFileState.set(filePath, {
    content,
    timestamp: typeof mtime === 'number' && Number.isFinite(mtime) ? mtime : 0,
    ...attachmentReadMetadata(attachment),
  });
}

/**
 * Stable identity for a SessionStart hook payload. Truncated output embeds a
 * per-run spill path, so that path is normalised away before hashing.
 */
export function sessionStartHookOutputFingerprint(output: string): string {
  const normalized = output.replace(
    new RegExp(`(${HOOK_OUTPUT_SPILL_PATH_PREFIX}).*$`, 'gm'),
    '$1<persisted>',
  );
  return sha1(normalized);
}

export function rememberSessionStartHookOutput(
  ctx: AttachmentToolUseContext,
  hookEvent: unknown,
  output: string,
): void {
  if (
    hookEvent !== HookEventName.SessionStart &&
    hookEvent !== 'session_start'
  ) {
    return;
  }
  if (output.trim().length === 0) return;
  ctx.seenSessionStartHookOutputs.add(
    sessionStartHookOutputFingerprint(output),
  );
}

export function applyNameDelta(
  target: Set<string>,
  added: unknown,
  removed: unknown,
): void {
  for (const name of stringArray(added)) target.add(name);
  for (const name of stringArray(removed)) target.delete(name);
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
