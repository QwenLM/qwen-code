/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { registerRestoredFileReads } from '../attachments/transcript-state.js';

/**
 * @fileoverview Shared post-compact application logic.
 *
 * `applyPostCompact()` is the canonical implementation that replaces the
 * duplicate logic previously spread across:
 *   - QueryEngine.applyPostCompact()   (engine/query-engine.ts)
 *   - TUI persistPostCompact()         (ui/hooks/useLocalTuiSessionOrchestrator.ts)
 *
 * Both callers now construct an `ApplyPostCompactCallbacks` bag and delegate
 * to this function, ensuring identical post-compact behavior.
 *
 * Steps performed:
 *   1. Replace runtime messages with newHistory (fixes drift bug).
 *   2. Keep the pre-compact transcript parent as the logical boundary parent.
 *   3+5. In parallel: await recordMessages(boundaryHead) AND finalizePostCompact().
 *   4. (No-op) UI stats are NOT updated here — the next API response provides the authoritative value.
 *   6a. If hasPendingToolTail: enqueue attachments to ctx drain queues and
 *       return newHistory (attachments are injected inter-turn after tool_result).
 *   6b. If !hasPendingToolTail:
 *       - Push attachment messages into runtime history.
 *       - Return [...newHistory, ...attachmentMessages].
 */

import type { Config } from '../config/config.js';
import type {
  Attachment,
  AttachmentMessage,
  AttachmentToolUseContext,
  AttachmentExternalContext,
  PlanFileReferenceAttachment,
  PostCompactRestoredFilesAttachment,
} from '../attachments/types.js';
import { restoreAttachment } from '../attachments/transcript-conversion.js';
import type { Message } from '../protocol/transcript/message.js';
import type { TranscriptWriterHandle } from '../services/transcript/writer-handle.js';
import { HookEventName } from '../hooks/types.js';
import {
  finalizePostCompact,
  type FinalizePostCompactArgs,
} from './post-compact-finalize.js';
import { runLogger } from '../utils/runLogger.js';

// ============================================================================
// Callbacks interface
// ============================================================================

/**
 * Caller-supplied callbacks that abstract per-caller state storage.
 *
 * QueryEngine uses class fields; TUI uses React refs.  Both implement this
 * same interface so `applyPostCompact()` can be caller-agnostic.
 */
export interface ApplyPostCompactCallbacks {
  /**
   * Atomically replace the runtime message array with `msgs`.
   * Called once, at the very start, to fix the drift bug (prior impl only
   * pushed attachment messages without ever replacing with newHistory).
   */
  replaceMessages(msgs: Message[]): void;

  /**
   * Push each attachment message onto the runtime message array.
   */
  pushAttachments(msgs: Message[]): void;

  /** Returns the current lastTranscriptParentUuid (may be null). */
  transcriptParentUuid(): string | null;

  /**
   * Called to advance (or clear) lastTranscriptParentUuid.
   * `null` clears the chain (e.g., no messages in new history).
   */
  setTranscriptParentUuid(uuid: string | null): void;

  /** Transcript writer for persisting boundary + attachments. */
  transcriptWriter?: TranscriptWriterHandle | null;

  /** Mutable attachment pipeline context. */
  attachmentCtx: AttachmentToolUseContext;

  /** External system references for agent listing / MCP delta generators. */
  externalContext?: AttachmentExternalContext;

  /** App config — for plan path, skill manager, plan-mode state. */
  config: Config;

  /**
   * Invoked *after* the compact_boundary marker has been persisted to the
   * transcript. Used by the TUI to add a scrollback row atomically with the
   * JSONL write: if persistence fails, the UI never renders a banner for a
   * compaction that didn't really happen. Omitting this callback (e.g. the
   * SDK/QueryEngine path) is the correct scoping — subagent pipelines don't
   * pass it, so their compactions don't bubble into the main scrollback.
   */
  onCompactionPersisted?: (
    boundary: Extract<Message, { type: 'system' }>,
  ) => void;
}

// ============================================================================
// applyPostCompact
// ============================================================================

