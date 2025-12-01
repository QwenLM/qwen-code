/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseEmitter } from './BaseEmitter.js';
import { PlanEmitter } from './PlanEmitter.js';
import type {
  SessionContext,
  ToolCallStartParams,
  ToolCallResultParams,
  ResolvedToolMetadata,
} from '../types.js';
import type * as acp from '../../acp.js';
import { TodoWriteTool, Kind } from '@qwen-code/qwen-code-core';

/**
 * Unified tool call event emitter.
 *
 * Handles tool_call and tool_call_update for ALL flows:
 * - Normal tool execution in runTool()
 * - History replay in HistoryReplayer
 * - SubAgent tool tracking in SubAgentTracker
 *
 * This ensures consistent behavior across all tool event sources,
 * including special handling for tools like TodoWriteTool.
 */
export class ToolCallEmitter extends BaseEmitter {
  private readonly planEmitter: PlanEmitter;

  constructor(ctx: SessionContext) {
    super(ctx);
    this.planEmitter = new PlanEmitter(ctx);
  }

  /**
   * Emits a tool call start event.
   *
   * @param params - Tool call start parameters
   * @returns true if event was emitted, false if skipped (e.g., TodoWriteTool)
   */
  async emitStart(params: ToolCallStartParams): Promise<boolean> {
    // Skip tool_call for TodoWriteTool - plan updates sent on result
    if (this.isTodoWriteTool(params.toolName)) {
      return false;
    }

    const { title, locations, kind } = this.resolveToolMetadata(
      params.toolName,
      params.args,
      params.description,
    );

    await this.sendUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: params.callId,
      status: 'in_progress',
      title,
      content: [],
      locations,
      kind,
      rawInput: params.args ?? {},
    });

    return true;
  }

  /**
   * Emits a tool call result event.
   * Handles TodoWriteTool specially by routing to plan updates.
   *
   * @param params - Tool call result parameters
   */
  async emitResult(params: ToolCallResultParams): Promise<void> {
    // Handle TodoWriteTool specially - send plan update instead
    if (this.isTodoWriteTool(params.toolName)) {
      const todos = this.planEmitter.extractTodos(
        params.resultDisplay,
        params.args,
      );
      // Match original behavior: send plan even if empty when args['todos'] exists
      // This ensures the UI is updated even when all todos are removed
      if (todos && todos.length > 0) {
        await this.planEmitter.emitPlan(todos);
      } else if (params.args && Array.isArray(params.args['todos'])) {
        // Send empty plan when args had todos but result has none
        await this.planEmitter.emitPlan([]);
      }
      return; // Skip tool_call_update for TodoWriteTool
    }

    // Normal tool result - try resultDisplay first, then fallbackContent
    let content = this.extractResultContent(params.resultDisplay, params.error);

    // Use fallbackContent if no content extracted from resultDisplay
    if (!content && params.fallbackContent) {
      content = {
        type: 'content',
        content: { type: 'text', text: params.fallbackContent },
      };
    }

    // Build the update with optional extra fields (for SubAgentTracker)
    const update: Parameters<typeof this.sendUpdate>[0] = {
      sessionUpdate: 'tool_call_update',
      toolCallId: params.callId,
      status: params.success ? 'completed' : 'failed',
      content: content ? [content] : [],
    };

    // Add extra fields if provided (used by SubAgentTracker)
    if (params.extra) {
      if (params.extra.title !== undefined) {
        (update as Record<string, unknown>)['title'] = params.extra.title;
      }
      if (params.extra.kind !== undefined) {
        (update as Record<string, unknown>)['kind'] = params.extra.kind;
      }
      if (params.extra.locations !== undefined) {
        (update as Record<string, unknown>)['locations'] =
          params.extra.locations;
      }
      if (params.extra.rawInput !== undefined) {
        (update as Record<string, unknown>)['rawInput'] = params.extra.rawInput;
      }
    }

    await this.sendUpdate(update);
  }

  /**
   * Emits a tool call error event.
   * Use this for explicit error handling when not using emitResult.
   *
   * @param callId - The tool call ID
   * @param error - The error that occurred
   */
  async emitError(callId: string, error: Error): Promise<void> {
    await this.sendUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      status: 'failed',
      content: [
        { type: 'content', content: { type: 'text', text: error.message } },
      ],
    });
  }

  // ==================== Public Utilities ====================

  /**
   * Checks if a tool name is the TodoWriteTool.
   * Exposed for external use in components that need to check this.
   */
  isTodoWriteTool(toolName: string): boolean {
    return toolName === TodoWriteTool.Name;
  }

  /**
   * Resolves tool metadata from the registry.
   * Falls back to defaults if tool not found or build fails.
   *
   * @param toolName - Name of the tool
   * @param args - Tool call arguments (used to build invocation)
   * @param descriptionOverride - Optional description to use instead of invocation description
   */
  resolveToolMetadata(
    toolName: string,
    args?: Record<string, unknown>,
    descriptionOverride?: string,
  ): ResolvedToolMetadata {
    const toolRegistry = this.config.getToolRegistry();
    const tool = toolRegistry.getTool(toolName);

    let title = descriptionOverride ?? toolName;
    let locations: acp.ToolCallLocation[] = [];
    let kind: acp.ToolKind = 'other';

    if (tool && args) {
      try {
        const invocation = tool.build(args);
        title = descriptionOverride ?? invocation.getDescription();
        // Map locations to ensure line is null instead of undefined (for ACP consistency)
        locations = invocation.toolLocations().map((loc) => ({
          path: loc.path,
          line: loc.line ?? null,
        }));
        kind = this.mapToolKind(tool.kind);
      } catch {
        // Use defaults on build failure
      }
    }

    return { title, locations, kind };
  }

  /**
   * Maps core Tool Kind enum to ACP ToolKind string literals.
   */
  mapToolKind(kind: Kind): acp.ToolKind {
    const kindMap: Record<Kind, acp.ToolKind> = {
      [Kind.Read]: 'read',
      [Kind.Edit]: 'edit',
      [Kind.Delete]: 'delete',
      [Kind.Move]: 'move',
      [Kind.Search]: 'search',
      [Kind.Execute]: 'execute',
      [Kind.Think]: 'think',
      [Kind.Fetch]: 'fetch',
      [Kind.Other]: 'other',
    };
    return kindMap[kind] ?? 'other';
  }

  // ==================== Private Helpers ====================

  /**
   * Extracts content from tool result display or error.
   * Matches original extractToolResultDisplay behavior with JSON.stringify fallback.
   */
  private extractResultContent(
    resultDisplay: unknown,
    error?: Error,
  ): acp.ToolCallContent | null {
    if (error) {
      return {
        type: 'content',
        content: { type: 'text', text: error.message },
      };
    }

    if (!resultDisplay) return null;

    // Handle string result
    if (typeof resultDisplay === 'string') {
      return {
        type: 'content',
        content: { type: 'text', text: resultDisplay },
      };
    }

    // Handle object results
    if (typeof resultDisplay === 'object') {
      const obj = resultDisplay as Record<string, unknown>;

      // Handle diff display (edit tool result)
      if ('fileName' in obj && 'newContent' in obj) {
        return {
          type: 'diff',
          path: obj['fileName'] as string,
          oldText: (obj['originalContent'] as string) ?? '',
          newText: obj['newContent'] as string,
        };
      }

      // Handle plan_summary display
      if (obj['type'] === 'plan_summary') {
        return {
          type: 'content',
          content: {
            type: 'text',
            text: `${obj['message']}\n\n${obj['plan']}`,
          },
        };
      }

      // Fallback: JSON.stringify for any other object type
      // This matches original extractToolResultDisplay behavior
      try {
        return {
          type: 'content',
          content: { type: 'text', text: JSON.stringify(resultDisplay) },
        };
      } catch {
        return null;
      }
    }

    return null;
  }
}
