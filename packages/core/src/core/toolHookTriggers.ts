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
  type PostTurnHookOutput,
} from '../hooks/types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { Part, PartListUnion } from '@google/genai';

const debugLogger = createDebugLogger('TOOL_HOOKS');

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
}

/**
 * Result of PostToolUseFailure hook execution
 */
export interface PostToolUseFailureHookResult {
  /** Additional context about the failure */
  additionalContext?: string;
}

/**
 * Fire PreToolUse hook via MessageBus and process the result
 *
 * @param messageBus - The message bus instance
 * @param toolName - Name of the tool being executed
 * @param toolInput - Input parameters for the tool
 * @param toolUseId - Unique identifier for this tool use
 * @param permissionMode - Current permission mode
 * @returns PreToolUseHookResult indicating whether to proceed and any modifications
 */
export async function firePreToolUseHook(
  messageBus: MessageBus | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  permissionMode: string,
  signal?: AbortSignal,
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
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    if (!response.success || !response.output) {
      return { shouldProceed: true };
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
    debugLogger.warn(
      `PreToolUse hook error for ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { shouldProceed: true };
  }
}

/**
 * Fire PostToolUse hook via MessageBus and process the result
 *
 * @param messageBus - The message bus instance
 * @param toolName - Name of the tool that was executed
 * @param toolInput - Input parameters that were used
 * @param toolResponse - Response from the tool execution
 * @param toolUseId - Unique identifier for this tool use
 * @param permissionMode - Current permission mode
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
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    if (!response.success || !response.output) {
      return { shouldStop: false };
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
    debugLogger.warn(
      `PostToolUse hook error for ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { shouldStop: false };
  }
}

/**
 * Fire PostToolUseFailure hook via MessageBus and process the result
 *
 * @param messageBus - The message bus instance
 * @param toolUseId - Unique identifier for this tool use
 * @param toolName - Name of the tool that failed
 * @param toolInput - Input parameters that were used
 * @param errorMessage - Error message describing the failure
 * @param errorType - Optional error type classification
 * @param isInterrupt - Whether the failure was caused by user interruption
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
      return {};
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
    debugLogger.warn(
      `PostToolUseFailure hook error for ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

/**
 * Result of Notification hook execution
 */
export interface NotificationHookResult {
  /** Additional context from the hook */
  additionalContext?: string;
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
    const additionalContext = notificationOutput.getAdditionalContext();

    return {
      additionalContext,
    };
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

  // For non-array content that's still PartListUnion, return as-is
  return content;
}

/**
 * Result of PostTurn hook execution
 */
export interface PostTurnHookResult {
  /** Message text to inject into ACP stream as agent_message_chunk. */
  acpMessage?: string;
  /** Optional metadata for the injected ACP message. Defined by hook scripts, passed through as-is. */
  acpMeta?: Record<string, unknown>;
}

/**
 * Fire a PostTurn hook event.
 * Fire-and-forget: errors are silently ignored, never blocks agent execution.
 *
 * @returns PostTurnHookResult with optional acpMessage to inject
 */
export async function firePostTurnHook(
  messageBus: MessageBus | undefined,
  turnIndex: number,
  thoughts: string[],
  messages: string[],
  toolCalls: Array<{ name: string; args?: Record<string, unknown> }>,
  signal?: AbortSignal,
): Promise<PostTurnHookResult> {
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
        eventName: 'PostTurn',
        input: {
          turn_index: turnIndex,
          thoughts,
          messages,
          tool_calls: toolCalls,
        },
        signal,
      },
      MessageBusType.HOOK_EXECUTION_RESPONSE,
    );

    if (!response.success || !response.output) {
      return {};
    }

    const postTurnOutput = createHookOutput(
      'PostTurn',
      response.output,
    ) as PostTurnHookOutput;

    return {
      acpMessage: postTurnOutput.getAcpMessage(),
      acpMeta: postTurnOutput.getAcpMeta(),
    };
  } catch (error) {
    // PostTurn hook errors must not affect agent execution
    debugLogger.warn(
      `PostTurn hook error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}