function getTranscriptWriterSessionId(
  writer: TranscriptWriterHandle | null | undefined,
): string {
  return typeof writer?.getSessionId === 'function'
    ? writer.getSessionId()
    : 'unknown';
}

/** True for the SessionStart hook outputs the pipeline appends to newHistory. */
function isSessionStartHookOutput(message: Message): boolean {
  if (message.type !== 'attachment') return false;
  const attachment = message.attachment;
  if (attachment.type === 'hook_output') {
    return attachment['hookEventName'] === HookEventName.SessionStart;
  }
  if (attachment.type === 'hook_success') {
    return attachment['hookEvent'] === HookEventName.SessionStart;
  }
  return false;
}

/**
 * Answers whether a uuid is already on the transcript, i.e. whether writing it
 * again would duplicate an existing entry. Writers without the capability
 * (test doubles, or a handle that is already closed) report everything as new;
 * `recordMessages` surfaces the real failure when it actually writes.
 */
function createPersistedLookup(
  writer: TranscriptWriterHandle | null | undefined,
): (uuid: string) => boolean {
  if (typeof writer?.hasMessageUuid !== 'function') return () => false;
  return (uuid) => {
    try {
      return writer.hasMessageUuid(uuid);
    } catch {
      return false;
    }
  };
}

/**
 * Apply post-compact recovery to runtime state and the transcript.
 *
 * @param priorHistory - The history BEFORE compression ran.
 * @param newHistory   - The history AFTER compression (summary ± tool tail).
 * @param cb           - Caller-supplied callback bag.
 * @returns The extended history: `[...newHistory, ...attachmentMessages]`
 *          on the normal path, or just `newHistory` when a tool tail is present
 *          (attachments are injected inter-turn instead).
 */
