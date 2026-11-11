/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SystemPrompt } from '../prompts/types.js';
import type { FileStateCache } from '../utils/fileStateCache.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Config } from './config.js';
import type { Message } from '../protocol/transcript/message.js';
import type { PermissionContext } from '../permissions/manager/types.js';
import type { SessionPermissionManager } from '../permissions/manager/session-permission-manager.js';
import type { ToolCallSnapshotStore } from '../tool-executor/tool-call-snapshot.js';
import type { TaskRegistry } from '../tasks/task-registry.js';
import type { InternalExecutionOwner } from '../tools/tool-types.js';
import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';
import type { PromptBuildResult } from '../prompts/types.js';

export interface ConversationMessageAccessorSource {
  getConversationMessages(): readonly Message[];
  stripThoughtsFromConversationHistory(): void;
}

/**
 * AgentLoopContext represents the execution-scoped view of the world for a single
 * agent turn or sub-agent loop.
 */
export interface AgentLoopContext {
  /** File baselines owned by this session/agent, never shared across sessions. */
  readonly fileReadState?: FileStateCache;
  /** Current subagent ID. Undefined for the main session. */
  readonly agentId?: string;
  /** Tool call that launched this agent, used to associate child tool events with it. */
  readonly parentToolUseId?: string;

  /**
   * Doom-loop streak for this agent. Created lazily by the tool executor so the
   * streak follows the agent's lifetime instead of one model response.
   */
  doomLoopGuard?: import('../core/doom-loop-guard.js').DoomLoopGuard;

  /** Current subagent nesting depth. The main session is depth 0. */
  readonly agentDepth?: number;

  /** Subagent type label used by tool gate reports. */
  readonly agentType?: string;

  /** UI observer for terminal tool calls; invoked by the owning executor. */
  readonly onCompletedToolCall?: (
    call: import('../tool-executor/types.js').CompletedToolCall,
  ) => void;

  /** The global runtime configuration. */
  readonly config: Config;

  /** The unique ID for the current user turn or agent thought loop. */
  readonly promptId: string;

  /** The unique ID for the parent session if this is a subagent. */
  readonly parentSessionId?: string;

  /** The registry of tools available to the agent in this context. */
  readonly toolRegistry: ToolRegistry;

  /** Tool-call lifecycle snapshots for UI and remote observers. */
  readonly toolCallSnapshots: ToolCallSnapshotStore;

  /** Returns the current conversation history for this execution context. */
  readonly getConversationMessages: () => readonly Message[];

  /**
   * Removes provider-specific "thought" entries from the current history.
   */
  readonly stripThoughtsFromConversationHistory: () => void;

  // ── Permission (optional — activated by CLI initialization) ──

  /**
   * The permission object for this execution context: mode, rules, trusted
   * directories, the tool check table and the ask handler all live behind it,
   * and `checkPermission` is the only gate a tool call passes through.
   *
   * Shared by reference rather than copied, so a mode switch or a rule written
   * from a prompt is immediately visible to every holder — including subagents
   * that inherit this context. An entry point that needs to differ for its own
   * calls (a fork that must not prompt, a hook agent pinned to DontAsk) passes
   * a per-call override to `checkPermission` instead of constructing a second
   * object.
   *
   * Absent in contexts assembled without a host (some tests, some internal
   * bridges); the pre-execution gate refuses tool calls when it is missing,
   * because nothing else can judge them.
   */
  readonly permission?: SessionPermissionManager;

  /**
   * How this context's calls diverge from the shared object, asked for once per
   * tool call rather than stored.
   *
   * It is a supplier because the divergence is usually relative to the live
   * parent state: a subagent's declared mode only takes effect while the parent
   * sits in Default, so a value pinned at construction time would be wrong the
   * moment the user switched modes. Forks that diverge unconditionally simply
   * return a constant.
   *
   * This is per-context data, not a second copy of the configuration, so it does
   * not bring back the drift the field collapse removed — there is still exactly
   * one place the mode and the rules live.
   */
  readonly permissionContext?: () => PermissionContext | undefined;

  /**
   * Whether this context is inside a plan session of its own.
   *
   * A plan-mode subagent must not touch the global plan state, or exiting the
   * subagent's plan would end the parent's too, so its flag lives here. Mutable
   * because ExitPlanMode clears it.
   *
   * This used to ride on the permission configuration, which was the wrong home:
   * plan state is execution state, not a rule or a mode, and keeping it there
   * meant two places had to be kept in step.
   */
  planModeActive?: boolean;

  /**
   * Returns the parent's system prompt blocks.
   * Required for fork subagent prompt-cache sharing (byte-identical prefix).
   * Populated by QueryEngine; may be undefined in contexts without a live session.
   */
  readonly getSystemPrompt?: () => SystemPrompt | undefined;

  /** Returns the last successfully rendered main-agent prompt result. */
  readonly getPromptBuildResult?: () => PromptBuildResult | undefined;

  /** 返回父请求的标准工具声明快照，由 QueryEngine 提供以保持 fork 缓存前缀。 */
  readonly getParentToolSchemas?: () => Array<
    import('../provider/modelStreamRequest.js').ModelStreamTool
  >;

  /**
   * Returns the last parent model request snapshot that is safe for prompt-cache
   * sharing. Used by forked agents and manual compaction to preserve the exact
   * resolved model and inline direct-connection credentials.
   */
  readonly getCacheSafeQuerySnapshot?: () => CacheSafeQuerySnapshot | null;

  // ── Unified Task System (optional — activated by CLI initialization) ──

  /** Registry for tracking all background tasks (shell + agent). */
  readonly taskRegistry?: TaskRegistry;

  /** Internal owner metadata for tool executions spawned by this loop. */
  readonly internalExecutionOwner?: InternalExecutionOwner;
}

export function createConversationMessageAccessors(
  source: ConversationMessageAccessorSource,
) {
  return {
    getConversationMessages: () => source.getConversationMessages(),
    stripThoughtsFromConversationHistory: () =>
      source.stripThoughtsFromConversationHistory(),
  };
}
