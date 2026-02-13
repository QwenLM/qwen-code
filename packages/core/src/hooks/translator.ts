/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HookInput,
  PreToolUseInput,
  PostToolUseInput,
  PermissionRequestInput,
  UserPromptSubmitInput,
  StopInput,
  SubagentStopInput,
  NotificationInput,
  SessionStartInput,
  SessionEndInput,
  PreCompactInput,
  PreToolUseOutput,
  PostToolUseOutput,
  PermissionRequestOutput,
  UserPromptSubmitOutput,
  StopOutput,
  SubagentStopOutput,
  NotificationOutput,
  SessionStartOutput,
  SessionEndOutput,
  PreCompactOutput,
} from './types.js';
import type {
  NotificationType,
  SessionStartSource,
  SessionEndReason,
  PreCompactTrigger,
} from './types.js';

/**
 * SDK-specific types that need translation
 * These represent internal types that should be decoupled from hook interface
 */
export interface SDKToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface SDKToolResponse {
  id: string;
  output: Record<string, unknown>;
  isError?: boolean;
}

export interface SDKUserPrompt {
  prompt: string;
  context?: Record<string, unknown>;
}

/**
 * HookTranslator converts SDK-specific types to stable hook formats
 * This ensures backward compatibility for hook developers
 */
export class HookTranslator {
  /**
   * Translate PreToolUse event from SDK format to hook input
   */
  static translatePreToolUse(
    baseInput: HookInput,
    toolUse: SDKToolUse,
  ): PreToolUseInput {
    return {
      ...baseInput,
      tool_name: toolUse.name,
      tool_input: toolUse.input,
      tool_use_id: toolUse.id,
    };
  }

  /**
   * Translate PreToolUse output from hook format to SDK format
   */
  static translatePreToolUseOutput(output: PreToolUseOutput): {
    decision: 'allow' | 'deny' | 'ask';
    reason?: string;
    updatedInput?: Record<string, unknown>;
  } {
    // Extract decision from hook-specific output or top-level
    let decision: 'allow' | 'deny' | 'ask' = 'allow';
    let reason: string | undefined;
    let updatedInput: Record<string, unknown> | undefined;

    if (output.hookSpecificOutput?.permissionDecision) {
      decision = output.hookSpecificOutput.permissionDecision;
      reason = output.hookSpecificOutput.permissionDecisionReason;
      updatedInput = output.hookSpecificOutput.updatedInput;
    } else if (output.decision) {
      // Map block/deny to deny, allow/approve to allow
      decision =
        output.decision === 'block' || output.decision === 'deny'
          ? 'deny'
          : output.decision === 'ask'
            ? 'ask'
            : 'allow';
      reason = output.reason;
    }

    return { decision, reason, updatedInput };
  }

  /**
   * Translate PostToolUse event from SDK format to hook input
   */
  static translatePostToolUse(
    baseInput: HookInput,
    toolUse: SDKToolUse,
    toolResponse: SDKToolResponse,
  ): PostToolUseInput {
    return {
      ...baseInput,
      tool_name: toolUse.name,
      tool_input: toolUse.input,
      tool_response: toolResponse.output,
      tool_use_id: toolUse.id,
    };
  }

  /**
   * Translate PostToolUse output to additional context
   */
  static translatePostToolUseOutput(output: PostToolUseOutput): {
    additionalContext?: string;
  } {
    return {
      additionalContext: output.hookSpecificOutput?.additionalContext,
    };
  }

  /**
   * Translate PermissionRequest event from SDK format to hook input
   */
  static translatePermissionRequest(
    baseInput: HookInput,
    toolUse: SDKToolUse,
  ): PermissionRequestInput {
    return {
      ...baseInput,
      tool_name: toolUse.name,
      tool_input: toolUse.input,
      tool_use_id: toolUse.id,
    };
  }

  /**
   * Translate PermissionRequest output from hook format to SDK format
   */
  static translatePermissionRequestOutput(output: PermissionRequestOutput): {
    behavior: 'allow' | 'deny';
    updatedInput?: Record<string, unknown>;
    message?: string;
    interrupt?: boolean;
  } {
    const behavior =
      output.hookSpecificOutput?.decision?.behavior ??
      (output.decision === 'block' || output.decision === 'deny'
        ? 'deny'
        : 'allow');

    return {
      behavior,
      updatedInput: output.hookSpecificOutput?.decision?.updatedInput,
      message: output.hookSpecificOutput?.decision?.message ?? output.reason,
      interrupt: output.hookSpecificOutput?.decision?.interrupt,
    };
  }

