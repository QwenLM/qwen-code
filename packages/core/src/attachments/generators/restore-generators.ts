/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerRestoredFileReads } from '../transcript-state.js';

/**
 * @fileoverview Post-compact file restore attachment generator.
 *
 *   drainPostCompactRestoreAttachments() — one-shot queue drain
 *
 * Architecture:
 *   Candidates are collected by QueryEngine after compression via
 *   collectRecentReadFileCandidates() (compression-v2/post-compact-restore.ts),
 *   which applies per-file token budgets at collection time. This function
 *   drains the pre-truncated candidates and applies only the total token budget.
 *
 *   OLD (buggy): appended synthetic user message to newHistory — broke
 *   tool_use/tool_result adjacency when auto-compact fired at a turn boundary.
 *   NEW: drains ctx.postCompactCandidates as a per-request attachment on the
 *   next turn — runs before the API call, so tool ordering is preserved.
 */

import { estimateTokenCountSync } from '../../utils/tokenCalculation.js';
import {
  type Attachment,
  type AttachmentToolUseContext,
  PostCompactRestoredFilesAttachment,
  type PlanFileReferenceAttachment,
} from '../types.js';

/** Maximum number of files to restore. */
const POST_COMPACT_MAX_FILES = 5;

/** Total token budget across all restored files. */
const POST_COMPACT_FILE_TOKEN_BUDGET = 50_000;

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

  const candidates = ctx.postCompactCandidates.slice(0, POST_COMPACT_MAX_FILES);
  ctx.postCompactCandidates = null;

  if (candidates.length === 0) return [];

  let usedTokens = 0;
  const files: PostCompactRestoredFilesAttachment['files'] = [];

  for (const candidate of candidates) {
    const sectionText =
      `Previously opened file that may still matter:\n` +
      `Path: ${candidate.filePath}\n` +
      candidate.content;

    const sectionTokens = estimateTokenCountSync([{ text: sectionText }]);
    if (usedTokens + sectionTokens > POST_COMPACT_FILE_TOKEN_BUDGET) {
      break;
    }

    usedTokens += sectionTokens;
    files.push(candidate);
  }

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
