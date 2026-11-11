/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModelStreamMessage,
  ModelStreamUserContent,
  ModelToolChoice,
} from '../provider/modelStreamRequest.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type {
  ModelPurpose,
  RequestModelOverride,
} from '../provider/model/modelSelectContext.js';
import type { ModelPolicyLabels } from './model-policy.js';
import type { FileStateCache } from '../utils/fileStateCache.js';
import type { SessionStateStore } from '../services/session-state-store.js';
import type { SystemPrompt } from '../prompts/types.js';
import type { TurnPromptResolver } from '../prompts/turn-prompt-resolver.js';
import type { ModelPromptPatches } from '../qoder/infer/model-prompt-patches.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { CompressionPipeline } from '../compression-v2/pipeline.js';
import type { HookCoordinatorAdapter } from './hook-coordinator-types.js';
import type { AttachmentToolUseContext } from '../attachments/types.js';
import type { SessionContextInput } from '../attachments/models/session-context-attachment.js';
import type { ToolExecutor } from '../tool-executor/index.js';
import type { Message } from '../protocol/transcript/message.js';
import type { CacheSafeQuerySnapshot } from './cache-safe-query-snapshot.js';
import type { QueryBusinessContext } from './query-business-context.js';
import type { TaskTrigger } from './task-trigger.js';
import type { TurnHookModuleFactory } from './turn-hooks.js';

import type { BusinessInfo } from '../qoder/business-info.js';
import type {
  ModelRequestCompletedSnapshot,
  ModelRequestFinishedSnapshot,
  ModelRequestObserver,
} from '../model-request/types.js';
import type { QueryEventRuntime } from '../event-bus/runtime.js';

/** Default maximum number of tool-loop turns before forced termination. */
export const DEFAULT_MAX_TURNS = 1000;

export interface QueryParams {
  /** 本次 query 的模型与配置要求；最终选择由 selector 决定，不修改会话默认值。 */
  querySelection?: RequestModelOverride;
  /** 父请求的选择；由 selector 按业务场景决定继承或原样复用。 */
  parentSelection?: ModelSelection;
  /**
   * 仅压缩摘要复用提前完成的选择；必须配合 modelPurpose: compact。
   * 归因由 policyLabels 独立传入。
   */
  compactSelection?: ModelSelection;
  /** 外部装配的会话级工厂，每次 query 执行时创建独立 hook 模块。 */
  turnHookFactories?: readonly TurnHookModuleFactory[];
  /** User prompt text or content blocks (may include inline images) */
  prompt: ModelStreamUserContent;
  /** Root session identity supplied by the host, including for subagents. */
  sessionId: string;
  /** Runtime-only source session attached to this query's main model requests. */
  sourceSessionId?: string;
  /** Opaque SDK context scoped to this query and all of its model rounds. */
  customContext?: Record<string, string>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Fixed system prompt for subagents, forks, and utility callers. */
  systemPrompt?: SystemPrompt;
  /** Main-agent prompt resolver, invoked only after model routing completes. */
  resolveSystemPrompt?: TurnPromptResolver;
  /** Server-routed prompt patches. Applied only to main Agent requests. */
  modelRequestPatches?: ModelPromptPatches;
  /** SDK-supplied headers for this input's first main-model request and its retries; never inherited by subagents. */
  extraHeaders?: Record<string, string>;
  /**
   * Unified runtime message array.
   *
   * Prior conversation history for this invocation.
   *
   * query() reads this array as the starting runtime state but does not mutate
   * it. Durable user / assistant / tool_result messages are yielded directly so
   * the caller can decide how to store them.
   */
  messages?: Message[];
  /** Attachments generated for this input and projected after its user message. */
  initialInputAttachments?: ReadonlyArray<
    Extract<Message, { type: 'attachment' }>
  >;
  /** Whether the host accepted this attachment into its runtime history.
   * Used when a consumer throws after accepting a message but before resuming
   * the generator (for example, a transcript write failure).
   */
  isAttachmentCommitted?: (
    message: Extract<Message, { type: 'attachment' }>,
  ) => boolean;
  /**
   * Continue from existing history without injecting a fresh user message.
   *
   * Used when the caller has already reconstructed a durable user/assistant
   * turn locally and wants to continue the loop from that state.
   */
  skipInitialUserMessage?: boolean;
  /**
   * Skip the before-agent hook (HookCoordinator.fireBefore) for
   * continuation flows that are resuming an in-flight turn rather than
   * handling a brand-new prompt. This is the BeforeAgent hook, NOT the
   * PreToolUse tool-level hook.
   */
  skipBeforeHook?: boolean;
  /** Prompt ID for tracing */
  promptId: string;
  /** Root request-set ID allocated by the query entry layer. */
  preallocatedRequestSetId?: string;
  /** Monotonic performance.now() at user-message submission; absent for continuations. */
  userMessageSubmittedAtMs?: number;
  /** SDK metadata, passed intact to the first request. */
  extra?: Record<string, unknown>;
  /**
   * Receives minimal business attribution once the main Agent lifecycle exists.
   * Must stay synchronous and non-throwing; the loop catches consumer failures.
   */
  onBusinessContextReady?: (context: QueryBusinessContext) => void;
  /** Source identifier for request routing and diagnostics. */
  querySource?: string;
  /** 业务用途；SDK 分类由选模适配层转换。 */
  modelPurpose?: ModelPurpose;
  /** Explicit business source of this Task; never inferred from message plumbing. */
  taskTrigger?: TaskTrigger;
  /** Receives successful model-request stats before query-level aggregation. */
  onModelRequestCompleted?: (completion: ModelRequestCompletedSnapshot) => void;
  /** Receives success/failure and retry metadata for every logical model request. */
  onModelRequestFinished?: (result: ModelRequestFinishedSnapshot) => void;
  /** Passive observation of request attempts and recovery waits. */
  onModelRequestObservation?: ModelRequestObserver;
  /** Current permission mode stamped onto runtime user messages. */
  permissionMode?: string;
  /** Optional metadata for the durable user message created for this prompt. */
  userMessage?: {
    uuid?: string;
    timestamp?: string;
    requestSetId?: string;
    /** The prompt is a task a parent agent delegated, not the user's words. */
    isDelegatedTask?: boolean;
  };
  /** Marks a synthetic prompt injected by the system (e.g. a slash command), not real user input. */
  isMeta?: boolean;