  /**
   * Translate UserPromptSubmit event from SDK format to hook input
   */
  static translateUserPromptSubmit(
    baseInput: HookInput,
    userPrompt: SDKUserPrompt,
  ): UserPromptSubmitInput {
    return {
      ...baseInput,
      prompt: userPrompt.prompt,
    };
  }

  /**
   * Translate UserPromptSubmit output to additional context
   */
  static translateUserPromptSubmitOutput(output: UserPromptSubmitOutput): {
    additionalContext?: string;
  } {
    return {
      additionalContext: output.hookSpecificOutput?.additionalContext,
    };
  }

  /**
   * Translate Stop event to hook input
   */
  static translateStop(
    baseInput: HookInput,
    stopHookActive: boolean,
  ): StopInput {
    return {
      ...baseInput,
      stop_hook_active: stopHookActive,
    };
  }

  /**
   * Translate Stop output to decision
   */
  static translateStopOutput(output: StopOutput): {
    shouldStop: boolean;
    reason?: string;
  } {
    // decision: 'block' means continue execution (block the stop)
    const shouldStop = output.decision !== 'block' && output.continue !== false;
    return {
      shouldStop,
      reason: output.reason,
    };
  }

  /**
   * Translate SubagentStop event to hook input
   */
  static translateSubagentStop(
    baseInput: HookInput,
    stopHookActive: boolean,
  ): SubagentStopInput {
    return {
      ...baseInput,
      stop_hook_active: stopHookActive,
    };
  }

  /**
   * Translate SubagentStop output to decision
   */
  static translateSubagentStopOutput(output: SubagentStopOutput): {
    shouldStop: boolean;
    reason?: string;
  } {
    const shouldStop = output.decision !== 'block' && output.continue !== false;
    return {
      shouldStop,
      reason: output.reason,
    };
  }

  /**
   * Translate Notification event to hook input
   */
  static translateNotification(
    baseInput: HookInput,
    notificationType: NotificationType,
    message: string,
  ): NotificationInput {
    return {
      ...baseInput,
      notification_type: notificationType,
      message,
    };
  }

  /**
   * Translate Notification output to suppress flag
   */
  static translateNotificationOutput(output: NotificationOutput): {
    suppress: boolean;
  } {
    return {
      suppress: output.suppressOutput ?? false,
    };
  }

  /**
   * Translate SessionStart event to hook input
   */
  static translateSessionStart(
    baseInput: HookInput,
    source: SessionStartSource,
  ): SessionStartInput {
    return {
      ...baseInput,
      source,
    };
  }

  /**
   * Translate SessionStart output to additional context
   */
  static translateSessionStartOutput(output: SessionStartOutput): {
    additionalContext?: string;
  } {
    return {
      additionalContext: output.hookSpecificOutput?.additionalContext,
    };
  }

  /**
   * Translate SessionEnd event to hook input
   */
  static translateSessionEnd(
    baseInput: HookInput,
    reason: SessionEndReason,
  ): SessionEndInput {
    return {
      ...baseInput,
      reason,
    };
  }

  /**
   * Translate SessionEnd output (SessionEnd cannot block, only logs)
   */
  static translateSessionEndOutput(
    _output: SessionEndOutput,
  ): Record<string, never> {
    return {};
  }

  /**
   * Translate PreCompact event to hook input
   */
  static translatePreCompact(
    baseInput: HookInput,
    trigger: PreCompactTrigger,
    customInstructions: string,
  ): PreCompactInput {
    return {
      ...baseInput,
      trigger,
      custom_instructions: customInstructions,
    };
  }

  /**
   * Translate PreCompact output to suppress flag
   */
  static translatePreCompactOutput(output: PreCompactOutput): {
    suppress: boolean;
  } {
    return {
      suppress: output.suppressOutput ?? false,
    };
  }
}

/**
 * Create a hook translator instance
 */
export function createHookTranslator(): typeof HookTranslator {
  return HookTranslator;
}
