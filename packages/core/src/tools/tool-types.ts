/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Core types for the enhanced tool system: permission decisions,
 * unified execution context, and interrupt behavior declarations.
 */

import type { Model } from '../provider/model/model.js';
import type { FileStateCache } from '../utils/fileStateCache.js';
import type { ExecuteOptions, ToolLiveOutput } from './tools.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Config } from '../config/config.js';
import type { FileHistoryManager } from '../file-history/file-history.js';
import type { BusinessInfo } from '../qoder/business-info.js';
import type { McpInfo } from '../mcp/tools/mcp-tool.js';


export type PermissionDecisionKind = 'allow' | 'deny' | 'ask_user';

export interface PermissionDecision {
  readonly decision: PermissionDecisionKind;
  /** Human-readable reason (useful for audit trails). */
  readonly reason?: string;
}

/**
 * - `'block'`: Cancel via AbortSignal (safe default).
 * - `'background'`: Move to background (e.g., shell).
 * - `'ignore'`: Ignore the interrupt (e.g., think tool).
 */
export type InterruptBehavior = 'block' | 'background' | 'ignore';

/** Identifies the execution surface that initiated a tool invocation. */
export type ToolInvocationOrigin = 'model' | 'user-shell' | 'internal';

export interface InternalExecutionOwner {
  readonly kind: 'workflow-agent';
  readonly workflowRunId?: string;
  readonly workflowExecutionId?: string;
  /** @deprecated Top-level Workflow tool call id; not an execution id. */
  readonly workflowTaskId?: string;
  readonly workflowAgentIndex?: number;
  readonly workflowPhaseIndex?: number;
  readonly workflowAttempt?: number;
  readonly suppressMainSessionNotification: true;
  readonly disableShellAutoBackground: true;
}

/** A guard returns a rejection message when a direct tool call must not run now. */
export type ToolAdmissionGuard = (request: {
  readonly name: string;
  readonly toolCallScopeId?: string;
}) => string | undefined;

/** Owned by one agent query; cleanups run when the query ends. */
export interface QueryLifecycle {
  readonly signal: AbortSignal;
  readonly cleanups: Set<() => Promise<void>>;
  readonly admissionGuards: Set<ToolAdmissionGuard>;
}

/**
 * Unified context passed to tool invocations at execution time.
 *
 * Constructed at the top of the execution chain (ToolExecutor) and
 * flows downward through executeToolWithHooks → executeWithContext.
 * Tools receive the full context without needing constructor injection.
 */
export interface ToolUseContext {
  /** Query-owned resources for tool work that outlives one call, such as CodeMode cells. */
  readonly queryLifecycle?: QueryLifecycle;
  /** Select semantic delivery after hooks instead of model text truncation. */
  readonly resultConsumption?: 'model' | 'programmatic';
  /** File baselines owned by this session/agent, never shared across sessions. */
  readonly fileReadState?: FileStateCache;
  /** Set to false to return content for repeated model Read calls. */
  readonly dedupUnchangedReads?: boolean;
  /** Internal Read consumers can reduce the normal output token budget. */
  readonly fileReadingLimits?: {
    readonly maxTokens: number;
    /** Internal recovery can omit the default line cap; byte/token caps remain. */
    readonly wholeFile?: boolean;
  };
  readonly inputModifiedByHook?: boolean;
  /** The host shows the image this programmatic Read returns, so the text-only gate does not apply. */
  readonly hostImageRead?: boolean;
  readonly signal: AbortSignal;
  readonly updateOutput?: (output: ToolLiveOutput) => void;
  readonly options?: ExecuteOptions;
  /** Defaults to `model` for existing scheduler-created contexts. */
  readonly invocationOrigin?: ToolInvocationOrigin;

  /**
   * The AbortController that owns `signal` — enables tools to create
   * child controllers for sub-operations via createChildAbortController().
   */
  readonly abortController?: AbortController;

  /**
   * Global configuration. When ctx is constructed by ToolExecutor (the
   * production path), this is always present. Marked optional only for
   * backward compatibility with SimpleInvocation's inline construction,
   * which will be removed in Phase C.
   */
  readonly config?: Config;

