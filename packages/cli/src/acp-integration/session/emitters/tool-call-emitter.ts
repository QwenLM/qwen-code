/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseEmitter } from './base-emitter.js';
import { PlanEmitter } from './PlanEmitter.js';
import type {
  SessionEmitterContext,
  ToolCallStartParams,
  ToolCallResultParams,
  ResolvedToolMetadata,
  SubagentMeta,
} from '../types.js';
import { hasFullSessionContext } from '../types.js';
import type {
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk';
import {
  formatVisionBridgeNoticeDisplay,
  isVisionBridgeNoticeDisplay,
  ToolNames,
  Kind,
} from '@qwen-code/qwen-code-core';
import {
  createTranscriptToolCallResultUpdate,
  createTranscriptToolCallStartUpdate,
} from '@qwen-code/acp-bridge/transcriptReplay';
import { sanitizeTerminalText } from '../../../ui/utils/textUtils.js';

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
  private readonly preparedCallIds = new Set<string>();

  constructor(ctx: SessionEmitterContext) {
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
    if (
      params.phase === 'preparing' &&
      this.preparedCallIds.has(params.callId)
    ) {
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
    const updatesPreparedCall =
      params.phase !== 'preparing' &&
      this.preparedCallIds.delete(params.callId);

    await this.sendUpdate(
      createTranscriptToolCallStartUpdate({
        toolName: params.toolName,
        callId: params.callId,
        status: params.status || 'pending',
        args: params.args,
        metadata: { title, locations, kind },
        timestamp: params.timestamp,
        asUpdate: updatesPreparedCall,
        extra: {
          ...(params.phase ? { phase: params.phase } : {}),
          ...params.subagentMeta,
          provenance: provenance.provenance,
          ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
        },
      }),
    );
    if (params.phase === 'preparing') {
      this.preparedCallIds.add(params.callId);
    }

    return true;
  }

  /**
   * Emits a terminal frame when a prepared tool call is discarded before
   * execution. TodoWrite remains represented exclusively by plan updates.
   *
   * @param callId - ID of the prepared tool call
   * @param toolName - Name of the prepared tool
   */
  async emitPreparationDiscarded(
    callId: string,
    toolName: string,
  ): Promise<void> {
    if (this.isTodoWriteTool(toolName)) return;

    this.preparedCallIds.delete(callId);
    const provenance = ToolCallEmitter.resolveToolProvenance(toolName);
    await this.sendUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      status: 'failed',
      content: [],
      _meta: {
        toolName,
        phase: 'preparing',
        preparationDiscarded: true,
        provenance: provenance.provenance,
        ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
      },
    });
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
      if (!params.success) return;
      const plan = this.planEmitter.extractPlan(
        params.resultDisplay,
        params.args,
      );
      // Match original behavior: send plan even if empty when args['todos'] exists
      // This ensures the UI is updated even when all todos are removed
      if (
        plan &&
        (plan.todos.length > 0 ||
          (params.args && Array.isArray(params.args['todos'])))
      ) {
        await this.planEmitter.emitPlan(plan, params.callId);
      }
      return; // Skip tool_call_update for TodoWriteTool
    }

    this.preparedCallIds.delete(params.callId);
    const provenance = ToolCallEmitter.resolveToolProvenance(
      params.toolName,
      params.subagentMeta,
    );
    await this.sendUpdate(
      createTranscriptToolCallResultUpdate({
        toolName: params.toolName,
        callId: params.callId,
        success: params.success,
        message: params.message,
        resultDisplay: params.resultDisplay,
        errorMessage: params.error?.message,
        artifacts: params.artifacts,
        contentPrefix: buildToolResultContentPrefix(params.resultDisplay),
        timestamp: params.timestamp,
        extra: {
          ...params.subagentMeta,
          provenance: provenance.provenance,
          ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
        },
      }),
    );
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
    this.preparedCallIds.delete(callId);
    const provenance = ToolCallEmitter.resolveToolProvenance(
      toolName,
      subagentMeta,
    );
    await this.sendUpdate(
      createTranscriptToolCallResultUpdate({
        toolName,
        callId,
        success: false,
        errorMessage: error.message,
        extra: {
          ...subagentMeta,
          provenance: provenance.provenance,
          ...(provenance.serverId ? { serverId: provenance.serverId } : {}),
        },
      }),
    );
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
    if (!hasFullSessionContext(this.ctx)) {
      const description =
        typeof args?.['description'] === 'string'
          ? args['description'].trim()
          : '';
      return {
        title: description ? `${toolName}: ${description}` : toolName,
        locations: [],
        kind: 'other',
      };
    }
    const toolRegistry = this.ctx.config.getToolRegistry();
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
}

export function buildToolResultContentPrefix(
  resultDisplay: unknown,
): ToolCallContent[] {
  if (!isVisionBridgeNoticeDisplay(resultDisplay)) return [];
  return [
    {
      type: 'content',
      content: {
        type: 'text',
        text: sanitizeTerminalText(
          formatVisionBridgeNoticeDisplay(resultDisplay),
        ),
      },
    },
  ];
}