  /** When true, the initial state starts with stopHookActive=true (asyncRewake rewake turn). */
  stopHookActive?: boolean;

  // -- Tool execution --

  /**
   * Agent-level schema surface for this query. Callers that can execute tools
   * must pass it; there is no implicit fallback to the session registry.
   */
  toolRegistry?: ToolRegistry;
  /** Session-level tool executor owned by the caller; no implicit fallback. */
  toolExecutor?: ToolExecutor;
  /** Schema-only fork: advertise tools but reject execution. */
  executionDisabled?: boolean;
  /** Agent whose registry, snapshots and callbacks tool execution uses. */
  agentContext?: AgentLoopContext;

  /**
   * Maximum number of tool-loop turns before forced termination.
   * Each turn = one model request + tool execution cycle.
   * undefined = no turn limit (used by subagents).
   * Top-level callers should explicitly pass {@link DEFAULT_MAX_TURNS}.
   */
  maxTurns?: number;
  /** Optional host task deadline (epoch ms), bounding interruption cleanup. */
  toolSettlementDeadlineMs?: number;

  /**
   * Query-scoped tool allowlist (e.g. from slash/plugin command
   * `allowed-tools` frontmatter). Seeds
   * `ToolUseContext.skillPermissionOverlay.allowedToolPatterns` for the
   * current query only.
   */
  allowedTools?: string[];

  /**
   * Tool choice constraint forwarded to the provider.
   *
   * Controls whether the model is allowed to emit tool_use blocks:
   * - `'none'`  — model MUST NOT emit tool_use blocks (used by /btw side questions)
   * - `'auto'`  — model decides (default when omitted)
   * - `{ type: 'function', function: { name: string } }` — force a specific tool
   *
   * When set to `'none'`, tool schemas are still sent in the request for prompt
   * cache alignment, but the model is structurally prevented from calling any tools.
   */
  toolChoice?: ModelToolChoice;

  /**
   * Session-scoped exact repeated-tool-call allowlist.
   * This set persists across prompts when the user chooses
   * "always continue this exact call"; repetition counts remain query-local.
   */
  repeatedToolCallAllowedKeys?: Set<string>;

  /**
   * Pre-projected API messages used as conversation history prefix.
   *
   * When provided, these replace the `normalizeMessagesForAPI(messages)` projection
   * — 消息已经是标准 ModelStreamMessage，无需旧格式中间投影。
   *
   * Used by `runForkedAgent()` where the fork history is already in API
   * 格式，无需重复进行运行时历史投影。
   */
  preProjectedMessages?: readonly ModelStreamMessage[];

  /**
   * Attachment context for request preparation and inter-turn injection.
   *
   * When provided, query() calls getAttachmentMessages(null, attachmentCtx, ...)
   * after each tool-execution round to inject context that changed during the
   * turn (changed files, hook outputs, post-compact restore, etc.).
   * Environment announcements are also checked before every request and after
   * compaction so direct subagent/resume entries cannot miss their baseline.
   *
   * The context is also used by the orchestration layer (local TUI session
   * owner / QueryEngine) to append first-turn AttachmentMessage entries
   * directly to messages[] before calling query(). normalizeMessagesForAPI() expands
   * those entries into provider-ready user messages via the attachment case in
   * filterAndConvert().
   */
  attachmentCtx?: AttachmentToolUseContext;

