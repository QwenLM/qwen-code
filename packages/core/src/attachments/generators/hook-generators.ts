/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Hook output attachment generator.
 *
 *   drainHookOutputAttachments() — synchronous queue drain
 *
 * The queue (ctx.pendingHookOutputs) is populated by the agent loop when
 * hook results contain additionalContext or stdout for model injection.
 * Each item is emitted as a typed attachment and then normalized before the
 * next API request. Some attachment types become <system-reminder> messages;
 * others are transcript/UI-only and normalize to [].
 *
 * The `sourceType` field on PendingHookOutput determines which attachment
 * type is produced:
 *   'stdout'           → hook_success     (reaches model for SessionStart/UserPromptSubmit)
 *   'systemMessage'    → hook_system_message (UI-only, never to model)
 *   'blockingError'    → hook_blocking_error (system-reminder to model)
 *   'stoppedContinuation' → hook_stopped_continuation
 *   'additionalContext' / undefined → hook_output (default)
 *
 * Prebuilt HookAttachment entries from ctx.pendingHookAttachments are drained
 * through the same attachment pipeline. Provider visibility is decided later
 * by normalizeAttachmentForAPI() for each attachment type.
 */

import { HookSuccessAttachment } from '../models/hook-attachments.js';
import { HookSystemMessageAttachment } from '../models/hook-attachments.js';
import { HookBlockingErrorAttachment } from '../models/hook-attachments.js';
import { HookStoppedContinuationAttachment } from '../models/hook-attachments.js';
import { HookOutputAttachment } from '../models/hook-attachments.js';
import { HookEventName, type PendingHookOutput } from '../../hooks/types.js';
import { sessionStartHookOutputFingerprint } from '../restore-context-helpers.js';
import type { Attachment, AttachmentToolUseContext } from '../types.js';

/**
 * Enqueue a hook payload for the next drain.
 *
 * Owns the SessionStart de-duplication so every producer gets it: the same
 * SessionStart context can be offered by several entry points (and is already
 * present in restored transcript history), and queueing it twice would inject
 * a second copy into the model prefix.
 */
export function enqueueHookOutput(
  ctx: AttachmentToolUseContext,
  payload: PendingHookOutput,
): void {
  if (payload.hookEventName === HookEventName.SessionStart) {
    const fingerprint = sessionStartHookOutputFingerprint(payload.output);
    if (ctx.seenSessionStartHookOutputs.has(fingerprint)) return;
    ctx.seenSessionStartHookOutputs.add(fingerprint);
  }
  ctx.pendingHookOutputs.push(payload);
}

/**
 * Drain all pending hook outputs from the context queue.
 *
 * Returns the drained items as typed Attachment array and clears the queue.
 * This is a synchronous operation — no I/O involved.
 */
export function drainHookOutputAttachments(
  ctx: AttachmentToolUseContext,
): Attachment[] {
  const result: Attachment[] = [];

  if (ctx.pendingHookOutputs.length > 0) {
    const outputs = ctx.pendingHookOutputs.splice(0);
    for (const o of outputs) {
      const base = {
        hookName: o.hookName ?? '',
        toolUseID: o.toolName ?? '',
        hookEvent: o.hookEventName,
      };

      switch (o.sourceType) {
        case 'stdout':
          result.push(
            new HookSuccessAttachment({
              type: 'hook_success' as const,
              content: o.output,
              ...base,
            }),
          );
          break;
        case 'systemMessage':
          result.push(
            new HookSystemMessageAttachment({
              type: 'hook_system_message' as const,
              content: o.output,
              ...base,
            }),
          );
          break;
        case 'blockingError':
          result.push(
            new HookBlockingErrorAttachment({
              type: 'hook_blocking_error' as const,
              blockingError: {
                blockingError: o.output,
                command: o.hookCommand ?? '',
              },
              ...base,
            }),
          );
          break;
        case 'stoppedContinuation':
          result.push(
            new HookStoppedContinuationAttachment({
              type: 'hook_stopped_continuation' as const,
              message: o.output,
              ...base,
            }),
          );
          break;
        case 'additionalContext':
        default:
          // Default: backward-compatible hook_output for external callers
          // (remotecontrol, TUI) and additionalContext entries.
          result.push(
            new HookOutputAttachment({
              type: 'hook_output' as const,
              hookEventName: o.hookEventName,
              output: o.output,
              toolName: o.toolName,
            }),
          );
          break;
      }
    }
  }

  // Drain prebuilt hook attachments; normalizeAttachmentForAPI decides whether
  // each attachment type reaches the provider.
  if (ctx.pendingHookAttachments?.length > 0) {
    const attachments = ctx.pendingHookAttachments.splice(0);
    result.push(...(attachments as Attachment[]));
  }

  return result;
}
