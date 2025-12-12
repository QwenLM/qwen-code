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

export class PermissionController extends BaseController {
  private pendingOutgoingRequests = new Set<string>();

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

    if (this.context.debugMode) {
      console.error(
        `[PermissionController] Permission mode updated to: ${mode}`,
      );
    }

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

      const inputFormat = this.context.config.getInputFormat?.();
      const isStreamJsonMode = inputFormat === InputFormat.STREAM_JSON;

      if (!isStreamJsonMode) {
        // No SDK available - use local permission check
        const modeCheck = this.checkPermissionMode();
        const outcome = modeCheck.allowed
          ? ToolConfirmationOutcome.ProceedOnce
          : ToolConfirmationOutcome.Cancel;

        await toolCall.confirmationDetails.onConfirm(outcome);
        return;
      }

      // Stream-json mode: ask SDK for permission
      const permissionSuggestions = this.buildPermissionSuggestions(
        toolCall.confirmationDetails,
      );

      const response = await this.sendControlRequest(
        {
          subtype: 'can_use_tool',
          tool_name: toolCall.request.name,
          tool_use_id: toolCall.request.callId,
          input: toolCall.request.args,
          permission_suggestions: permissionSuggestions,
          blocked_path: null,
        } as CLIControlPermissionRequest,
        undefined, // use default timeout
        this.context.abortSignal,
      );

      if (response.subtype !== 'success') {
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
        );
        return;
      }

      const payload = (response.response || {}) as Record<string, unknown>;
      const behavior = String(payload['behavior'] || '').toLowerCase();

      if (behavior === 'allow') {
        // Handle updated input if provided
        const updatedInput = payload['updatedInput'];
        if (updatedInput && typeof updatedInput === 'object') {
          toolCall.request.args = updatedInput as Record<string, unknown>;
        }
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.ProceedOnce,
        );
      } else {
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
      if (this.context.debugMode) {
        console.error(
          '[PermissionController] Outgoing permission failed:',
          error,
        );
      }
      // On error, use default cancel message
      // Only pass payload for exec and mcp types that support it
      const confirmationType = toolCall.confirmationDetails.type;
      if (['edit', 'exec', 'mcp'].includes(confirmationType)) {
        const execOrMcpDetails = toolCall.confirmationDetails as
          | ToolExecuteConfirmationDetails
          | ToolMcpConfirmationDetails;
        await execOrMcpDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
          undefined,
        );
      } else {
        // For other types, don't pass payload (backward compatible)
        await toolCall.confirmationDetails.onConfirm(
          ToolConfirmationOutcome.Cancel,
        );
      }
    } finally {
      this.pendingOutgoingRequests.delete(toolCall.request.callId);
    }
  }
}