  /** Execution context used by tools that resume local agents. */
  readonly agentLoopContext?: AgentLoopContext;

  /** Tool call identifier for tracing and logging. */
  readonly callId?: string;

  /** Scope that owns this tool call, isolating subagents from the main session. */
  readonly toolCallScopeId?: string;
  /** Current subagent ID. Undefined for the main session. */
  readonly agentId?: string;
  readonly promptId?: string;
  readonly requestId?: string;
  /** 本次模型请求执行前捕获的 MCP 身份，按调用 ID 关联，不进入模型块。 */
  readonly mcpToolIdentities?: ReadonlyMap<string, McpInfo>;
  readonly isWorkflowAgent?: boolean;
  readonly messageId?: string;
  readonly sessionId?: string;
  readonly fileHistory?: FileHistoryManager;

  /**
   * Skill-level overrides applied via contextModifier when a skill
   * is activated. Downstream consumers (e.g., agent-loop model selection)
   * should check these fields to honor skill preferences.
   */
  readonly skillOverrides?: SkillOverrides;

  // -- Parent agent lifecycle context (for subagent/fork creation) --

  /**
   * Parent agent's requestSetId, injected by ToolExecutor from the
   * AsyncLocalStorage context established by agent-loop's run() wrapper.
   * Tools that spawn subagents/forks should pass this explicitly instead
   * of reading from AsyncLocalStorage directly.
   */
  readonly parentRequestSetId?: string;

  /** Opaque SDK context inherited only by explicit child Agent invocations. */
  readonly customContext?: Readonly<Record<string, string>>;

  /**
   * Parent agent's BusinessInfo (read-only), injected by ToolExecutor.
   * Tools that spawn subagents/forks should pass this explicitly.
   */
  readonly parentBusinessInfo?: Readonly<BusinessInfo>;

  /**
   * Skill-level permission overlay applied via contextModifier when a
   * skill with `allowedTools` is activated inline. The pre-execution gate
   * merges this overlay into the permission context for the current query,
   * avoiding mutation of the global session-level permission rules.
   *
   * Lifecycle: created per-query, accumulates across inline skill
   * activations within the same query, automatically discarded when the
   * query ends and a fresh ToolUseContext is constructed.
   */
  readonly skillPermissionOverlay?: SkillPermissionOverlay;

  /** Display name of the model that initiated this tool call. */
  readonly modelDisplayName?: string;

  /** Model key (ASCII-safe fallback for header/env injection). */
  readonly modelKey?: string;
  /** 本次请求已选模型，供工具复用能力与限额。 */
  readonly modelEntry?: Model;

  /** Internal owner for nested tool executions that must not notify the main session. */
  readonly internalExecutionOwner?: InternalExecutionOwner;

  /**
   * Hook output queue reference, injected from attachmentCtx.
   * Tool hooks push additionalContext here instead of inlining into llmContent,
   * so it flows through the unified attachment → <system-reminder> pipeline.
   */
  readonly pendingHookOutputs?: Array<
    import('../hooks/types.js').PendingHookOutput
  >;

  /**
   * Prebuilt hook attachment queue, injected from attachmentCtx.
   * Hook call sites push structured attachments here; drained each turn by
   * drainHookOutputAttachments() and normalized by attachment type.
   */
  readonly pendingHookAttachments?: Array<
    import('../attachments/types.js').HookAttachment
  >;
}

/**
 * Permission overlay carried by ToolUseContext to grant tool access
 * for inline skill `allowedTools` without mutating global state.
 */
export interface SkillPermissionOverlay {
  readonly allowedToolPatterns: readonly string[];
}

/**
 * Overrides that a skill can apply to the execution context.
 * Set via contextModifier in ActivateSkillTool.
 */
export interface SkillOverrides {
  /** Override the model used for subsequent inference turns. */
  readonly model?: string;
  /** Override the reasoning effort level (e.g., 'low', 'medium', 'high'). */
  readonly effort?: string;
}
