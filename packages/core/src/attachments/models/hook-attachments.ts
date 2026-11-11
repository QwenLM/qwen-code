/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { rememberSessionStartHookOutput } from '../restore-context-helpers.js';
import type {
  AttachmentData,
  AttachmentToolUseContext,
} from '../types.js';
import { HookEventName } from '../../hooks/types.js';
import { systemReminder } from '../message-helpers.js';

/**
 * Simplified hook output (used by QueryEngine's hook adapter).
 * Event-driven: drained from ctx.pendingHookOutputs queue each turn.
 *
 * For the more precise hook types (blocking errors, success conditions, etc.),
 * see the HookAttachment sub-union below.
 */
export class HookOutputAttachment extends BaseAttachment {
  readonly type = 'hook_output' as const;
  declare hookEventName: HookEventName;
  declare output: string;
  /** Tool name for PreToolUse / PostToolUse events. */
  declare toolName?: string;

  constructor(data: AttachmentData<HookOutputAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    rememberSessionStartHookOutput(ctx, this.hookEventName, this.output);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const eventStr = String(this.hookEventName);
    if (!HOOK_OUTPUT_ALLOWED_EVENTS.has(eventStr)) return [];
    if (!this.output || !this.output.trim()) return [];
    const toolSuffix = this.toolName ? ` (tool: ${this.toolName})` : '';
    return [
      systemReminder(
        `${eventStr} hook additional context${toolSuffix}: ${this.output}`,
      ),
    ];
  }
}

/**
 * Hook execution produced a blocking error that stopped the tool call.
 * Normalized as <system-reminder>.
 */
export class HookBlockingErrorAttachment extends BaseAttachment {
  readonly type = 'hook_blocking_error' as const;
  /** Nested object containing the error description and triggering command. */
  declare blockingError: { blockingError: string; command: string };
  declare hookName: string;
  declare toolUseID: string;
  declare hookEvent: string;

  constructor(data: AttachmentData<HookBlockingErrorAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `${this.hookName} hook blocking error from command: ` +
          `"${this.blockingError.command}": ${this.blockingError.blockingError}`,
      ),
    ];
  }
}

/**
 * Hook execution produced a non-blocking error (logged but execution continues).
 * NOT sent to the provider.
 */
export class HookNonBlockingErrorAttachment extends BaseAttachment {
  readonly type = 'hook_non_blocking_error' as const;
  declare hookName: string;
  declare stderr: string;
  declare stdout: string;
  declare exitCode: number;
  declare toolUseID: string;
  declare hookEvent: string;
  declare command?: string;
  declare durationMs?: number;

  constructor(data: AttachmentData<HookNonBlockingErrorAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Not sent to provider — execution continues.
    return [];
  }
}

/**
 * An error occurred during hook execution (unexpected exception).
 * NOT sent to the provider.
 */
export class HookErrorDuringExecutionAttachment extends BaseAttachment {
  readonly type = 'hook_error_during_execution' as const;
  declare content: string;
  declare hookName: string;
  declare toolUseID: string;
  declare hookEvent: string;
  declare command?: string;
  declare durationMs?: number;

  constructor(data: AttachmentData<HookErrorDuringExecutionAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Not sent to provider.
    return [];
  }
}

/**
 * Hook executed successfully.
 * Only sent to provider for SessionStart / UserPromptSubmit hookEvent.
 * All other hookEvents return [].
 */
export class HookSuccessAttachment extends BaseAttachment {
  readonly type = 'hook_success' as const;
  declare content: string;
  declare hookName: string;
  declare toolUseID: string;
  declare hookEvent: string;
  declare stdout?: string;
  declare stderr?: string;
  declare exitCode?: number;
  declare command?: string;
  declare durationMs?: number;

  constructor(data: AttachmentData<HookSuccessAttachment>) {
    super(data);
  }

  override restoreAttachmentContext(ctx: AttachmentToolUseContext): void {
    rememberSessionStartHookOutput(ctx, this.hookEvent, this.content);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Only sent for SessionStart / UserPromptSubmit hookEvents.
    if (!HOOK_SUCCESS_SESSION_EVENTS.has(this.hookEvent)) return [];
    if (!this.content || !this.content.trim()) return [];
    return [systemReminder(`${this.hookName} hook success: ${this.content}`)];
  }
}

/**
 * Hook was cancelled (e.g. user aborted).
 * NOT sent to the provider.
 */
export class HookCancelledAttachment extends BaseAttachment {
  readonly type = 'hook_cancelled' as const;
  declare hookName: string;
  declare toolUseID: string;
  declare hookEvent: string;
  declare command?: string;
  declare durationMs?: number;

  constructor(data: AttachmentData<HookCancelledAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Not sent to provider.
    return [];
  }
}

/**
 * A Stop/TaskCompleted/TeammateIdle hook stopped agent continuation.
 * Normalized as <system-reminder>.
 */
export class HookStoppedContinuationAttachment extends BaseAttachment {
  readonly type = 'hook_stopped_continuation' as const;
  declare message: string;
  declare hookName: string;
  declare toolUseID: string;
  declare hookEvent: string;

  constructor(data: AttachmentData<HookStoppedContinuationAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `${this.hookName} hook stopped continuation: ${this.message}`,
      ),
    ];
  }
}

/**
 * A system-level message from a hook (shown in UI as "{hookName} says: {content}").
 * NOT sent to the provider.
 */
export class HookSystemMessageAttachment extends BaseAttachment {
  readonly type = 'hook_system_message' as const;
  declare content: string;
  declare hookName: string;
  declare toolUseID: string;
  declare hookEvent: string;

  constructor(data: AttachmentData<HookSystemMessageAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // UI-only display ("{hookName} says: {content}") — not sent to provider.
    return [];
  }
}

/**
 * Hook permission decision (allow/deny for a tool).
 * NOT sent to the provider.
 */
export class HookPermissionDecisionAttachment extends BaseAttachment {
  readonly type = 'hook_permission_decision' as const;
  declare decision: 'allow' | 'deny';
  declare toolUseID: string;
  declare hookEvent: string;

  constructor(data: AttachmentData<HookPermissionDecisionAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    // Internal permission decision — not sent to provider.
    return [];
  }
}

const HOOK_OUTPUT_ALLOWED_EVENTS = new Set<string>([
  HookEventName.SessionStart,
  HookEventName.Setup,
  HookEventName.UserPromptSubmit,
  'session_start', // legacy snake_case wire format
  'setup', // legacy snake_case wire format
  'user_prompt_submit', // legacy snake_case wire format
  HookEventName.PreToolUse,
  HookEventName.PostToolUse,
  HookEventName.PostToolUseFailure,
  HookEventName.PostCompact,
  HookEventName.SubagentStart,
]);

const HOOK_SUCCESS_SESSION_EVENTS = new Set<string>([
  HookEventName.SessionStart,
  HookEventName.UserPromptSubmit,
  'session_start',
  'user_prompt_submit',
]);
