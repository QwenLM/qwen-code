/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Converts HookExecutionResult[] into typed HookAttachment[].
 *
 * Produces prebuilt hook attachments for failed/cancelled/errored hook results
 * and for system messages. These are placed in
 * AttachmentToolUseContext.pendingHookAttachments and drained by
 * drainHookOutputAttachments() each turn; provider visibility is determined by
 * normalizeAttachmentForAPI() for each attachment type.
 *
 * `hookName` uses the `<event>` or `<event>:<matchQuery>` format
 * (e.g. `PreToolUse:Bash`, `SessionStart:startup`, `UserPromptSubmit`). The
 * attachment's `stderr` field carries display text for shell command
 * hooks (`Failed with non-blocking status code: ...` / `Failed to run: ...`).
 * Raw stderr/stdout/exitCode remain on `HookExecutionResult` for reporting
 * and the `system.hook_response` wire stream.
 */

import {
  HookNonBlockingErrorAttachment,
  HookErrorDuringExecutionAttachment,
  HookCancelledAttachment,
  HookSystemMessageAttachment,
  type HookAttachment,
  HookStoppedContinuationAttachment,
} from '../attachments/types.js';
import { EXIT_CODE_BLOCK } from './hookRunner.js';
import { HookType, getHookIdentity } from './types.js';
import type { HookExecutionResult } from './types.js';

/**
 * Optional context for attachment construction. `matchQuery` is forwarded
 * from the planner (toolName for tool events, source/trigger otherwise) and
 * appended to the event name as `<event>:<matchQuery>` for CC parity.
 */
export interface HookAttachmentContext {
  toolUseID?: string;
  matchQuery?: string;
}

/**
 * Build the CC-compatible display stderr for a non-blocking error attachment.
 * For Command hooks the wrap differs by failure cause; for HTTP/Agent/Prompt
 * (non-Command) we keep the raw error message without the shell-specific
 * prefix, matching CC's renderer behavior.
 */
function buildDisplayStderr(result: HookExecutionResult): string {
  if (result.failureKind === 'schema') {
    // Schema validation messages are self-contained and already actionable
    // (e.g. `hookSpecificOutput is missing required field "hookEventName" Did
    // you mean ...?`). The TUI's udoFormat picks the first line and clamps
    // it; SDK consumers receive the multi-line dump verbatim via
    // HookAttachment.stderr.
    return (
      result.stderr?.trim() ||
      result.error?.message ||
      'Hook output failed schema validation'
    );
  }
  if (result.hookConfig.type === HookType.Command) {
    const prefix =
      result.failureKind === 'spawn'
        ? 'Failed to run'
        : 'Failed with non-blocking status code';
    const detail = result.failureKind
      ? result.error?.message
      : result.stderr?.trim();
    return `${prefix}: ${detail || 'No stderr output'}`;
  }
  const raw = result.stderr?.trim();
  if (raw) return raw;
  return result.error?.message ?? '';
}

/**
 * Convert a list of hook execution results into prebuilt HookAttachments.
 *
 * Called at each hook fire-site (PreToolUse, PostToolUse, PostToolUseFailure,
 * UserPromptSubmit, Stop, PermissionRequest, etc.) so that errors/messages
 * are recorded in pendingHookAttachments and drained into the attachment
 * stream on the next turn. Whether they become provider messages is decided
 * later by attachment normalization.
 *
 * @param results    Raw results from hookRunner.executeHooks*()
 * @param eventName  Hook event name (`PreToolUse`, `Stop`, etc.)
 * @param context    Optional `toolUseID` and `matchQuery` (forwarded from the
 *                   planner). When `matchQuery` is set, `hookName` becomes
 *                   `<event>:<matchQuery>` to match CC.
 */
export function hookResultsToAttachments(
  results: HookExecutionResult[],
  eventName: string,
  context: HookAttachmentContext = {},
): HookAttachment[] {
  if (results.length === 0) return [];

  const toolUseID = context.toolUseID ?? '';
  const hookName = getHookIdentity(eventName, context.matchQuery);

  const attachments: HookAttachment[] = [];

  for (const result of results) {
    const command =
      result.hookConfig.type === HookType.Command
        ? result.hookConfig.command
        : undefined;
    const durationMs = result.duration;

    // Emit system messages from successful (or any) hooks first.
    // suppressOutput gates visibility — same logic as hookEventHandler's
    // existing coreEvents.emitHookSystemMessage path.
    if (result.output?.systemMessage && !result.output.suppressOutput) {
      const systemMsgAttachment: HookSystemMessageAttachment =
        new HookSystemMessageAttachment({
          type: 'hook_system_message',
          content: result.output.systemMessage,
          hookName,
          toolUseID,
          hookEvent: eventName,
        });
      attachments.push(systemMsgAttachment);
    }

    if (result.success) continue;

    const outcome = result.outcome;

    if (outcome === 'cancelled' || result.failureKind === 'cancelled') {
      const att: HookCancelledAttachment = new HookCancelledAttachment({
        type: 'hook_cancelled',
        hookName,
        toolUseID,
        hookEvent: eventName,
        command,
        durationMs,
      });
      attachments.push(att);
      continue;
    }

    // exit 2 (EXIT_CODE_BLOCK) is the blocking/policy-denial exit code.
    // Those are handled upstream (blockingError path) — skip here to avoid
    // double-reporting.
    if (result.exitCode === EXIT_CODE_BLOCK) continue;

    // Internal-execution failures (Runtime callback throws, etc.) render as
    // dim "hook warning" with no body — matches CC's hook_error_during_execution
    // for callback / function / JSON-input / output-schema-mismatch paths.
    if (result.hookConfig.type === HookType.Runtime && result.error) {
      const att: HookErrorDuringExecutionAttachment =
        new HookErrorDuringExecutionAttachment({
          type: 'hook_error_during_execution',
          content: result.error.message,
          hookName,
          toolUseID,
          hookEvent: eventName,
          command,
          durationMs,
        });
      attachments.push(att);
      continue;
    }

    // All other failures (shell non-zero, spawn failure, HTTP/Agent/Prompt
    // runtime errors, timeouts) render as red `<hookName> hook error` with
    // a CC-formatted body line.
    const att: HookNonBlockingErrorAttachment =
      new HookNonBlockingErrorAttachment({
        type: 'hook_non_blocking_error',
        hookName,
        stderr: buildDisplayStderr(result),
        stdout: result.stdout ?? '',
        exitCode: result.exitCode ?? -1,
        toolUseID,
        hookEvent: eventName,
        command,
        durationMs,
      });
    attachments.push(att);
  }

  return attachments;
}

/**
 * Create a hook_stopped_continuation attachment for signaling the agent loop
 * to terminate the current turn.
 */
export function createStopContinuationAttachment(
  message: string,
  hookEvent: string,
  toolName: string,
  toolUseID: string,
): HookStoppedContinuationAttachment {
  return new HookStoppedContinuationAttachment({
    type: 'hook_stopped_continuation',
    message,
    hookName: getHookIdentity(hookEvent, toolName),
    toolUseID,
    hookEvent,
  });
}
