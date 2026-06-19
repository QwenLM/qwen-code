/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import type {
  HookExecutionRequest,
  HookExecutionResponse,
} from '../confirmation-bus/types.js';
import {
  createHookOutput,
  type PreToolUseHookOutput,
  type PostToolUseHookOutput,
  type PostToolUseFailureHookOutput,
  type NotificationType,
  type PermissionRequestHookOutput,
  type PermissionSuggestion,
  type PostToolBatchToolCall,
} from '../hooks/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { Part, PartListUnion } from '@google/genai';

const debugLogger = createDebugLogger('TOOL_HOOKS');
const POST_TOOL_BATCH_HOOK_TIMEOUT_MS = 15_000;

/**
 * Generate a unique tool_use_id for tracking tool executions
 */
export function generateToolUseId(): string {
  return `toolu_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Result of PreToolUse hook execution
 */
export interface PreToolUseHookResult {
  /** Whether the tool execution should proceed */
  shouldProceed: boolean;
  /** If blocked, the reason for blocking */
  blockReason?: string;
  /** If blocked, the error type */
  blockType?: 'denied' | 'ask' | 'stop';
  /** Additional context to add */
  additionalContext?: string;
  /**
   * Set when the hook helper caught and absorbed a transport / dispatch
   * error. The tool execution still proceeds (existing non-blocking
   * contract), but observers (telemetry spans, debug logs) can detect
   * that the hook itself failed instead of treating the safe-default
   * response as a successful "allow" decision (#4321 review).
   */
  hookError?: string;
}

/**
 * Result of PostToolUse hook execution
 */
export interface PostToolUseHookResult {
  /** Whether execution should stop */
  shouldStop: boolean;
  /** Stop reason if applicable */
  stopReason?: string;
  /** Additional context to append to tool response */
  additionalContext?: string;
  /** See PreToolUseHookResult.hookError. */
  hookError?: string;
}

/**
 * Result of PostToolUseFailure hook execution
 */
export interface PostToolUseFailureHookResult {
  /** Additional context about the failure */
  additionalContext?: string;
  /** See PreToolUseHookResult.hookError. */
  hookError?: string;
}

/**
 * Result of PostToolBatch hook execution
 */
export interface PostToolBatchHookResult {
  /** Whether execution should stop before the next model request */
  shouldStop: boolean;
  /** Stop reason if applicable */
  stopReason?: string;
  /** Additional context to append once for the whole batch */
  additionalContext?: string;
  /** See PreToolUseHookResult.hookError. */
  hookError?: string;
}

/**
 * Fire PreToolUse hook via MessageBus and process the result
 *
 * @param messageBus - The message bus instance
 * @param toolName - Name of the tool being executed
 * @param toolInput - Input parameters for the tool
 * @param toolUseId - Unique identifier for this tool use (internal format, e.g., toolu_xxx)
 * @param permissionMode - Current permission mode
 * @param tool_call_id - Original API call ID from the LLM provider (e.g., call_xxx for OpenAI/Qwen)
 * @returns PreToolUseHookResult indicating whether to proceed and any modifications
 */
export async function firePreToolUseHook(
  messageBus: MessageBus | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  permissionMode: string,
  signal?: AbortSignal,
  tool_call_id?: string,
): Promise<PreToolUseHookResult> {
  if (!messageBus) {
    return { shouldProceed: true };
  }

  try {
    const response = await messageBus.request<
      HookExecutionRequest,
      HookExecutionResponse
    >(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        eventName: 'PreToolUse',
        input: {
          permission_mode: permissionMode,
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: toolUseId,
          ...(tool_call_id && { tool_call_id }),
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    if (!response.success || !response.output) {
      // Hook runner reported failure (URL validation, fn exception,
      // prompt-runner crash, ...). The `response.error` from the runner
      // is the canonical cause — forward it so telemetry and operators
      // see the actual failure instead of a fake "allow" success
      // (#4321 review silent-failure-hunter HIGH).
      //
      // If runner returned `{ success: false }` (or missing output) with no
      // `error.message`, synthesize a sentinel so the contract violation is
      // still visible on the span instead of silently degrading to an allow
      // with empty telemetry (#4321 review-7 silent-failure-hunter HIGH-1).
      // `||` (revert from `??`): downstream consumers in
      // coreToolScheduler.ts gate on `r.hookError ? ...`, so an
      // empty-string message would be silently dropped — the previous
      // `??` change defeated its own intent. Empty-string error
      // messages carry no operator value; the sentinel is more
      // actionable. (#4321 review-9 wenshao Suggestion refines
      // review-8.)
      const message =
        response.error?.message ||
        `hook runner returned ${response.success ? 'no output' : 'success: false'} without error detail`;
      return { shouldProceed: true, hookError: message };
    }

    const preToolOutput = createHookOutput(
      'PreToolUse',
      response.output,
    ) as PreToolUseHookOutput;

    // Check if execution was denied
    if (preToolOutput.isDenied()) {
      return {
        shouldProceed: false,
        blockReason:
          preToolOutput.getPermissionDecisionReason() ||
          preToolOutput.getEffectiveReason(),
        blockType: 'denied',
      };
    }

    // Check if user confirmation is required
    if (preToolOutput.isAsk()) {
      return {
        shouldProceed: false,
        blockReason:
          preToolOutput.getPermissionDecisionReason() ||
          'User confirmation required',
        blockType: 'ask',
      };
    }

    // Check if execution should stop
    if (preToolOutput.shouldStopExecution()) {
      return {
        shouldProceed: false,
        blockReason: preToolOutput.getEffectiveReason(),
        blockType: 'stop',
      };
    }

    // Get additional context
    const additionalContext = preToolOutput.getAdditionalContext();

    return {
      shouldProceed: true,
      additionalContext,
    };
  } catch (error) {
    // Hook errors should not block tool execution
    const message = error instanceof Error ? error.message : String(error);
    debugLogger.warn(`PreToolUse hook error for ${toolName}: ${message}`);
    return { shouldProceed: true, hookError: message };
  }
}

/**
 * Fire PostToolUse hook via MessageBus and process the result
 *
 * @param messageBus - The message bus instance
 * @param toolName - Name of the tool that was executed
 * @param toolInput - Input parameters that were used
 * @param toolResponse - Response from the tool execution
 * @param toolUseId - Unique identifier for this tool use (internal format, e.g., toolu_xxx)
 * @param permissionMode - Current permission mode
 * @param tool_call_id - Original API call ID from the LLM provider (e.g., call_xxx for OpenAI/Qwen)
 * @returns PostToolUseHookResult with any additional context
 */
export async function firePostToolUseHook(
  messageBus: MessageBus | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown>,
  toolUseId: string,
  permissionMode: string,
  signal?: AbortSignal,
  tool_call_id?: string,
): Promise<PostToolUseHookResult> {
  if (!messageBus) {
    return { shouldStop: false };
  }

  try {
    const response = await messageBus.request<
      HookExecutionRequest,
      HookExecutionResponse
    >(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        eventName: 'PostToolUse',
        input: {
          permission_mode: permissionMode,
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          tool_use_id: toolUseId,
          ...(tool_call_id && { tool_call_id }),
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    if (!response.success || !response.output) {
      // See firePreToolUseHook for the rationale.
      // `||` (revert from `??`): downstream consumers in
      // coreToolScheduler.ts gate on `r.hookError ? ...`, so an
      // empty-string message would be silently dropped — the previous
      // `??` change defeated its own intent. Empty-string error
      // messages carry no operator value; the sentinel is more
      // actionable. (#4321 review-9 wenshao Suggestion refines
      // review-8.)
      const message =
        response.error?.message ||
        `hook runner returned ${response.success ? 'no output' : 'success: false'} without error detail`;
      return { shouldStop: false, hookError: message };
    }

    const postToolOutput = createHookOutput(
      'PostToolUse',
      response.output,
    ) as PostToolUseHookOutput;

    // Check if execution should stop
    if (postToolOutput.shouldStopExecution()) {
      return {
        shouldStop: true,
        stopReason: postToolOutput.getEffectiveReason(),
      };
    }

    // Get additional context
    const additionalContext = postToolOutput.getAdditionalContext();

    return {
      shouldStop: false,
      additionalContext,
    };
  } catch (error) {
    // Hook errors should not affect tool result
    const message = error instanceof Error ? error.message : String(error);
    debugLogger.warn(`PostToolUse hook error for ${toolName}: ${message}`);
    return { shouldStop: false, hookError: message };
  }
}

/**
 * Fire PostToolUseFailure hook via MessageBus and process the result
 *
 * @param messageBus - The message bus instance
 * @param toolUseId - Unique identifier for this tool use (internal format, e.g., toolu_xxx)
 * @param toolName - Name of the tool that failed
 * @param toolInput - Input parameters that were used
 * @param errorMessage - Error message describing the failure
 * @param errorType - Optional error type classification
 * @param isInterrupt - Whether the failure was caused by user interruption
 * @param tool_call_id - Original API call ID from the LLM provider (e.g., call_xxx for OpenAI/Qwen)
 * @returns PostToolUseFailureHookResult with any additional context
 */
export async function firePostToolUseFailureHook(
  messageBus: MessageBus | undefined,
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  errorMessage: string,
  isInterrupt?: boolean,
  permissionMode?: string,
  signal?: AbortSignal,
  tool_call_id?: string,
): Promise<PostToolUseFailureHookResult> {
  if (!messageBus) {
    return {};
  }

  try {
    const response = await messageBus.request<
      HookExecutionRequest,
      HookExecutionResponse
    >(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        eventName: 'PostToolUseFailure',
        input: {
          permission_mode: permissionMode,
          tool_use_id: toolUseId,
          ...(tool_call_id && { tool_call_id }),
          tool_name: toolName,
          tool_input: toolInput,
          error: errorMessage,
          is_interrupt: isInterrupt,
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    if (!response.success || !response.output) {
      // See firePreToolUseHook for the rationale.
      // `||` (revert from `??`): downstream consumers in
      // coreToolScheduler.ts gate on `r.hookError ? ...`, so an
      // empty-string message would be silently dropped — the previous
      // `??` change defeated its own intent. Empty-string error
      // messages carry no operator value; the sentinel is more
      // actionable. (#4321 review-9 wenshao Suggestion refines
      // review-8.)
      const message =
        response.error?.message ||
        `hook runner returned ${response.success ? 'no output' : 'success: false'} without error detail`;
      return { hookError: message };
    }

    const failureOutput = createHookOutput(
      'PostToolUseFailure',
      response.output,
    ) as PostToolUseFailureHookOutput;
    const additionalContext = failureOutput.getAdditionalContext();

    return {
      additionalContext,
    };
  } catch (error) {
    // Hook errors should not affect error handling
    const message = error instanceof Error ? error.message : String(error);
    debugLogger.warn(
      `PostToolUseFailure hook error for ${toolName}: ${message}`,
    );
    return { hookError: message };
  }
}

/**
 * Fire PostToolBatch hook via MessageBus and process the result
 *
 * @param messageBus - The message bus instance
 * @param toolCalls - Resolved tool calls in the batch
 * @returns PostToolBatchHookResult with stop/additional-context decisions
 */
export async function firePostToolBatchHook(
  messageBus: MessageBus | undefined,
  toolCalls: PostToolBatchToolCall[],
  permissionMode = 'default',
  signal?: AbortSignal,
): Promise<PostToolBatchHookResult> {
  if (!messageBus) {
    return { shouldStop: false };
  }

  try {
    const response = await messageBus.request<
      HookExecutionRequest,
      HookExecutionResponse
    >(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        eventName: 'PostToolBatch',
        input: {
          permission_mode: permissionMode,
          tool_calls: toolCalls,
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
      POST_TOOL_BATCH_HOOK_TIMEOUT_MS,
      signal,
    );

    if (!response.success || !response.output) {
      const message =
        response.error?.message ||
        `hook runner returned ${response.success ? 'no output' : 'success: false'} without error detail`;
      debugLogger.warn(`PostToolBatch hook returned failure: ${message}`);
      return { shouldStop: false, hookError: message };
    }

    const batchOutput = createHookOutput('PostToolBatch', response.output);
    const shouldStop = batchOutput.shouldStopExecution();

    return {
      shouldStop,
      stopReason: shouldStop ? batchOutput.getEffectiveReason() : undefined,
      additionalContext: batchOutput.getAdditionalContext(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLogger.warn(`PostToolBatch hook error: ${message}`);
    return { shouldStop: false, hookError: message };
  }
}

/**
 * Result of Notification hook execution
 */
export interface NotificationHookResult {
  /** Additional context from the hook */
  additionalContext?: string;
  /** Terminal escape sequence requested by the hook */
  terminalSequence?: string;
}

/**
 * Fire Notification hook via MessageBus
 * Called when Qwen Code sends a notification
 */
export async function fireNotificationHook(
  messageBus: MessageBus | undefined,
  message: string,
  notificationType: NotificationType,
  title?: string,
  signal?: AbortSignal,
): Promise<NotificationHookResult> {
  if (!messageBus) {
    return {};
  }

  try {
    const response = await messageBus.request<
      HookExecutionRequest,
      HookExecutionResponse
    >(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        eventName: 'Notification',
        input: {
          message,
          notification_type: notificationType,
          title,
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    if (!response.success || !response.output) {
      return {};
    }

    const notificationOutput = createHookOutput(
      'Notification',
      response.output,
    );
    const result: NotificationHookResult = {};
    const additionalContext = notificationOutput.getAdditionalContext();
    if (additionalContext !== undefined) {
      result.additionalContext = additionalContext;
    }
    if (notificationOutput.terminalSequence !== undefined) {
      result.terminalSequence = notificationOutput.terminalSequence;
    }

    return result;
  } catch (error) {
    // Notification hook errors should not affect the notification flow
    debugLogger.warn(
      `Notification hook error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

/**
 * Result of PermissionRequest hook execution
 */
export interface PermissionRequestHookResult {
  /** Whether the hook made a permission decision */
  hasDecision: boolean;
  /** If true, the tool execution should proceed */
  shouldAllow?: boolean;
  /** Updated tool input to use if allowed */
  updatedInput?: Record<string, unknown>;
  /** Deny message to pass back to the AI if denied */
  denyMessage?: string;
  /** Whether to interrupt the AI after denial */
  shouldInterrupt?: boolean;
}

/**
 * Fire PermissionRequest hook via MessageBus
 * Called when a permission dialog is about to be shown to the user.
 * Returns a decision that can short-circuit the normal permission flow.
 */
export async function firePermissionRequestHook(
  messageBus: MessageBus | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  permissionMode: string,
  permissionSuggestions?: PermissionSuggestion[],
  signal?: AbortSignal,
): Promise<PermissionRequestHookResult> {
  if (!messageBus) {
    return { hasDecision: false };
  }

  try {
    const response = await messageBus.request<
      HookExecutionRequest,
      HookExecutionResponse
    >(
      {
        type: MessageBusType.HOOK_EXECUTION_REQUEST,
        eventName: 'PermissionRequest',
        input: {
          tool_name: toolName,
          tool_input: toolInput,
          permission_mode: permissionMode,
          permission_suggestions: permissionSuggestions,
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    if (!response.success || !response.output) {
      return { hasDecision: false };
    }

    const permissionOutput = createHookOutput(
      'PermissionRequest',
      response.output,
    ) as PermissionRequestHookOutput;

    const decision = permissionOutput.getPermissionDecision();
    if (!decision) {
      return { hasDecision: false };
    }

    if (decision.behavior === 'allow') {
      return {
        hasDecision: true,
        shouldAllow: true,
        updatedInput: decision.updatedInput,
      };
    }

    return {
      hasDecision: true,
      shouldAllow: false,
      denyMessage: decision.message,
      shouldInterrupt: decision.interrupt,
    };
  } catch (error) {
    debugLogger.warn(
      `PermissionRequest hook error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { hasDecision: false };
  }
}

/**
 * Append additional context to tool response content
 *
 * @param content - Original content (string or PartListUnion)
 * @param additionalContext - Context to append
 * @returns Modified content with context appended
 */
export function appendAdditionalContext(
  content: string | PartListUnion,
  additionalContext: string | undefined,
): string | PartListUnion {
  if (!additionalContext) {
    return content;
  }

  if (typeof content === 'string') {
    return content + '\n\n' + additionalContext;
  }

  // For PartListUnion content, append as an additional text part
  if (Array.isArray(content)) {
    return [...content, { text: additionalContext } as Part];
  }

  // Single non-array Part (e.g. ReadFile returning `{ inlineData: {...} }`
  // for an image or PDF). Wrap in an array so the additional context still
  // reaches the model — the previous "return as-is" silently dropped
  // hook-injected reminders for any tool whose llmContent is a single Part.
  return [content, { text: additionalContext } as Part];
}
