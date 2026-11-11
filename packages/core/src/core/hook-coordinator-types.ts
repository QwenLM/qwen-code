/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookAttachment } from '../attachments/types.js';
import type { StopFailureErrorType, StopFailureOptions } from '../hooks/types.js';
import type { BusinessInfo } from '../qoder/business-info.js';

// ---------------------------------------------------------------------------
// Hook Result Types
// ---------------------------------------------------------------------------

export interface HookBeforeResult {
  stopped?: boolean;
  /** Shown to user, not sent to model. */
  stopReason?: string;
  blocked?: boolean;
  /** From JSON hook additionalContext field. */
  additionalContext?: string;
  /** SessionStart/UserPromptSubmit only. */
  stdoutForModel?: string;
  /** UserPromptSubmit only. */
  sessionTitle?: string;
  systemMessage?: string;
  suppressOutput?: boolean;
  pendingAttachments?: HookAttachment[];
}

export interface HookAfterResult {
  stopped?: boolean;
  blocked?: boolean;
  /** Text to inject as a continuation prompt. */
  inject?: string;
  clearContext?: boolean;
  /** Triggered from the Stop hook retry path. */
  retryAsStopHook?: boolean;
  systemMessage?: string;
  additionalContext?: string;
  suppressOutput?: boolean;
  pendingAttachments?: HookAttachment[];
}

// ---------------------------------------------------------------------------
// Adapter Interface
// ---------------------------------------------------------------------------

export interface HookCoordinatorAdapter {
  /**
   * Fires at most once per promptId (deduped). Subsequent calls with the
   * same promptId return null.
   */
  fireBefore(
    promptId: string,
    prompt: string,
    imageUrls?: readonly string[],
    requestSetId?: string,
    signal?: AbortSignal,
  ): Promise<HookBeforeResult | null>;

  /**
   * Only fires when the agent loop has completed (no pending tool calls)
   * and this is the outermost call (not inside a recursive hook continuation).
   */
  fireAfter(
    promptId: string,
    prompt: string,
    response: string,
    options?: {
      requestId?: string;
      stopHookActive?: boolean;
      parentRequestSetId?: string;
      parentBusinessInfo?: Readonly<BusinessInfo>;
      customContext?: Readonly<Record<string, string>>;
      /** Model used for the assistant response that caused this event. */
      model?: string;
    },
  ): Promise<HookAfterResult | null>;

  /** Drain context from background async hooks completed since last call. */
  drainPendingAsyncContext(): string | undefined;

  fireStopFailure(
    error: StopFailureErrorType,
    options?: StopFailureOptions,
    signal?: AbortSignal,
    model?: string,
  ): Promise<void>;

  dispose(): void;
}