  /** Skip new Git collection; an inherited session_context remains authoritative. */
  omitGitStatus?: boolean;
  /** Resolve current non-Git context after compaction, before each model request. */
  resolveSessionContext?: () =>
    | SessionContextInput
    | Promise<SessionContextInput>;
  fileReadState?: FileStateCache;
  /**
   * Request-scoped Edit/Write prompt behavior. Ordinary tool-bearing sessions
   * omit the working-directory read-first line. Minimal control sessions have
   * no tools; explicit false remains available to build their strict schema.
   */
  preReadLineDropped?: boolean;
  /**
   * Concrete registry whose Agent tool is visible in this query. Fresh
   * subagents pass their isolated registry so inter-turn listings do not fall
   * back to the root session's tool surface.
   */
  attachmentToolRegistry?: ToolRegistry;

  // -- Optional collaborators --
  // All three are optional. When omitted, the caller (e.g. QueryEngine)
  // is responsible for running these steps before calling query().

  /**
   * Hook coordinator for before/after agent lifecycle hooks.
   * When provided, query() fires before-hook before the first turn
   * and after-hook after the loop completes.
   */
  hookCoordinator?: HookCoordinatorAdapter;

  /** Correlation for a real Workflow agent attempt. */
  isWorkflowAgent?: boolean;

  /** Prompt slash-command invocation that dispatched this task. */
  commandInvocationId?: string;

  /**
   * Context compression pipeline.
   * When provided, query() runs the multi-stage compression pipeline
   * (tool-result-budget → auto-compact) before the
   * first model request.
   */
  compressionPipeline?: CompressionPipeline;

  /** Private response usage for resumed/redacted transcripts. */
  sessionStateStore?: SessionStateStore;

  /**
   * Post-compact hook — fired after compressionPipeline produces a newHistory.
   *
   * Receives `(priorHistory, newHistory)` — the history before compression
   * (pre-boundary) and after (summary + optional pending tool_use tail).
   * Must return the final history to use for the current turn, which may
   * extend `newHistory` with post-compact recovery attachments (file
   * restoration, plan, invoked skills, delta re-announcements). Returning
   * the input unchanged disables post-compact recovery.
   *
   * Mirrors the `compactConversation()` post-summary attachment append.
   */
  onCompressionCompleted?: (
    priorHistory: readonly Message[],
    newHistory: readonly Message[],
  ) => Promise<readonly Message[]>;

  /**
   * Receives the request snapshot before streaming tools can run, then the
   * completed snapshot with assistant messages and usage after sampling.
   */
  onCacheSafeSnapshot?: (snapshot: CacheSafeQuerySnapshot) => void;

  /** Session Config providing the ModelProviderManager and request services. */
  config?: import('../config/config.js').Config;

  /** 已解析的请求归因，独立于父选择沿用到推理。 */
  policyLabels?: ModelPolicyLabels;

  /** Whether this query is being executed by a subagent. */
  isSubagent?: boolean;

  /** Main business allocated before title generation and input hooks. */
  businessInfo?: Readonly<BusinessInfo>;

  /**
   * Subagent identifier for queue scoping. When `isSubagent` is true,
   * the agent-loop's mid-turn drain only consumes task-notifications
   * whose `targetAgentId === agentId`, enforcing main-thread vs subagent
   * queue isolation.
   */
  agentId?: string;

  /** Stable subagent type forwarded to request-scoped model policy callbacks. */
  agentType?: string;

  /**
   * Mark the penultimate message for prompt caching instead of the final
   * message. Forked/fire-and-forget requests use this to reuse the parent's
   * cached prefix without writing their one-off prompt into the cache.
   */
  skipCacheWrite?: boolean;

  /**
   * Parent agent's requestSetId for subagent request grouping.
   * Passed explicitly because AsyncLocalStorage may break across tool bridges.
   */
  parentRequestSetId?: string;

  /**
   * Parent agent's BusinessInfo for subagent inheritance (read-only).
   * Only used when isSubagent is true.
   */
  parentBusinessInfo?: Readonly<BusinessInfo>;

  /**
   * Workspace directories for Codebase C4 header injection.
   *
   * When provided, `Cosy-Codebase-*` headers are merged across all directories
   * so that a C4-tagged repo added via `/add-dir` is enforced server-side.
   *
   * Falls back to `config?.getWorkspaceContext().getDirectories()` when omitted.
   * Forked agents should pass this explicitly since they typically lack `config`.
   */
  workdirs?: readonly string[];

  /**
   * Memoized startup memory context (AGENTS.md tiers + date).
   * Injected as an ephemeral first user message per API request via
   * prependUserContext pattern — not stored in conversation history.
   */
  startupMemoryContext?: Record<string, string>;

  /** Client-side request id preallocated for the first model request. */
  initialModelRequestId?: string;

  /**
   * Session event bus and query state store. Session hosts create one and pass
   * it to every query; omitted callers get a private one per invocation.
   */
  eventBus?: QueryEventRuntime;
  /** Query that spawned this one, for attribution only. */
  parentQueryId?: string;
}