export async function applyPostCompact(
  priorHistory: readonly Message[],
  newHistory: readonly Message[],
  cb: ApplyPostCompactCallbacks,
): Promise<readonly Message[]> {
  // ── 1. Replace runtime messages ─────────────────────────────────────────
  // Critical drift-fix: previous implementations only appended attachment
  // messages to the original (pre-compression) this.messages, so the
  // compressed summary was never installed as the new baseline.
  cb.replaceMessages([...newHistory]); // spread so the caller owns a mutable copy

  // ── 2. Capture the pre-compact parentUuid ───────────────────────────────
  // The compact boundary must point logically to the transcript leaf that
  // existed before compression. Advancing the parent before persistence would
  // make the boundary point at the compact summary that follows it.
  const preCompactParentUuid = cb.transcriptParentUuid();

  // ── 3. Persist boundary marker + compact summary ─────────────────────────
  // Extract the compact_boundary system message + isCompactSummary user
  // message prepended by the compression pipeline.
  const boundaryHead: Message[] = [];
  for (const msg of newHistory) {
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      boundaryHead.push(msg);
      continue;
    }
    if (msg.isCompactSummary || msg.isCompactionPrefix) {
      boundaryHead.push(msg);
      continue;
    }
    break;
  }

  // SessionStart outputs are pushed into newHistory by the compression
  // pipeline and never reach finalizePostCompact, so they are persisted here.
  // Only the ones this compaction generated belong in this write: partial
  // compaction (`up_to`) keeps the verbatim `toKeep` slice in newHistory, which
  // can still contain an attachment an earlier compaction already wrote. Its
  // uuid is on the transcript already, and the writer only skips an
  // already-written prefix — a second append would duplicate the node and hang
  // every later message (fresh hooks, recovery attachments) off the copy.
  const isPersisted = createPersistedLookup(cb.transcriptWriter);
  const sessionStartHooks = newHistory.filter(
    (message) =>
      !message.isCompactionPrefix && isSessionStartHookOutput(message),
  );
  const hookMessages = sessionStartHooks.filter(
    (message) => !isPersisted(message.uuid),
  );

  // ── 3 & 5. Persist boundary head and build recovery attachments in parallel ─
  // These are independent: recordMessages writes the boundary+summary+hooks to
  // JSONL, while finalizePostCompact reads priorHistory/newHistory to generate
  // file-restore and delta attachments. Running them concurrently saves one
  // I/O round-trip on every compact event.

  // Hook outputs are persisted whether or not the boundary could be located.
  // Partial compaction with `direction: 'from'` renders [...toKeep, boundary,
  // summary], so the boundary sits mid-history and `boundaryHead` stays empty;
  // dropping the hooks there would leave them in runtime history only and they
  // would vanish on resume.
  const boundaryWriteAttempted =
    cb.transcriptWriter != null &&
    (boundaryHead.length > 0 || hookMessages.length > 0);
  if (boundaryHead.length === 0 && hookMessages.length > 0) {
    runLogger.warn(
      'transcript.compaction.boundary_not_persisted',
      `session=${getTranscriptWriterSessionId(cb.transcriptWriter)}`,
      'reason=boundary_head_not_at_history_start',
      `session_start_hooks=${hookMessages.length}`,
    );
  }

  const [transcriptResult, finalizeResult] = await Promise.allSettled([
    // Step 3: persist boundary marker + compact summary + hook outputs
    (async () => {
      if (!boundaryWriteAttempted || !cb.transcriptWriter) return null;
      try {
        const newParent = await cb.transcriptWriter.recordMessages(
          [...boundaryHead, ...hookMessages],
          preCompactParentUuid,
        );
        const boundary = boundaryHead.find(
          (message) =>
            message.type === 'system' && message.subtype === 'compact_boundary',
        );
        const preservedTail =
          boundary?.type === 'system'
            ? boundary.compactMetadata?.preservedSegment?.tailUuid
            : undefined;
        if (
          preservedTail &&
          typeof cb.transcriptWriter.recordActiveLeaf === 'function'
        ) {
          const retainedParent = hookMessages.at(-1)?.uuid ?? preservedTail;
          // The preserved records predate this boundary physically. Select the
          // tail explicitly so an immediate resume does not stop at the prefix.
          await cb.transcriptWriter.recordActiveLeaf(retainedParent, {
            explicit: false,
            durable: true,
          });
          return retainedParent;
        }
        return newParent;
      } catch (err) {
        runLogger.warn(
          'transcript.compaction.persist_failed',
          `session=${getTranscriptWriterSessionId(cb.transcriptWriter)}`,
          `boundary_head=${boundaryHead.length}`,
          `error=${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    })(),

    // Step 5: build post-compact recovery attachments
    (async () => {
      const args: FinalizePostCompactArgs = {
        workingHistory: priorHistory,
        newHistory,
        targetDir: cb.attachmentCtx.cwd,
        ctx: cb.attachmentCtx,
        externalContext: cb.externalContext,
        config: cb.config,
      };
      return finalizePostCompact(args);
    })(),
  ]);

  const boundaryMarker = boundaryHead.find(
    (msg): msg is Extract<Message, { type: 'system' }> =>
      msg.type === 'system' && msg.subtype === 'compact_boundary',
  );

  // Apply transcript parentUuid from step 3 AND notify UI via caller
  // callback — paired so the scrollback row is added iff the JSONL write
  // succeeded.
  /** Parent uuid written by step 3, or null when the boundary did not persist. */
  const boundaryParentUuid =
    transcriptResult.status === 'fulfilled' ? transcriptResult.value : null;
  if (boundaryParentUuid !== null) {
    cb.setTranscriptParentUuid(boundaryParentUuid);
    runLogger.log(
      'transcript.compaction.persisted',
      `session=${getTranscriptWriterSessionId(cb.transcriptWriter)}`,
      `boundary_head=${boundaryHead.length}`,
      `compact_summary_messages=${boundaryHead.filter((msg) => msg.isCompactSummary === true).length}`,
      `session_start_hooks=${hookMessages.length}`,
      `session_start_hooks_kept=${sessionStartHooks.length - hookMessages.length}`,
      `pre_parent=${preCompactParentUuid ?? 'none'}`,
      `new_parent=${boundaryParentUuid}`,
    );
    if (boundaryMarker) {
      cb.onCompactionPersisted?.(boundaryMarker);
    }
  }

  // Bail if finalize failed
  if (finalizeResult.status === 'rejected') {
    runLogger.warn(
      'transcript.compaction.finalize_failed',
      `session=${getTranscriptWriterSessionId(cb.transcriptWriter)}`,
      `error=${finalizeResult.reason instanceof Error ? finalizeResult.reason.message : String(finalizeResult.reason)}`,
    );
    return newHistory;
  }
  const { attachmentMessages, hasPendingToolTail } = finalizeResult.value;

  // ── 4. UI stats — NOT updated here ──────────────────────────────────
  // The status bar update is handled by agent-loop.ts immediately after
  // compression completes, where systemPrompt and toolSchemas are available
  // to compute an accurate estimate (compressedMsgTokens + systemPrompt +
  // tools). This module lacks that context, so any calculation here would
  // be inaccurate (the old delta approach produced ~1% due to mismatched
  // token baselines).

  if (attachmentMessages.length === 0) {
    return newHistory;
  }

  // ── 6a. Tool tail — defer injection via ctx drain queues ─────────────────
  if (hasPendingToolTail) {
    _enqueueDeferredAttachments(cb.attachmentCtx, attachmentMessages);
    return newHistory;
  }

  // ── 6b. Normal path — persist and inject attachments ────────────────────
  if (boundaryWriteAttempted && boundaryParentUuid === null) {
    runLogger.warn(
      'transcript.compaction.attachments_persist_skipped',
      `session=${getTranscriptWriterSessionId(cb.transcriptWriter)}`,
      `attachments=${attachmentMessages.length}`,
      'reason=boundary_persist_failed',
    );
  } else {
    await persistAttachmentMessages(cb, attachmentMessages);
  }
  cb.pushAttachments(attachmentMessages);
  for (const message of attachmentMessages) {
    const attachment = restoreAttachment(message.attachment);
    if (attachment?.type === 'post_compact_restored_files')
      registerRestoredFileReads(
        cb.attachmentCtx.fileReadState,
        attachment.files,
      );
  }

  return [...newHistory, ...attachmentMessages];
}

async function persistAttachmentMessages(
  cb: ApplyPostCompactCallbacks,
  attachmentMessages: readonly AttachmentMessage[],
): Promise<void> {
  if (!cb.transcriptWriter || attachmentMessages.length === 0) return;
  try {
    const parentUuid = await cb.transcriptWriter.recordMessages(
      attachmentMessages,
      cb.transcriptParentUuid(),
    );
    cb.setTranscriptParentUuid(parentUuid);
  } catch (error) {
    runLogger.warn(
      'transcript.compaction.attachments_persist_failed',
      `session=${getTranscriptWriterSessionId(cb.transcriptWriter)}`,
      `attachments=${attachmentMessages.length}`,
      `error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ============================================================================
// Private helpers
// ============================================================================

/**
 * Partition attachment messages into file/plan/delta buckets and enqueue
 * them on the ctx drain queues. They will be drained by the inter-turn
 * attachment pass (get-attachments.ts) once the pending tool_result arrives.
 */
function _enqueueDeferredAttachments(
  ctx: AttachmentToolUseContext,
  attachmentMessages: AttachmentMessage[],
): void {
  let fileAttachment: PostCompactRestoredFilesAttachment | undefined;
  let planAttachment: PlanFileReferenceAttachment | undefined;
  const deltaAttachments: Attachment[] = [];

  for (const m of attachmentMessages) {
    const attachment = restoreAttachment(m.attachment);
    if (!attachment) continue;
    if (attachment.type === 'post_compact_restored_files') {
      fileAttachment ??= attachment;
    } else if (attachment.type === 'plan_file_reference') {
      planAttachment ??= attachment;
    } else {
      deltaAttachments.push(attachment);
    }
  }

  if (fileAttachment) {
    ctx.postCompactCandidates = fileAttachment.files ?? [];
  }

  if (planAttachment) {
    ctx.postCompactPlanAttachment = planAttachment;
  }

  if (deltaAttachments.length > 0) {
    // Store unwrapped Attachment objects so they flow through the normal
    // getAttachments() → getAttachmentMessages() pipeline on the next turn.
    ctx.pendingPostCompactDeltaAttachments = deltaAttachments;
  }
}
