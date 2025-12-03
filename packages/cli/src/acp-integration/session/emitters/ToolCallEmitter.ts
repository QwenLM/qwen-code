/**
 * @license
 * Copyright 2025 Qwen
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
import type { Part } from '@google/genai';
import {
  TodoWriteTool,
  Kind,
  ExitPlanModeTool,
} from '@qwen-code/qwen-code-core';

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

    // Determine content for the update
    let contentArray: acp.ToolCallContent[] = [];

    // Special case: diff result from edit tools (format from resultDisplay)
    const diffContent = this.extractDiffContent(params.resultDisplay);
    if (diffContent) {
      contentArray = [diffContent];
    } else if (params.error) {
      // Error case: show error message
      contentArray = [
        {
          type: 'content',
          content: { type: 'text', text: params.error.message },
        },
      ];
    } else {
      // Normal case: transform message parts to ToolCallContent[]
      contentArray = this.transformPartsToToolCallContent(params.message);
    }

    // Build the update
    const update: Parameters<typeof this.sendUpdate>[0] = {
      sessionUpdate: 'tool_call_update',
      toolCallId: params.callId,
      status: params.success ? 'completed' : 'failed',
      content: contentArray,
    };

    // Add rawOutput from resultDisplay
    if (params.resultDisplay !== undefined) {
      (update as Record<string, unknown>)['rawOutput'] = params.resultDisplay;
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
   * Checks if a tool name is the ExitPlanModeTool.
   */
  isExitPlanModeTool(toolName: string): boolean {
    return toolName === ExitPlanModeTool.Name;
  }

  /**
   * Resolves tool metadata from the registry.
   * Falls back to defaults if tool not found or build fails.
   *
   * @param toolName - Name of the tool
   * @param args - Tool call arguments (used to build invocation)
   */
  resolveToolMetadata(
    toolName: string,
    args?: Record<string, unknown>,
  ): ResolvedToolMetadata {
    const toolRegistry = this.config.getToolRegistry();
    const tool = toolRegistry.getTool(toolName);

    let title = tool?.displayName ?? toolName;
    let locations: acp.ToolCallLocation[] = [];
    let kind: acp.ToolKind = 'other';

    if (tool && args) {
      try {
        const invocation = tool.build(args);
        title = `${title}: ${invocation.getDescription()}`;
        // Map locations to ensure line is null instead of undefined (for ACP consistency)
        locations = invocation.toolLocations().map((loc) => ({
          path: loc.path,
          line: loc.line ?? null,
        }));
        // Pass tool name to handle special cases like exit_plan_mode -> switch_mode
        kind = this.mapToolKind(tool.kind, toolName);
      } catch {
        // Use defaults on build failure
      }
    }

    return { title, locations, kind };
  }

  /**
   * Maps core Tool Kind enum to ACP ToolKind string literals.
   *
   * @param kind - The core Kind enum value
   * @param toolName - Optional tool name to handle special cases like exit_plan_mode
   */
  mapToolKind(kind: Kind, toolName?: string): acp.ToolKind {
    // Special case: exit_plan_mode uses 'switch_mode' kind per ACP spec
    if (toolName && this.isExitPlanModeTool(toolName)) {
      return 'switch_mode';
    }

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
   * Extracts diff content from resultDisplay if it's a diff type (edit tool result).
   * Returns null if not a diff.
   */
  private extractDiffContent(
    resultDisplay: unknown,
  ): acp.ToolCallContent | null {
    if (!resultDisplay || typeof resultDisplay !== 'object') return null;

    const obj = resultDisplay as Record<string, unknown>;

    // Check if this is a diff display (edit tool result)
    if ('fileName' in obj && 'newContent' in obj) {
      return {
        type: 'diff',
        path: obj['fileName'] as string,
        oldText: (obj['originalContent'] as string) ?? '',
        newText: obj['newContent'] as string,
      };
    }

    return null;
  }

  /**
   * Transforms Part[] to ToolCallContent[].
   * Extracts text from functionResponse parts and text parts.
   */
  private transformPartsToToolCallContent(
    parts: Part[],
  ): acp.ToolCallContent[] {
    const result: acp.ToolCallContent[] = [];

    for (const part of parts) {
      // Handle text parts
      if ('text' in part && part.text) {
        result.push({
          type: 'content',
          content: { type: 'text', text: part.text },
        });
      }

      // Handle functionResponse parts - stringify the response
      if ('functionResponse' in part && part.functionResponse) {
        try {
          const responseText = JSON.stringify(part.functionResponse.response);
          result.push({
            type: 'content',
            content: { type: 'text', text: responseText },
          });
        } catch {
          // Ignore serialization errors
        }
      }
    }

    return result;
  }
}
