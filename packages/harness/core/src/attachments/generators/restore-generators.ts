/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { estimateTextTokens } from '../../utils/tokenCalculation.js';
import { registerRestoredFileReads } from '../transcript-state.js';
import {
  type Attachment,
  type AttachmentToolUseContext,
  PostCompactRestoredFilesAttachment,
  type PlanFileReferenceAttachment,
} from '../types.js';

/** Maximum number of files to restore. */
export const POST_COMPACT_MAX_FILES = 5;

/** Total token budget across all restored files. */
const POST_COMPACT_FILE_TOKEN_BUDGET = 50_000;

export function selectFilesWithinBudget(
  candidates: Readonly<PostCompactRestoredFilesAttachment['files']>,
): PostCompactRestoredFilesAttachment['files'] {
  const picked: PostCompactRestoredFilesAttachment['files'] = [];
  let used = 0;
  for (const candidate of candidates.slice(0, POST_COMPACT_MAX_FILES)) {
    const attachment = candidate.referenceOnly
      ? {
          type: 'compact_file_reference',
          filename: candidate.filePath,
          displayPath: candidate.displayPath ?? candidate.filePath,
        }
      : {
          type: 'file',
          filename: candidate.filePath,
          content: candidate.readResult ?? candidate.content,
          displayPath: candidate.displayPath ?? candidate.filePath,
        };
    const sectionTokens = estimateTextTokens(JSON.stringify(attachment));
    if (used + sectionTokens > POST_COMPACT_FILE_TOKEN_BUDGET) continue;
    used += sectionTokens;
    picked.push(candidate);
  }
  return picked;
}

// ── drainPostCompactRestoreAttachments ────────────────────────────────────────

/**
 * Drain ctx.postCompactCandidates and return a PostCompactRestoredFilesAttachment.
 *
 * One-shot: after draining, ctx.postCompactCandidates is set back to null.
 * Returns [] if no restoration is pending.
 *
 * Candidates are already truncated to per-file limits at collection time.
 * This function only applies the total token budget (50,000 tokens).
 */
export function drainPostCompactRestoreAttachments(
  ctx: AttachmentToolUseContext,
): PostCompactRestoredFilesAttachment[] {
  if (ctx.postCompactCandidates === null) return [];

  const files = selectFilesWithinBudget(ctx.postCompactCandidates);
  ctx.postCompactCandidates = null;

  if (files.length === 0) return [];

  registerRestoredFileReads(ctx.fileReadState, files);
  return [
    new PostCompactRestoredFilesAttachment({
      type: 'post_compact_restored_files' as const,
      files,
    }),
  ];
}

// ── drainPostCompactPlanAttachment ────────────────────────────────────────────

/**
 * Drain ctx.postCompactPlanAttachment and return a PlanFileReferenceAttachment.
 *
 * One-shot: after draining, ctx.postCompactPlanAttachment is set back to null.
 * Returns [] if no plan attachment is pending.
 *
 * Called by get-attachments.ts on the turn after context compaction to restore
 * the approved plan content so the model does not need to re-read it.
 */
export function drainPostCompactPlanAttachment(
  ctx: AttachmentToolUseContext,
): PlanFileReferenceAttachment[] {
  const attachment = ctx.postCompactPlanAttachment;
  if (!attachment) return [];
  ctx.postCompactPlanAttachment = null;
  return [attachment];
}

// ── drainPendingPostCompactDeltaAttachments ───────────────────────────────────

/**
 * Drain ctx.pendingPostCompactDeltaAttachments and return the queued attachments.
 *
 * These are delta attachments (agent listing, MCP instructions, plan mode, etc.)
 * deferred when compaction fires mid tool-call (hasPendingToolTail=true). Stored
 * as unwrapped `Attachment` objects so they flow through the normal `getAttachments()`
 * pipeline (which returns `Attachment[]` and wraps them in `getAttachmentMessages()`).
 *
 * One-shot: after draining, ctx.pendingPostCompactDeltaAttachments is set to null.
 * Returns [] if no deferred delta attachments are pending.
 */
export function drainPendingPostCompactDeltaAttachments(
  ctx: AttachmentToolUseContext,
): Attachment[] {
  const pending = ctx.pendingPostCompactDeltaAttachments;
  if (!pending || pending.length === 0) {
    ctx.pendingPostCompactDeltaAttachments = null;
    return [];
  }
  ctx.pendingPostCompactDeltaAttachments = null;
  return pending;
}
