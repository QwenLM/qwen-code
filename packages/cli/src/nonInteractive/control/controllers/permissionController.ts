/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission Controller
 *
 * Handles permission-related control requests:
 * - can_use_tool: Check if tool usage is allowed
 * - set_permission_mode: Change permission mode at runtime
 *
 * Abstracts all permission logic from the session manager to keep it clean.
 */

import type {
  WaitingToolCall,
  ToolExecuteConfirmationDetails,
  ToolMcpConfirmationDetails,
  ApprovalMode,
} from '@qwen-code/qwen-code-core';
import {
  InputFormat,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import type {
  CLIControlPermissionRequest,
  CLIControlSetPermissionModeRequest,
  ControlRequestPayload,
  PermissionMode,
  PermissionSuggestion,
} from '../../types.js';
import { BaseController } from './baseController.js';

// Import ToolCallConfirmationDetails types for type alignment
type ToolConfirmationType = 'edit' | 'exec' | 'mcp' | 'info' | 'plan';

/**
 * Configuration for loop detection
 */
interface LoopDetectionConfig {
  /** Maximum consecutive denials before triggering protection */
  maxConsecutiveDenials: number;
  /** Time window in ms to reset the counter (5 minutes) */
  resetWindowMs: number;
  /** Tools to exclude from loop detection (always allowed to retry) */
  excludedTools: Set<string>;
}

const DEFAULT_LOOP_DETECTION_CONFIG: LoopDetectionConfig = {
  maxConsecutiveDenials: 5,
  resetWindowMs: 5 * 60 * 1000, // 5 minutes
  excludedTools: new Set(['exit_plan_mode']),
};

export class PermissionController extends BaseController {
  private pendingOutgoingRequests = new Set<string>();

  // Loop detection state
  private consecutiveDenials = 0;
  private lastDenialTime = 0;
  private loopDetectionConfig: LoopDetectionConfig;

  constructor(
    context: import('../ControlContext.js').IControlContext,
    registry: import('./baseController.js').IPendingRequestRegistry,
    controllerName: string = 'PermissionController',
  ) {
    super(context, registry, controllerName);
    this.loopDetectionConfig = { ...DEFAULT_LOOP_DETECTION_CONFIG };
  }

  /**
   * Check if we're in a potential infinite loop of tool denials
   * Returns a message if loop detected, null otherwise
   */
  private checkLoopDetection(toolName: string): string | null {
    const now = Date.now();

    // Reset counter if outside the time window
    if (now - this.lastDenialTime > this.loopDetectionConfig.resetWindowMs) {
      this.consecutiveDenials = 0;
    }

    // Skip loop detection for excluded tools
    if (this.loopDetectionConfig.excludedTools.has(toolName)) {
      return null;
    }

    // Check if we've exceeded the threshold
    if (
      this.consecutiveDenials >= this.loopDetectionConfig.maxConsecutiveDenials
    ) {
      this.consecutiveDenials = 0; // Reset after triggering
      return this.buildLoopDetectedMessage();
    }

    return null;
  }

  /**
   * Record a tool denial for loop detection
   */
  private recordDenial(): void {
    this.consecutiveDenials++;
    this.lastDenialTime = Date.now();
  }

  /**
   * Reset the denial counter (e.g., when a tool is approved)
   */
  private resetDenialCounter(): void {
    this.consecutiveDenials = 0;
  }

  /**
   * Build a message to break the AI out of a thinking loop
   */
  private buildLoopDetectedMessage(): string {
    return `[SYSTEM: Loop Detection Triggered]

The system has detected that you are in a potential infinite loop of tool permission denials. This usually happens when:

1. The user is not responding to permission prompts
2. There's a communication issue between the frontend and backend
3. The permission system is not functioning correctly

**IMPORTANT: Stop retrying the same action.**

Instead, please:
1. Explain to the user what you were trying to do
2. Ask the user if they want to:
   - Try a different approach
   - Change the permission mode (e.g., to 'yolo' mode for auto-approval)
   - Check if there's a technical issue with the permission dialog

Do not attempt to call the same tool again without user confirmation.`;
  }

  /**
   * Handle permission control requests
   */
  protected async handleRequestPayload(
    payload: ControlRequestPayload,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw new Error('Request aborted');
    }

    switch (payload.subtype) {
      case 'can_use_tool':
        return this.handleCanUseTool(
          payload as CLIControlPermissionRequest,
          signal,
        );

      case 'set_permission_mode':
        return this.handleSetPermissionMode(
          payload as CLIControlSetPermissionModeRequest,
          signal,
        );

      default:
        throw new Error(`Unsupported request subtype in PermissionController`);
    }
  }

  /**
   * Handle can_use_tool request
   *
   * Comprehensive permission evaluation based on:
   * - Permission mode (approval level)
   * - Tool registry validation
   * - Error handling with safe defaults
   */
  private async handleCanUseTool(
    payload: CLIControlPermissionRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw new Error('Request aborted');
    }

    const toolName = payload.tool_name;
    if (
      !toolName ||
      typeof toolName !== 'string' ||
      toolName.trim().length === 0
    ) {
      return {
        subtype: 'can_use_tool',
        behavior: 'deny',
        message: 'Missing or invalid tool_name in can_use_tool request',
      };
    }

    let behavior: 'allow' | 'deny' = 'allow';
    let message: string | undefined;

    try {
      // Check permission mode first
      const permissionResult = this.checkPermissionMode();
      if (!permissionResult.allowed) {
        behavior = 'deny';
        message = permissionResult.message;
      }

      // Check tool registry if permission mode allows
      if (behavior === 'allow') {
        const registryResult = this.checkToolRegistry(toolName);
        if (!registryResult.allowed) {
          behavior = 'deny';
          message = registryResult.message;
        }
      }
    } catch (error) {
      behavior = 'deny';
      message =
        error instanceof Error
          ? `Failed to evaluate tool permission: ${error.message}`
          : 'Failed to evaluate tool permission';
    }

    const response: Record<string, unknown> = {
      subtype: 'can_use_tool',
      behavior,
    };

    if (message) {
      response['message'] = message;
    }

    return response;
  }

  /**
   * Check permission mode for tool execution
   */
  private checkPermissionMode(): { allowed: boolean; message?: string } {
    const mode = this.context.permissionMode;

    // Map permission modes to approval logic (aligned with VALID_APPROVAL_MODE_VALUES)
    switch (mode) {
      case 'yolo': // Allow all tools
      case 'auto-edit': // Auto-approve edit operations
      case 'plan': // Auto-approve planning operations
        return { allowed: true };

      case 'default': // TODO: allow all tools for test
      default:
        return {
          allowed: false,
          message:
            'Tool execution requires manual approval. Update permission mode or approve via host.',
        };
    }
  }

  /**
   * Check if tool exists in registry
   */
  private checkToolRegistry(toolName: string): {
    allowed: boolean;
    message?: string;
  } {
    try {
      // Access tool registry through config
      const config = this.context.config;
      const registryProvider = config as unknown as {
        getToolRegistry?: () => {
          getTool?: (name: string) => unknown;
        };
      };

      if (typeof registryProvider.getToolRegistry === 'function') {
        const registry = registryProvider.getToolRegistry();
        if (
          registry &&
          typeof registry.getTool === 'function' &&
          !registry.getTool(toolName)
        ) {
          return {
            allowed: false,
            message: `Tool "${toolName}" is not registered.`,
          };
        }
      }

      return { allowed: true };
    } catch (error) {
      return {
        allowed: false,
        message: `Failed to check tool registry: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Handle set_permission_mode request
   *
   * Updates the permission mode in the context
   */
  private async handleSetPermissionMode(
    payload: CLIControlSetPermissionModeRequest,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) {
      throw new Error('Request aborted');
    }

    const mode = payload.mode;
    const validModes: PermissionMode[] = [
      'default',
      'plan',
      'auto-edit',
      'yolo',
    ];

    if (!validModes.includes(mode)) {
      throw new Error(
        `Invalid permission mode: ${mode}. Valid values are: ${validModes.join(', ')}`,
      );
    }

    this.context.permissionMode = mode;
    this.context.config.setApprovalMode(mode as ApprovalMode);

    this.debugLogger.info(
      `[PermissionController] Permission mode updated to: ${mode}`,
    );

    return { status: 'updated', mode };
  }

  /**
   * Build permission suggestions for tool confirmation UI
   *
   * This method creates UI suggestions based on tool confirmation details,
   * helping the host application present appropriate permission options.
   */
  buildPermissionSuggestions(
    confirmationDetails: unknown,
  ): PermissionSuggestion[] | null {
    if (
      !confirmationDetails ||
      typeof confirmationDetails !== 'object' ||
      !('type' in confirmationDetails)
    ) {
      return null;
    }

    const details = confirmationDetails as Record<string, unknown>;
    const type = String(details['type'] ?? '');
    const title =
      typeof details['title'] === 'string' ? details['title'] : undefined;

    // Ensure type matches ToolCallConfirmationDetails union
    const confirmationType = type as ToolConfirmationType;

    switch (confirmationType) {
      case 'exec': // ToolExecuteConfirmationDetails
        return [
          {
            type: 'allow',
            label: 'Allow Command',
            description: `Execute: ${details['command']}`,
          },
          {
            type: 'deny',
            label: 'Deny',
            description: 'Block this command execution',
          },
        ];

      case 'edit': // ToolEditConfirmationDetails
        return [
          {
            type: 'allow',
            label: 'Allow Edit',
            description: `Edit file: ${details['fileName']}`,
          },
          {
            type: 'deny',
            label: 'Deny',
            description: 'Block this file edit',
          },
          {
            type: 'modify',
            label: 'Review Changes',
            description: 'Review the proposed changes before applying',
          },
        ];

      case 'plan': // ToolPlanConfirmationDetails
        return [
          {
            type: 'allow',
            label: 'Approve Plan',
            description: title || 'Execute the proposed plan',
          },
          {
            type: 'deny',
            label: 'Reject Plan',
            description: 'Do not execute this plan',
          },
        ];

      case 'mcp': // ToolMcpConfirmationDetails
        return [
          {
            type: 'allow',
            label: 'Allow MCP Call',
            description: `${details['serverName']}: ${details['toolName']}`,
          },
          {
            type: 'deny',
            label: 'Deny',
            description: 'Block this MCP server call',
          },
        ];

      case 'info': // ToolInfoConfirmationDetails
        return [
          {
            type: 'allow',
            label: 'Allow Info Request',
            description: title || 'Allow information request',
          },
          {
            type: 'deny',
            label: 'Deny',
            description: 'Block this information request',
          },
        ];

      default:
        // Fallback for unknown types
        return [
          {
            type: 'allow',
            label: 'Allow',
            description: title || `Allow ${type} operation`,
          },
          {
            type: 'deny',
            label: 'Deny',
            description: `Block ${type} operation`,
          },
        ];
    }
  }

  /**
   * Get callback for monitoring tool calls and handling outgoing permission requests
   * This is passed to executeToolCall to hook into CoreToolScheduler updates
   */
  getToolCallUpdateCallback(): (toolCalls: unknown[]) => void {
    return (toolCalls: unknown[]) => {
      for (const call of toolCalls) {
        if (
          call &&
          typeof call === 'object' &&
          (call as { status?: string }).status === 'awaiting_approval'
        ) {
          const awaiting = call as WaitingToolCall;
          if (
            typeof awaiting.confirmationDetails?.onConfirm === 'function' &&
            !this.pendingOutgoingRequests.has(awaiting.request.callId)
          ) {
            this.pendingOutgoingRequests.add(awaiting.request.callId);
            void this.handleOutgoingPermissionRequest(awaiting);
          }
        }
      }
    };
  }

  /**
   * Handle outgoing permission request
   *
   * Behavior depends on input format:
   * - stream-json mode: Send can_use_tool to SDK and await response
   * - Other modes: Check local approval mode and decide immediately
   */
  private async handleOutgoingPermissionRequest(
    toolCall: WaitingToolCall,
  ): Promise<void> {
    try {
      // Check if already aborted
      if (this.context.abortSignal?.aborted) {
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
        );
        return;
      }

      // Check for potential infinite loop before proceeding
      const loopMessage = this.checkLoopDetection(toolCall.request.name);
      if (loopMessage) {
        this.debugLogger.warn(
          '[PermissionController] Loop detected, sending interrupt message',
        );
        // Cancel with the loop detection message to break the AI out of the loop
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
          { cancelMessage: loopMessage },
        );
        return;
      }

      const inputFormat = this.context.config.getInputFormat?.();
      const isStreamJsonMode = inputFormat === InputFormat.STREAM_JSON;

      if (!isStreamJsonMode) {
        // No SDK available - use local permission check
        const modeCheck = this.checkPermissionMode();
        const outcome = modeCheck.allowed
          ? ToolConfirmationOutcome.ProceedOnce
          : ToolConfirmationOutcome.Cancel;

        if (!modeCheck.allowed) {
          this.recordDenial();
        } else {
          this.resetDenialCounter();
        }

        await toolCall.confirmationDetails.onConfirm(outcome);
        return;
      }

      // Stream-json mode: ask SDK for permission
      const permissionSuggestions = this.buildPermissionSuggestions(
        toolCall.confirmationDetails,
      );

      // Use a very long timeout for permission requests (100 years in milliseconds)
      // This ensures the CLI waits indefinitely for user response from the SDK/WebUI
      // The actual timeout is controlled by the SDK's canUseTool timeout setting
      const PERMISSION_REQUEST_TIMEOUT = 3153600000000; // 100 years

      const response = await this.sendControlRequest(
        {
          subtype: 'can_use_tool',
          tool_name: toolCall.request.name,
          tool_use_id: toolCall.request.callId,
          input: toolCall.request.args,
          permission_suggestions: permissionSuggestions,
          blocked_path: null,
        } as CLIControlPermissionRequest,
        PERMISSION_REQUEST_TIMEOUT,
        this.context.abortSignal,
      );

      if (response.subtype !== 'success') {
        this.recordDenial();
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
        );
        return;
      }

      const payload = (response.response || {}) as Record<string, unknown>;
      const behavior = String(payload['behavior'] || '').toLowerCase();

      if (behavior === 'allow') {
        // Reset denial counter on successful approval
        this.resetDenialCounter();
        // Handle updated input if provided
        const updatedInput = payload['updatedInput'];
        if (updatedInput && typeof updatedInput === 'object') {
          toolCall.request.args = updatedInput as Record<string, unknown>;
        }
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedOnce,
        );
      } else {
        // Record denial for loop detection
        this.recordDenial();
        // Extract cancel message from response if available
        const cancelMessage =
          typeof payload['message'] === 'string'
            ? payload['message']
            : undefined;

        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
          cancelMessage ? { cancelMessage } : undefined,
        );
      }
    } catch (error) {
      this.debugLogger.error(
        '[PermissionController] Outgoing permission failed:',
        error,
      );

      // Record denial on error (timeout, network error, etc.)
      this.recordDenial();

      // Extract error message
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // On error, pass error message as cancel message
      // Only pass payload for exec and mcp types that support it
      const confirmationType = toolCall.confirmationDetails.type;
      if (['edit', 'exec', 'mcp'].includes(confirmationType)) {
        const execOrMcpDetails = toolCall.confirmationDetails as
          | ToolExecuteConfirmationDetails
          | ToolMcpConfirmationDetails;
        await execOrMcpDetails.onConfirm(ToolConfirmationOutcome.Cancel, {
          cancelMessage: `Error: ${errorMessage}`,
        });
      } else {
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
          {
            cancelMessage: `Error: ${errorMessage}`,
          },
        );
      }
    } finally {
      this.pendingOutgoingRequests.delete(toolCall.request.callId);
    }
  }
}
