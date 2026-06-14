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
  SubagentMeta,
} from '../types.js';
import type {
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { Part } from '@google/genai';
import { ToolNames, Kind } from '@qwen-code/qwen-code-core';
import { buildTruncatedDiffPreviewText } from '../../../utils/truncatedDiffPreview.js';

const KIND_MAP: Record<Kind, ToolKind> = {
  [Kind.Read]: 'read',
  [Kind.Edit]: 'edit',
  [Kind.Delete]: 'delete',
  [Kind.Move]: 'move',
  [Kind.Search]: 'search',
  [Kind.Execute]: 'execute',
  [Kind.Think]: 'think',
  [Kind.Fetch]: 'fetch',
  // ACP defines no 'agent' ToolKind (verified through @agentclientprotocol/sdk
  // 0.25.1). The daemon's ClientSideConnection Zod-validates every session/update
  // and session/request_permission from the `qwen --acp` child before fanning out
  // to SSE clients, so emitting 'agent' is rejected at that hop and the frame is
  // dropped. Map the internal Kind.Agent to 'other' on the wire to stay
  // protocol-valid; dedicated agent UI is delivered out-of-band (via _meta.toolName)
  // in a follow-up rather than via a kind the protocol can't carry.
  [Kind.Agent]: 'other',
  [Kind.Other]: 'other',
};

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
    const provenance = ToolCallEmitter.resolveToolProvenance(
      params.toolName,
      params.subagentMeta,
    );

    await this.sendUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: params.callId,
      status: params.status || 'pending',
      title,
      content: [],
      locations,
      kind,
      rawInput: params.args ?? {},
      _meta: {
        toolName: params.toolName,
        ...params.subagentMeta,
        provenance: provenance.provenance,
        ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
        ...(BaseEmitter.toEpochMs(params.timestamp) != null && {
          timestamp: BaseEmitter.toEpochMs(params.timestamp),
        }),
      },
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
    let contentArray: ToolCallContent[] = [];

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
    const provenance = ToolCallEmitter.resolveToolProvenance(
      params.toolName,
      params.subagentMeta,
    );
    const update: Parameters<typeof this.sendUpdate>[0] = {
      sessionUpdate: 'tool_call_update',
      toolCallId: params.callId,
      status: params.success ? 'completed' : 'failed',
      content: contentArray,
      _meta: {
        toolName: params.toolName,
        ...params.subagentMeta,
        provenance: provenance.provenance,
        ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
        ...(BaseEmitter.toEpochMs(params.timestamp) != null && {
          timestamp: BaseEmitter.toEpochMs(params.timestamp),
        }),
      },
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
   * @param toolName - The tool name
   * @param error - The error that occurred
   * @param subagentMeta - Optional subagent metadata
   */
  async emitError(
    callId: string,
    toolName: string,
    error: Error,
    subagentMeta?: SubagentMeta,
  ): Promise<void> {
    const provenance = ToolCallEmitter.resolveToolProvenance(
      toolName,
      subagentMeta,
    );
    await this.sendUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      status: 'failed',
      content: [
        { type: 'content', content: { type: 'text', text: error.message } },
      ],
      _meta: {
        toolName,
        ...subagentMeta,
        provenance: provenance.provenance,
        ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
      },
    });
  }

  /**
   * Resolve a tool's provenance for UI dispatch on tool_call events.
   * The SDK reads `_meta.
   * provenance` + `_meta.serverId` to render builtin / MCP-server-badge /
   * subagent-block differently. Without this stamping, the SDK falls
   * back to string-matching the toolName which can't reliably
   * distinguish builtin from subagent.
   *
   * Resolution rules:
   *   - `subagentMeta` present → `'subagent'` (a Task tool / Codex
   *     subagent / etc. wrapping its own tool calls)
   *   - toolName matches `mcp__<server>__<tool>` → `'mcp'` with
   *     `serverId: <server>`. Naming convention from
   *     `packages/core/src/tools/mcp-tool.ts` in the
   *     `@qwen-code/qwen-code-core` package — mirrors the SDK's same
   *     heuristic fallback so SDK consumers stay consistent with
   *     daemon classification.
   *   - everything else → `'builtin'`
   *
   * Static + pure so it can be unit-tested without an emitter
   * instance. Exported via `ToolCallEmitter.resolveToolProvenance`.
   */
  static resolveToolProvenance(
    toolName: string,
    subagentMeta?: SubagentMeta,
  ): { provenance: 'builtin' | 'mcp' | 'subagent'; serverId?: string } {
    if (subagentMeta !== undefined) {
      return { provenance: 'subagent' };
    }
    if (toolName.startsWith('mcp__')) {
      // mcp__<serverName>__<toolName> — split is "__", not single "_",
      // so server / tool segments can contain underscores. Require
      // both a non-empty server segment and at least one segment past
      // it; malformed names fall through to 'builtin' rather than
      // stamping an empty/garbage serverId.
      const parts = toolName.split('__');
      if (parts.length >= 3 && parts[1] && parts[1].length > 0) {
        return { provenance: 'mcp', serverId: parts[1] };
      }
    }
    return { provenance: 'builtin' };
  }

  // ==================== Public Utilities ====================

  /**
   * Checks if a tool name is the TodoWriteTool.
   * Exposed for external use in components that need to check this.
   */
  isTodoWriteTool(toolName: string): boolean {
    return toolName === ToolNames.TODO_WRITE;
  }

  /**
   * Checks if a tool name is the ExitPlanModeTool.
   */
  isExitPlanModeTool(toolName: string): boolean {
    return toolName === ToolNames.EXIT_PLAN_MODE;
  }

  /**
   * Checks if a tool name is the EnterPlanModeTool.
   */
  isEnterPlanModeTool(toolName: string): boolean {
    return toolName === ToolNames.ENTER_PLAN_MODE;
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
    let locations: ToolCallLocation[] = [];
    let kind: ToolKind = 'other';

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
        // Fallback: use the description arg directly if available
        if (typeof args['description'] === 'string') {
          title = `${title}: ${args['description']}`;
        }
        if (tool.kind) {
          kind = this.mapToolKind(tool.kind, toolName);
        }
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
  mapToolKind(kind: Kind, toolName?: string): ToolKind {
    // Special case: enter/exit_plan_mode use 'switch_mode' kind per ACP spec
    if (
      toolName &&
      (this.isExitPlanModeTool(toolName) || this.isEnterPlanModeTool(toolName))
    ) {
      return 'switch_mode';
    }
    return KIND_MAP[kind] ?? 'other';
  }

  // ==================== Private Helpers ====================

  /**
   * Extracts diff content from resultDisplay if it's a diff type (edit tool result).
   * Returns null if not a diff.
   */
  private extractDiffContent(resultDisplay: unknown): ToolCallContent | null {
    if (!resultDisplay || typeof resultDisplay !== 'object') return null;

    const obj = resultDisplay as Record<string, unknown>;

    // Check if this is a diff display (edit tool result)
    if ('fileName' in obj && 'newContent' in obj) {
      if (obj['truncatedForSession'] === true) {
        return {
          type: 'content',
          content: {
            type: 'text',
            text: buildTruncatedDiffPreviewText(obj),
          },
        };
      }

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
  private transformPartsToToolCallContent(parts: Part[]): ToolCallContent[] {
    const result: ToolCallContent[] = [];

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
          const resp = part.functionResponse.response as Record<
            string,
            unknown
          >;
          const outputField = resp['output'];
          const errorField = resp['error'];
          const responseText =
            typeof outputField === 'string'
              ? outputField
              : typeof errorField === 'string'
                ? errorField
                : JSON.stringify(resp);
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
