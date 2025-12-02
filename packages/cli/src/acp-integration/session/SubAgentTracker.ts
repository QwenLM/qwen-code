/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SubAgentEventEmitter,
  SubAgentToolCallEvent,
  SubAgentToolResultEvent,
  SubAgentApprovalRequestEvent,
  ToolCallConfirmationDetails,
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '@qwen-code/qwen-code-core';
import {
  SubAgentEventType,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import { z } from 'zod';
import type { SessionContext } from './types.js';
import { ToolCallEmitter } from './emitters/ToolCallEmitter.js';
import type * as acp from '../acp.js';

/**
 * Permission option kind type matching ACP schema.
 */
type PermissionKind =
  | 'allow_once'
  | 'reject_once'
  | 'allow_always'
  | 'reject_always';

/**
 * Configuration for permission options displayed to users.
 */
interface PermissionOptionConfig {
  optionId: ToolConfirmationOutcome;
  name: string;
  kind: PermissionKind;
}

const basicPermissionOptions: readonly PermissionOptionConfig[] = [
  {
    optionId: ToolConfirmationOutcome.ProceedOnce,
    name: 'Allow',
    kind: 'allow_once',
  },
  {
    optionId: ToolConfirmationOutcome.Cancel,
    name: 'Reject',
    kind: 'reject_once',
  },
] as const;

/**
 * Tracks and emits events for sub-agent tool calls within TaskTool execution.
 *
 * Uses the unified ToolCallEmitter for consistency with normal flow
 * and history replay. Also handles permission requests for tools that
 * require user approval.
 */
export class SubAgentTracker {
  private readonly toolCallEmitter: ToolCallEmitter;
  private readonly toolStates = new Map<
    string,
    {
      tool?: AnyDeclarativeTool;
      invocation?: AnyToolInvocation;
      args?: Record<string, unknown>;
    }
  >();

  constructor(
    private readonly ctx: SessionContext,
    private readonly client: acp.Client,
  ) {
    this.toolCallEmitter = new ToolCallEmitter(ctx);
  }

  /**
   * Sets up event listeners for a sub-agent's tool events.
   *
   * @param eventEmitter - The SubAgentEventEmitter from TaskTool
   * @param abortSignal - Signal to abort tracking if parent is cancelled
   * @returns Array of cleanup functions to remove listeners
   */
  setup(
    eventEmitter: SubAgentEventEmitter,
    abortSignal: AbortSignal,
  ): Array<() => void> {
    const onToolCall = this.createToolCallHandler(abortSignal);
    const onToolResult = this.createToolResultHandler(abortSignal);
    const onApproval = this.createApprovalHandler(abortSignal);

    eventEmitter.on(SubAgentEventType.TOOL_CALL, onToolCall);
    eventEmitter.on(SubAgentEventType.TOOL_RESULT, onToolResult);
    eventEmitter.on(SubAgentEventType.TOOL_WAITING_APPROVAL, onApproval);

    return [
      () => {
        eventEmitter.off(SubAgentEventType.TOOL_CALL, onToolCall);
        eventEmitter.off(SubAgentEventType.TOOL_RESULT, onToolResult);
        eventEmitter.off(SubAgentEventType.TOOL_WAITING_APPROVAL, onApproval);
        // Clean up any remaining states
        this.toolStates.clear();
      },
    ];
  }

  /**
   * Creates a handler for tool call start events.
   */
  private createToolCallHandler(
    abortSignal: AbortSignal,
  ): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const event = args[0] as SubAgentToolCallEvent;
      if (abortSignal.aborted) return;

      // Look up tool and build invocation for metadata
      const toolRegistry = this.ctx.config.getToolRegistry();
      const tool = toolRegistry.getTool(event.name);
      let invocation: AnyToolInvocation | undefined;

      if (tool) {
        try {
          invocation = tool.build(event.args);
        } catch (e) {
          // If building fails, continue with defaults
          console.warn(`Failed to build subagent tool ${event.name}:`, e);
        }
      }

      // Store tool, invocation, and args for result handling
      this.toolStates.set(event.callId, {
        tool,
        invocation,
        args: event.args,
      });

      // Use unified emitter - handles TodoWriteTool skipping internally
      void this.toolCallEmitter.emitStart({
        toolName: event.name,
        callId: event.callId,
        args: event.args,
      });
    };
  }

  /**
   * Creates a handler for tool result events.
   */
  private createToolResultHandler(
    abortSignal: AbortSignal,
  ): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const event = args[0] as SubAgentToolResultEvent;
      if (abortSignal.aborted) return;

      const state = this.toolStates.get(event.callId);

      // Use unified emitter - handles TodoWriteTool plan updates internally
      void this.toolCallEmitter.emitResult({
        toolName: event.name,
        callId: event.callId,
        success: event.success,
        message: event.responseParts ?? [],
        resultDisplay: event.resultDisplay,
        args: state?.args,
      });

      // Clean up state
      this.toolStates.delete(event.callId);
    };
  }

  /**
   * Creates a handler for tool approval request events.
   */
  private createApprovalHandler(
    abortSignal: AbortSignal,
  ): (...args: unknown[]) => Promise<void> {
    return async (...args: unknown[]) => {
      const event = args[0] as SubAgentApprovalRequestEvent;
      if (abortSignal.aborted) return;

      const state = this.toolStates.get(event.callId);
      const content: acp.ToolCallContent[] = [];

      // Handle edit confirmation type - show diff
      if (event.confirmationDetails.type === 'edit') {
        const editDetails = event.confirmationDetails as unknown as {
          type: 'edit';
          fileName: string;
          originalContent: string | null;
          newContent: string;
        };
        content.push({
          type: 'diff',
          path: editDetails.fileName,
          oldText: editDetails.originalContent ?? '',
          newText: editDetails.newContent,
        });
      }

      // Build permission request
      const fullConfirmationDetails = {
        ...event.confirmationDetails,
        onConfirm: async () => {
          // Placeholder - actual response handled via event.respond
        },
      } as unknown as ToolCallConfirmationDetails;

      const { title, locations, kind } =
        this.toolCallEmitter.resolveToolMetadata(event.name, state?.args);

      const params: acp.RequestPermissionRequest = {
        sessionId: this.ctx.sessionId,
        options: this.toPermissionOptions(fullConfirmationDetails),
        toolCall: {
          toolCallId: event.callId,
          status: 'pending',
          title,
          content,
          locations,
          kind,
          rawInput: state?.args,
        },
      };

      try {
        // Request permission from client
        const output = await this.client.requestPermission(params);
        const outcome =
          output.outcome.outcome === 'cancelled'
            ? ToolConfirmationOutcome.Cancel
            : z
                .nativeEnum(ToolConfirmationOutcome)
                .parse(output.outcome.optionId);

        // Respond to subagent with the outcome
        await event.respond(outcome);
      } catch (error) {
        // If permission request fails, cancel the tool call
        console.error(
          `Permission request failed for subagent tool ${event.name}:`,
          error,
        );
        await event.respond(ToolConfirmationOutcome.Cancel);
      }
    };
  }

  /**
   * Converts confirmation details to permission options for the client.
   */
  private toPermissionOptions(
    confirmation: ToolCallConfirmationDetails,
  ): acp.PermissionOption[] {
    switch (confirmation.type) {
      case 'edit':
        return [
          {
            optionId: ToolConfirmationOutcome.ProceedAlways,
            name: 'Allow All Edits',
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ];
      case 'exec':
        return [
          {
            optionId: ToolConfirmationOutcome.ProceedAlways,
            name: `Always Allow ${(confirmation as { rootCommand?: string }).rootCommand ?? 'command'}`,
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ];
      case 'mcp':
        return [
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysServer,
            name: `Always Allow ${(confirmation as { serverName?: string }).serverName ?? 'server'}`,
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysTool,
            name: `Always Allow ${(confirmation as { toolName?: string }).toolName ?? 'tool'}`,
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ];
      case 'info':
        return [
          {
            optionId: ToolConfirmationOutcome.ProceedAlways,
            name: 'Always Allow',
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ];
      case 'plan':
        return [
          {
            optionId: ToolConfirmationOutcome.ProceedAlways,
            name: 'Always Allow Plans',
            kind: 'allow_always',
          },
          ...basicPermissionOptions,
        ];
      default: {
        // Fallback for unknown types
        return [...basicPermissionOptions];
      }
    }
  }
}
