/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { AgentsMdSizeSnapshot } from './agentsMdSize.js';
import type { McpClient } from '../mcp/client/index.js';
import type { EditorType } from './editor.js';

import type { PermissionMode } from '../permissions/manager/decision/index.js';
import type { ReasoningEffortLevel } from '../config/model-values.js';
import { runLogger } from './runLogger.js';
import {
  emitFeedbackEvent,
  emitConsoleCaptured,
  emitStdioOutput,
  emitModelRetryScheduled,
  emitCompressionProgress,
} from './diagnosticInterceptors.js';

/**
 * Defines the severity level for user-facing feedback.
 * This maps loosely to UI `MessageType`
 */
export type FeedbackSeverity = 'info' | 'warning' | 'error';

/**
 * 会话级事件 payload 的公共基类。
 *
 * `sessionId` 必填，不是可选。理由：`coreEvents` 是进程级单例总线，daemon 里
 * 每个存活会话都会收到所有会话发出的同名事件，payload 上的 `sessionId` 是唯一的
 * 归属事实。若设为可选，未来某个新发射点漏传时编译不报错，会静默把跨会话泄漏放回来。
 * 必填让漏传变成 tsc 错误，落在最显眼的位置。
 *
 * 一个事件是不是会话级，判据就是它的 payload 有没有 extends 这个接口——
 * 「有没有 sessionId 字段」本身就是分级定义（见 CoreEvent 枚举旁的分级注释）。
 */
export interface SessionScopedPayload {
  readonly sessionId: string;
}

/**
 * Payload for the 'user-feedback' event.
 */
export interface UserFeedbackPayload {
  /**
   * The severity level determines how the message is rendered in the UI
   * (e.g. colored text, specific icon).
   */
  severity: FeedbackSeverity;
  /**
   * The main message to display to the user in the chat history or stdout.
   */
  message: string;
  /**
   * The original error object, if applicable.
   * Listeners can use this to extract stack traces for debug logging
   * or verbose output, while keeping the 'message' field clean for end users.
   */
  error?: unknown;
  /**
   * Keeps a user-facing notification out of the resumable conversation
   * transcript. The notification remains visible in the current UI.
   */
  omitFromTranscript?: boolean;
}

export interface FeedbackDisplayOptions {
  /**
   * Keeps a user-facing notification out of the resumable conversation
   * transcript. The notification remains visible in the current UI.
   */
  omitFromTranscript?: boolean;
}

/** Outcome of one organization plugin sync round. */
export interface EnterpriseSyncResult {
  /** True when another process already held the lock; nothing was attempted. */
  skipped?: boolean;
  /** Error that failed the whole round. */
  error?: unknown;
  /** Plugin names by outcome. */
  installed?: string[];
  updated?: string[];
  unchanged?: string[];
  removed?: string[];
  failed?: string[];
  /** Per-plugin failures, for the plugin error display. */
  failures?: ManagedPluginSyncFailure[];
}

/** One plugin that failed to install or update in a sync round. */
export interface ManagedPluginSyncFailure {
  pluginName: string;
  displayName: string;
  userVisible: boolean;
  targetVersion?: string;
  reason: string;
  /** Registered version retained after the failed sync, if one exists. */
  previousVersion?: string;
  /** Used to tell whether the retained version is active now. */
  previousInstallPath?: string;
}

export interface ManagedPluginSyncCompletePayload {
  organizationId: string;
  result: EnterpriseSyncResult;
}

/**
 * Payload for the 'model-changed' event.
 *
 * 会话级：每会话 Config 发出，sessionId 必填，消费者走 onSessionEvent 过滤。
 */
export interface ModelChangedPayload extends SessionScopedPayload {
  /**
   * The new model that was set.
   */
  model: string;
}

/**
 * Payload for the 'reasoning-effort-changed' event.
 *
 * 会话级：每会话 Config 发出。
 */
export interface ReasoningEffortChangedPayload extends SessionScopedPayload {
  model: string;
  reasoningEffort?: ReasoningEffortLevel;
}

/**
 * Payload for the 'context-window-changed' event.
 *
 * 会话级：每会话 Config 发出。
 */
export interface ContextWindowChangedPayload extends SessionScopedPayload {
  model: string;
  contextWindow?: number;
}

/**
 * Payload for the 'permission-mode-changed' event.
 *
 * 会话级：每会话 Config / remote controller 自身会话发出。
 */
export interface PermissionModeChangedPayload extends SessionScopedPayload {
  mode: PermissionMode;
  previousMode: PermissionMode;
}

/**
 * Payload for plan state (enter/exit) events.
 *
 * 会话级：plan 状态是每会话的（Config.planStateManager），但事件走进程单例总线，
 * 因此必须打戳，消费者按戳过滤，否则 A 会话进出 plan 会污染 B 会话。
 */
export interface PlanStateChangedPayload extends SessionScopedPayload {
  active: boolean;
}

/**
 * Payload for the 'trust-changed' event.
 *
 * 会话级（§5.4 产品判断结论）：信任状态存放在每会话 Config 上，从 Config 发出，
 * 且主要消费者 agentRegistry 是每会话 Config 成员——daemon 里两个会话可以有不同
 * cwd/信任态，A 会话的信任变更不应静默触发 B 会话的 agent 重校验。故按会话归属，
 * 由原来的裸 boolean 升级为带 sessionId 的对象 payload。
 */
export interface TrustChangedPayload extends SessionScopedPayload {
  isTrusted: boolean;
}

/**
 * Payload for the 'console-log' event.
 */
export interface ConsoleLogPayload {
  type: 'log' | 'warn' | 'error' | 'debug' | 'info';
  content: string;
}

/**
 * Payload for the 'output' event.
 */
export interface OutputPayload {
  isStderr: boolean;
  chunk: Uint8Array | string;
  encoding?: BufferEncoding;
}

/**
 * Payload for the 'memory-changed' event.
 *
 * 会话级：从每会话 MemoryContextManager / memoryDiscovery（持 config）发出。
 */
export interface MemoryChangedPayload extends SessionScopedPayload {
  fileCount: number;
  largeFiles?: Array<{ path: string; characterCount: number }>;
  failedFiles?: Array<{ path: string; error: string }>;
}

/**
 * Base payload for hook-related events.
 *
 * sessionId 必填：HookStart/HookEnd/HookSystemMessage 都从每会话 HookEventHandler
 * 发出，sessionId = this.context.config.getSessionId()（经 createCoreBaseInput 落到
 * input.session_id）。必填使 HookStart/HookEnd 被 SessionScopedEventName 纳入，
 * 消费者可用 onSessionEvent 过滤。
 */
export interface HookPayload {
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  hookName: string;
  eventName: string;
}

/**
 * Fields shared by the 'hook-start' and 'hook-end' events. Only user-visible
 * hooks (see `isUserVisibleHook`) produce these events, and `hookIndex` counts
 * within that visible subset.
 */
interface HookLifecyclePayload extends HookPayload {
  /** Shared by every hook of one execution batch; the UI groups on it. */
  batchId: string;
  /** Set when the batch runs in a subagent context; undefined on the main thread. */
  agentId?: string;
  /** The 1-based index of the hook among the batch's user-visible hooks. */
  hookIndex: number;
}

/**
 * Payload for the 'hook-start' event.
 */
export interface HookStartPayload extends HookLifecyclePayload {
  /**
   * The source of the hook configuration.
   */
  source?: string;
  /**
   * The number of user-visible hooks in the batch.
   */
  totalHooks: number;
  /**
   * Custom status message from hook config, displayed as spinner text
   * while the hook is executing.
   */
  statusMessage?: string;
  /**
   * Human-readable display text for the hook (command, url, prompt, etc.).
   * Used by UI when statusMessage is not set.
   */
  displayText?: string;
  /**
   * Plugin identifier (e.g. "name@source") when the hook originated from a
   * plugin. Absent for non-plugin sources.
   */
  pluginId?: string;
  /**
   * Plugin install directory when the hook originated from a plugin. Absent
   * for non-plugin sources.
   */
  pluginRoot?: string;
  /**
   * The payload handed to the hook (its stdin JSON), for diagnostics.
   */
  hookInput?: unknown;
}

/**
 * Payload for the 'hook-end' event.
 */
export interface HookEndPayload extends HookLifecyclePayload {
  /** The parent batch was aborted; its running UI should disappear immediately. */
  cancelled?: boolean;
  /**
   * The source of the hook configuration.
   */
  source?: string;
  success: boolean;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  /**
   * Plugin identifier when the hook originated from a plugin or built-in
   * resource with plugin-style attribution.
   */
  pluginId?: string;
  /**
   * Plugin/resource directory when the hook originated from a plugin or
   * built-in resource with plugin-style attribution.
   */
  pluginRoot?: string;
  /**
   * The hook's outcome: parsed verdict (decision/permissionDecision), the
   * structured output, and truncated stdout, for diagnostics.
   */
  hookOutput?: unknown;
}

/**
 * Payload for the 'hook-system-message' event.
 */
export interface HookSystemMessagePayload extends HookPayload {
  message: string;
}

/**
 * Payload for the 'retry-attempt' event.
 *
 * 会话级：发射方作用域内已有非空 sessionId。
 */
export interface RetryAttemptPayload extends SessionScopedPayload {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error?: string;
  model: string;
}

/**
 * Compression trigger — how the compaction was initiated.
 */
export type CompressionTrigger = 'auto' | 'manual' | 'reactive';

/**
 * Stage of the compaction process emitted as progress events.
 *
 * - `starting`        : threshold exceeded, about to invoke the summary LLM
 * - `summarizing`     : fork subagent is running (LLM path only)
 * - `post_processing` : summary produced, building post-compact history
 * - `done`            : new history committed, UI can update token counts
 * - `failed`          : compaction failed (empty summary, token inflation, etc.)
 */
export type CompressionProgressStage =
  | 'starting'
  | 'summarizing'
  | 'post_processing'
  | 'done'
  | 'failed';

/**
 * Payload for the 'compression-progress' event.
 *
 * 会话级：sessionId 继承自 SessionScopedPayload，取 rootSessionId（真实会话）。
 */
export interface CompressionProgressPayload extends SessionScopedPayload {
  stage: CompressionProgressStage;
  trigger: CompressionTrigger;
  /**
   * 压缩作用域 id：主 agent 时等于 sessionId，子 agent 时是子 agent 的 promptId。
   * 会话归属/过滤请用继承来的 sessionId（= rootSessionId），不要用 sessionScopeId。
   */
  sessionScopeId: string;
  /** Compression owner. TUI consumers use this to avoid surfacing subagent work. */
  target: 'main' | 'subagent';
  /** Present for subagent-owned compression. */
  agentId?: string;
  /** Token count before compaction — populated from `starting` onwards. */
  tokensBeforeCompact?: number;
  /** Token count after compaction — populated at `done`. */
  tokensAfterCompact?: number;
  /** Human-readable reason for failure — populated at `failed`. */
  failureReason?: string;
  providerStatus?: number;
  providerSource?: string;
  /** Dynamic error-code key for model-request failures. */
  displayErrorCode?: string | number;
  /** Safe user-facing fallback for the dynamic error code. */
  errorFallbackMessage?: string;
}

/** Usage for one compression fork, including failed attempts and retries. */
export interface CompressionUsagePayload extends SessionScopedPayload {
  usage: NonNullableUsage;
  modelRequestIds: string[];
  agentId?: string;
}

/**
 * Payload for the 'consent-request' event.
 */
export interface ConsentRequestPayload {
  modelPaid?: { sessionId: string; model: string };
  prompt: string;
  signal?: AbortSignal;
  onConfirm: (confirmed: boolean) => void;
}

/**
 * Payload for the 'mcp-progress' event.
 *
 * A shared connection uses the progress token to recover the originating sessionId and callId.
 */
export interface McpProgressPayload extends SessionScopedPayload {
  serverName: string;
  callId: string;
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

export interface SlashCommandConflict {
  name: string;
  renamedTo: string;
  loserPluginName?: string;
  winnerPluginName?: string;
  loserMcpServerName?: string;
  winnerMcpServerName?: string;
  loserKind?: string;
  winnerKind?: string;
}

export interface SlashCommandConflictsPayload {
  conflicts: SlashCommandConflict[];
}

/**
 * Payload for the 'quota-changed' event.
 */
export interface QuotaChangedPayload {
  remaining: number | undefined;
  limit: number | undefined;
  resetTime?: string;
}

/**
 * Payload for the 'goal-updated' event.
 *
 * 会话级：GoalManager 构造时即持有 sessionId（getOrCreateGoalManager(sessionId)）。
 * 注意 §5.3：getOrCreateGoalManager() 是单槽单例，不同 sessionId 会互相驱逐——
 * 那是状态层缺陷，打戳修不了它，本方案不解决，仅在此交叉引用。
 */
export interface GoalUpdatedPayload extends SessionScopedPayload {
  goal: {
    id: string;
    objective: string;
    status: string;
    turnsUsed: number;
    maxTurns?: number;
    timeUsedSeconds: number;
  };
  /**
   * Why the update happened: 'safety-limit' marks the hard-turn-limit
   * auto-pause; 'blocked' marks the agent-reported impasse halt.
   */
  reason?: 'safety-limit' | 'blocked';
}

/**
 * Payload for the 'goal-cleared' event.
 *
 * 会话级：同 GoalUpdatedPayload（含 §5.3 单槽单例交叉引用）。
 */
export interface GoalClearedPayload extends SessionScopedPayload {
  goalId: string;
  timestamp: number;
  /** Why the goal was cleared. 'completed' means the agent finished the goal naturally. */
  reason?: 'completed' | 'user';
}

/**
 * Payload for the 'agents-md-size-evaluated' event.
 *
 * 会话级：从每会话 MemoryContextManager 发出，发射点已打 sessionId。
 */
export interface AgentsMdSizeEvaluatedPayload extends SessionScopedPayload {
  snapshot: AgentsMdSizeSnapshot;
  /** Internal context refreshes still measure/report, but do not notify users. */
  notifyWarning?: boolean;
}

/**
 * Payload for the 'agents-refreshed' event.
 *
 * 会话级：agentRegistry 是每会话 Config 成员，刷新只关乎本会话的 agent 目录。
 */
export type AgentsRefreshedPayload = SessionScopedPayload;

/**
 * Payload for the 'mcp-client-update' event.
 *
 * 会话级：SessionMcpManager 持每会话 cliConfig。原来直接发裸 Map，现包成对象
 * 以携带 sessionId；消费者读 .clients。
 */
export interface McpClientUpdatePayload extends SessionScopedPayload {
  clients: Map<string, McpClient>;
}

/**
 * 事件分级（权威表，按发射者归属判定，不是按名字猜）。
 *
 * - 会话级：发射者隶属于某个会话（Config 及其成员、每会话的 hook/compression/mcp
 *   上下文）。payload 必须 extends SessionScopedPayload 携带必填 sessionId，
 *   消费者一律走 onSessionEvent 过滤。判据落在类型上：payload 有没有 sessionId 字段。
 * - 进程级：发射者是进程单例（stdout patch、进程级 settingsCache、账号级配额、
 *   单实例编辑器/ oauth 流程等）。payload 刻意不带 sessionId——这样「全局广播还是会话级」
 *   在类型上可读，不需要查文档。
 *
 * 改造是分阶段推进的：标「会话级」的事件其 payload 会在对应阶段陆续 extends
 * SessionScopedPayload；在那之前它虽归类为会话级但尚未打戳。新增事件时按发射者归属
 * 在此表标一行，并让会话级 payload extends SessionScopedPayload。
 */
export enum CoreEvent {
  UserFeedback = 'user-feedback', // 进程级：用户级反馈，无单一会话归属
  ModelChanged = 'model-changed', // 会话级：每会话 Config 发出
  ModelInfoChanged = 'model-info-changed', // 进程级：发射者是 ModelProviderManager 的模型快照（内容变化时发出），每会话 agentRegistry 都需响应；按单会话打戳会错误过滤其他会话（有据偏差于 §1.1 表，见最终报告）
  ReasoningEffortChanged = 'reasoning-effort-changed', // 会话级：每会话 Config
  ContextWindowChanged = 'context-window-changed', // 会话级：每会话 Config
  PermissionModeChanged = 'permission-mode-changed', // 会话级：每会话 Config / remote controller 自身会话
  PlanStateChanged = 'plan-state-changed', // 会话级：plan 状态是每会话的（Config.planStateManager）
  ConsoleLog = 'console-log', // 进程级：patch 的进程 console
  Output = 'output', // 进程级：patch 的进程 stdout/stderr（daemon 下即 NDJSON 协议通道，挂消费者前慎之又慎，见 §5.6）
  MemoryChanged = 'memory-changed', // 会话级：MemoryContextManager 属会话 Config
  AgentsMdSizeEvaluated = 'agents-md-size-evaluated', // 会话级：payload 已含 sessionId
  ExternalEditorOpening = 'external-editor-opening', // 进程级：一次只有一个编辑器
  ExternalEditorClosed = 'external-editor-closed', // 进程级：同上
  McpClientUpdate = 'mcp-client-update', // 会话级：SessionMcpManager 持 cliConfig
  OauthDisplayMessage = 'oauth-display-message', // 进程级：账号级 oauth 流程
  SettingsChanged = 'settings-changed', // 进程级：进程级 settingsCache
  HookDiagnosticsChanged = 'hook-diagnostics-changed', // 会话级：已有 Hook 配置诊断更新
  HookStart = 'hook-start', // 会话级：HookEventHandler 每会话对象
  HookEnd = 'hook-end', // 会话级：同上
  HookSystemMessage = 'hook-system-message', // 会话级：同上（当前无活跃发射点，见 §3 阶段 3）
  AgentsRefreshed = 'agents-refreshed', // 会话级：agentRegistry 属会话 Config
  AdminSettingsChanged = 'admin-settings-changed', // 进程级：进程级 settingsCache
  RetryAttempt = 'retry-attempt', // 会话级：发射方作用域内有 sessionId
  ConsentRequest = 'consent-request', // 进程级：单次用户同意流程
  McpProgress = 'mcp-progress', // Match progress by sessionId and callId.
  RequestEditorSelection = 'request-editor-selection', // 进程级：单实例编辑器选择
  EditorSelected = 'editor-selected', // 进程级：同上
  SlashCommandConflicts = 'slash-command-conflicts', // 进程级（develop）：发射者 CommandService 是全静态类、无会话身份；穿 sessionId 需改静态 create() 签名 + 全部调用方（含 catalog-rebuild 性能敏感路径），ROI 为负。thread-manager 引入每会话 CommandService 后再打戳（有据偏差于 §1.1 表，见最终报告）
  QuotaChanged = 'quota-changed', // 进程级：账号级配额
  TurnComplete = 'turn-complete', // 会话级：payload 携带发射会话正文（样板，已打戳）
  TrustChanged = 'trust-changed', // 会话级：从 Config 发出（归属是产品判断，见 §5.4）
  CompressionProgress = 'compression-progress', // 会话级：compression-v2 作用域内有 rootSessionId
  CompressionUsage = 'compression-usage', // 会话级：失败压缩的累计用量
  GoalUpdated = 'goal-updated', // 会话级：GoalManager 已有 sessionId（注意 §5.3 单槽单例缺陷）
  GoalCleared = 'goal-cleared', // 会话级：同上
  DynamicCommandsChanged = 'dynamic-commands-changed', // 进程级：动态命令配置变化，对所有会话一致。
  ManagedPluginSyncComplete = 'managed-plugin-sync-complete', // 进程级：组织级插件同步
  AutoDreamStatus = 'auto-dream-status', // 进程级：跨会话的 memory dream 任务
  SessionTitleChanged = 'session-title-changed', // 会话级：TopicState 属会话（需注入 sessionId）
}

/**
 * Payload for the 'session-title-changed' event.
 *
 * Carries the title rather than leaving subscribers to read it back, so a
 * listener needs no reference to the `Config` that owns the topic state.
 *
 * 会话级：TopicState 属每会话 Config，sessionId 由 Config 注入 TopicState 后打上。
 */
export interface SessionTitleChangedPayload extends SessionScopedPayload {
  title: string;
}

/**
 * Payload for the 'editor-selected' event.
 */
export interface EditorSelectedPayload {
  editor?: EditorType;
}

/**
 * Payload for the 'external-editor-opening' / 'external-editor-closed' events.
 *
 * A terminal editor takes over the terminal and needs a full handoff (alternate
 * screen, suspended stdin). A GUI editor opens its own window, so the terminal
 * only needs stdin suspended — clearing the screen for it just makes the UI
 * blink.
 */
export interface ExternalEditorPayload {
  isTerminal: boolean;
}

/**
 * Payload for the 'turn-complete' event.
 *
 * 会话级事件：payload 携带发射会话的对话正文（prompt + 模型回复），多会话下
 * 跨会话投递即内容泄漏，因此 `sessionId` 必填，消费者一律走 `onSessionEvent` 过滤。
 * 这是整套会话归属机制的样板事件。
 */
export interface TurnCompletePayload extends SessionScopedPayload {
  prompt: string;
  promptResponse: string;
  /** Client-side model request id for the completed parent assistant turn. */
  requestId?: string;
  /** Parent agent's requestSetId — explicitly threaded for subagent lifecycle inheritance. */
  parentRequestSetId?: string;
  /** Parent agent's BusinessInfo — explicitly threaded for subagent lifecycle inheritance. */
  parentBusinessInfo?: Readonly<
    import('../qoder/business-info.js').BusinessInfo
  >;
  customContext?: Readonly<Record<string, string>>;
}

export type AutoDreamStatusStage = 'started' | 'completed' | 'failed';

export interface AutoDreamStatusPayload {
  stage: AutoDreamStatusStage;
  sessionCount?: number;
  rootCount?: number;
  memoryDir?: string;
  memoryPaths?: string[];
  durationMs?: number;
  error?: string;
}

export interface CoreEvents {
  extensionsStarting: [{ total: number; completed: number }];
  extensionsStopping: [{ total: number; completed: number }];
  [CoreEvent.UserFeedback]: [UserFeedbackPayload];
  [CoreEvent.ModelChanged]: [ModelChangedPayload];
  [CoreEvent.ModelInfoChanged]: never[];
  [CoreEvent.ReasoningEffortChanged]: [ReasoningEffortChangedPayload];
  [CoreEvent.ContextWindowChanged]: [ContextWindowChangedPayload];
  [CoreEvent.PermissionModeChanged]: [PermissionModeChangedPayload];
  [CoreEvent.PlanStateChanged]: [PlanStateChangedPayload];
  [CoreEvent.ConsoleLog]: [ConsoleLogPayload];
  [CoreEvent.Output]: [OutputPayload];
  [CoreEvent.MemoryChanged]: [MemoryChangedPayload];
  [CoreEvent.AgentsMdSizeEvaluated]: [AgentsMdSizeEvaluatedPayload];
  [CoreEvent.QuotaChanged]: [QuotaChangedPayload];
  [CoreEvent.ExternalEditorOpening]: [ExternalEditorPayload];
  [CoreEvent.ExternalEditorClosed]: [ExternalEditorPayload];
  [CoreEvent.McpClientUpdate]: [McpClientUpdatePayload];
  [CoreEvent.OauthDisplayMessage]: string[];
  [CoreEvent.SettingsChanged]: never[];
  [CoreEvent.HookDiagnosticsChanged]: [SessionScopedPayload & { failed?: boolean }];
  [CoreEvent.HookStart]: [HookStartPayload];
  [CoreEvent.HookEnd]: [HookEndPayload];
  [CoreEvent.HookSystemMessage]: [HookSystemMessagePayload];
  [CoreEvent.AgentsRefreshed]: [AgentsRefreshedPayload];
  [CoreEvent.AdminSettingsChanged]: never[];
  [CoreEvent.RetryAttempt]: [RetryAttemptPayload];
  [CoreEvent.ConsentRequest]: [ConsentRequestPayload];
  [CoreEvent.McpProgress]: [McpProgressPayload];
  [CoreEvent.RequestEditorSelection]: never[];
  [CoreEvent.EditorSelected]: [EditorSelectedPayload];
  [CoreEvent.SlashCommandConflicts]: [SlashCommandConflictsPayload];
  [CoreEvent.TurnComplete]: [TurnCompletePayload];
  [CoreEvent.TrustChanged]: [TrustChangedPayload];
  [CoreEvent.CompressionProgress]: [CompressionProgressPayload];
  [CoreEvent.CompressionUsage]: [CompressionUsagePayload];
  [CoreEvent.GoalUpdated]: [GoalUpdatedPayload];
  [CoreEvent.GoalCleared]: [GoalClearedPayload];
  [CoreEvent.DynamicCommandsChanged]: never[];
  [CoreEvent.ManagedPluginSyncComplete]: [
    ManagedPluginSyncCompletePayload,
  ];
  [CoreEvent.AutoDreamStatus]: [AutoDreamStatusPayload];
  [CoreEvent.SessionTitleChanged]: [SessionTitleChangedPayload];
}

/**
 * 会话级事件名联合，由「payload extends SessionScopedPayload」自动推导。
 *
 * 这是不变量「有没有 sessionId 字段就是事件的分级定义」的类型强制手段：
 * `onSessionEvent` 只接受这个联合里的名字，把进程级事件传进去会编译失败。
 * 新增会话级事件时只要让它的 payload extends SessionScopedPayload，名字会自动进来；
 * 反之进程级事件刻意不带 sessionId，永远不会被误当作会话级订阅。
 */
export type SessionScopedEventName = {
  [K in keyof CoreEvents]: CoreEvents[K] extends [infer P, ...unknown[]]
    ? P extends SessionScopedPayload
      ? K
      : never
    : never;
}[keyof CoreEvents];

type EventBacklogItem = {
  [K in keyof CoreEvents]: {
    event: K;
    args: CoreEvents[K];
  };
}[keyof CoreEvents];

export class CoreEventEmitter extends EventEmitter<CoreEvents> {
  private _eventBacklog: EventBacklogItem[] = [];
  private _backlogHead = 0;
  private static readonly MAX_BACKLOG_SIZE = 10000;
  /** 单会话基线上限：沿用 Node 泄漏检测的原有语义，不动它。 */
  private static readonly BASE_MAX_LISTENERS = 15;
  /**
   * 每个存活会话在同一事件上允许的监听器余量。
   *
   * 取值依据：会话侧对同一个事件正常只挂 1 条（sessionBroadcast / sessionQueryRunner /
   * sessionTurnReview 各按事件挂一条），留 4 是给同一会话内多个订阅点与将来扩展的余量。
   * 刻意不放大到「等于不设限」：真正的泄漏（某个会话反复订阅却不退订）表现为
   * **同一个 sessionId 的计数持续上涨**，而不是会话数上涨，那条仍会撞上限并告警。
   */
  private static readonly LISTENERS_PER_SESSION = 4;
  /**
   * 每个事件上「sessionId → 该会话挂了几条」的引用计数。
   *
   * 只在 onSessionEvent 里维护——它是会话级订阅的唯一 sanctioned 入口（见其文档），
   * 所以这里看到的会话数就是真实的存活订阅会话数。裸 on() 不计入，因为裸订阅来自
   * 单会话运行时（TUI / worker / remote），那些进程里本来就该受基线上限约束。
   */
  private readonly _scopedSessionsByEvent = new Map<
    string,
    Map<string, number>
  >();

  constructor() {
    super();
    // §5.2 的落地：基线仍是 15，多会话部分按存活会话数动态抬高（见
    // refreshMaxListeners）。原注释把数值决策移交给了消费者接入方，理由是「生产者侧
    // 打戳不改变监听器计数」——成立，但计数确实会随 onSessionEvent 的会话数增长，
    // 所以抬高逻辑放在 onSessionEvent 自己维护的引用计数上，不需要生产者知道会话数。
    this.setMaxListeners(CoreEventEmitter.BASE_MAX_LISTENERS);
  }

  /**
   * 按「所有事件里最多的不同会话数」重算上限。setMaxListeners 是 emitter 级而非
   * 事件级，所以取最大值；单会话进程里这个值恒为 0 或 1，上限保持在基线附近，
   * 与改动前行为一致。
   */
  private refreshMaxListeners(): void {
    let maxSessions = 0;
    for (const bySession of this._scopedSessionsByEvent.values()) {
      if (bySession.size > maxSessions) maxSessions = bySession.size;
    }
    this.setMaxListeners(
      CoreEventEmitter.BASE_MAX_LISTENERS +
        maxSessions * CoreEventEmitter.LISTENERS_PER_SESSION,
    );
  }

  private trackScopedSubscription(
    event: string,
    sessionId: string,
    delta: 1 | -1,
  ): void {
    let bySession = this._scopedSessionsByEvent.get(event);
    if (bySession === undefined) {
      if (delta < 0) return;
      bySession = new Map<string, number>();
      this._scopedSessionsByEvent.set(event, bySession);
    }
    const next = (bySession.get(sessionId) ?? 0) + delta;
    if (next > 0) {
      bySession.set(sessionId, next);
    } else {
      bySession.delete(sessionId);
      if (bySession.size === 0) this._scopedSessionsByEvent.delete(event);
    }
    this.refreshMaxListeners();
  }

  /**
   * 订阅一个会话级事件，只收本会话的。
   *
   * 过滤只在这里实现一处：`coreEvents` 是进程级单例总线（见文件末尾导出），多会话
   * daemon 里每个存活会话都会收到所有会话的事件，payload 上的 `sessionId` 是唯一的
   * 归属事实。消费者不许自己手写 `if (payload.sessionId !== mine) return`——手写会漏、
   * 会写错，而且无法被门禁检查。返回退订函数，避免调用方自己配 on/off 对。
   *
   * 类型层只接受 `SessionScopedEventName`：把进程级事件（payload 不带 sessionId）传进来
   * 会编译失败，这是「有没有 sessionId 字段就是分级定义」的强制手段。
   */
  onSessionEvent<K extends SessionScopedEventName>(
    event: K,
    sessionId: string,
    handler: (...args: CoreEvents[K]) => void,
  ): () => void {
    const wrapped = (...args: CoreEvents[K]): void => {
      const first = args[0] as SessionScopedPayload | undefined;
      if (first !== undefined && first.sessionId === sessionId) {
        handler(...args);
      }
    };
    // EventEmitter 的 on/off 在泛型 K 上是条件类型，直接传 wrapped 不可赋值；
    // 沿用本文件 _emitOrQueue 对 this.emit 的同一套显式 cast。
    const on = this.on as (
      event: K,
      listener: (...args: CoreEvents[K]) => void,
    ) => this;
    const off = this.off as (
      event: K,
      listener: (...args: CoreEvents[K]) => void,
    ) => this;
    on.call(this, event, wrapped);
    this.trackScopedSubscription(event, sessionId, 1);
    return () => {
      off.call(this, event, wrapped);
      this.trackScopedSubscription(event, sessionId, -1);
    };
  }

  private _emitOrQueue<K extends keyof CoreEvents>(
    event: K,
    ...args: CoreEvents[K]
  ): void {
    if (this.listenerCount(event) === 0) {
      const backlogSize = this._eventBacklog.length - this._backlogHead;
      if (backlogSize >= CoreEventEmitter.MAX_BACKLOG_SIZE) {
        // Evict oldest entry. Use a head pointer instead of shift() to avoid
        // O(n) array reindexing on every eviction at capacity.
        (this._eventBacklog as unknown[])[this._backlogHead] = undefined;
        this._backlogHead++;
        // Compact once dead entries exceed half capacity to bound memory
        if (this._backlogHead >= CoreEventEmitter.MAX_BACKLOG_SIZE / 2) {
          this._eventBacklog = this._eventBacklog.slice(this._backlogHead);
          this._backlogHead = 0;
        }
      }

      this._eventBacklog.push({ event, args } as EventBacklogItem);
    } else {
      (this.emit as (event: K, ...args: CoreEvents[K]) => boolean)(
        event,
        ...args,
      );
    }
  }

  /**
   * Sends actionable feedback to the user.
   * Buffers automatically if the UI hasn't subscribed yet.
   */
  emitFeedback(
    severity: FeedbackSeverity,
    message: string,
    error?: unknown,
    options: FeedbackDisplayOptions = {},
  ): void {
    const payload: UserFeedbackPayload = {
      severity,
      message,
      error,
      ...options,
    };
    emitFeedbackEvent({ severity, message, error });
    this._emitOrQueue(CoreEvent.UserFeedback, payload);
  }

  /**
   * Broadcasts a console log message.
   */
  emitConsoleLog(
    type: 'log' | 'warn' | 'error' | 'debug' | 'info',
    content: string,
  ): void {
    const payload: ConsoleLogPayload = { type, content };
    emitConsoleCaptured(type, content);
    this._emitOrQueue(CoreEvent.ConsoleLog, payload);
  }

  /**
   * Broadcasts stdout/stderr output.
   *
   * §5.6 警告：Output 是进程级事件，来自被 patch 的进程 stdout/stderr。daemon 的
   * stdout 就是 NDJSON 协议通道——往这个事件上挂任何新消费者前，先想清楚它会把
   * 协议帧当成普通输出消费/二次输出的风险。它刻意不带 sessionId（进程级），
   * 不要试图按会话过滤它。
   */
  emitOutput(
    isStderr: boolean,
    chunk: Uint8Array | string,
    encoding?: BufferEncoding,
  ): void {
    const payload: OutputPayload = { isStderr, chunk, encoding };
    // Decode only a preview prefix to avoid allocating a large string for logging.
    const byteLength =
      typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    const preview =
      typeof chunk === 'string'
        ? chunk.slice(0, 5000)
        : Buffer.from(chunk.subarray(0, 5000)).toString(encoding ?? 'utf8');
    emitStdioOutput({
      isStderr,
      preview,
      byteLength,
      truncated: byteLength > 500,
    });
    this._emitOrQueue(CoreEvent.Output, payload);
  }

  /**
   * Notifies subscribers that the model has changed.
   * sessionId 放第一位：漏传时编译错误落在最显眼的位置。
   */
  emitModelChanged(sessionId: string, model: string): void {
    const payload: ModelChangedPayload = { sessionId, model };
    this.emit(CoreEvent.ModelChanged, payload);
  }

  /**
   * Notifies subscribers that the model catalog/options changed while the
   * selected model may have stayed the same.
   */
  emitModelInfoChanged(): void {
    this.emit(CoreEvent.ModelInfoChanged);
  }

  /**
   * Notifies subscribers that the explicit reasoning effort has changed.
   */
  emitReasoningEffortChanged(
    sessionId: string,
    reasoningEffort: ReasoningEffortLevel | undefined,
    model: string,
  ): void {
    const payload: ReasoningEffortChangedPayload = {
      sessionId,
      model,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
    this.emit(CoreEvent.ReasoningEffortChanged, payload);
  }

  /**
   * Notifies subscribers that the explicit context window has changed.
   */
  emitContextWindowChanged(
    sessionId: string,
    contextWindow: number | undefined,
    model: string,
  ): void {
    const payload: ContextWindowChangedPayload = {
      sessionId,
      model,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
    this.emit(CoreEvent.ContextWindowChanged, payload);
  }

  /**
   * Notifies subscribers that the permission mode has changed.
   */
  emitPermissionModeChanged(
    sessionId: string,
    mode: PermissionMode,
    previousMode: PermissionMode,
  ): void {
    const payload: PermissionModeChangedPayload = {
      sessionId,
      mode,
      previousMode,
    };
    this.emit(CoreEvent.PermissionModeChanged, payload);
  }

  /**
   * Notifies subscribers that the session's title has changed.
   *
   * Emitted directly rather than queued: this is live-session state, and a
   * title change with nobody listening is stale the moment the next one lands.
   */
  emitSessionTitleChanged(sessionId: string, title: string): void {
    const payload: SessionTitleChangedPayload = { sessionId, title };
    this.emit(CoreEvent.SessionTitleChanged, payload);
  }

  /**
   * Notifies subscribers that plan state has changed.
   */
  emitPlanStateChanged(sessionId: string, active: boolean): void {
    const payload: PlanStateChangedPayload = { sessionId, active };
    this.emit(CoreEvent.PlanStateChanged, payload);
  }

  /**
   * Notifies subscribers that settings have been modified.
   */
  emitSettingsChanged(): void {
    this.emit(CoreEvent.SettingsChanged);
  }

  /**
   * Notifies subscribers that a hook has provided a system message.
   */
  emitHookSystemMessage(payload: HookSystemMessagePayload): void {
    this.emit(CoreEvent.HookSystemMessage, payload);
  }

  /**
   * Notifies subscribers that agents have been refreshed.
   */
  emitAgentsRefreshed(sessionId: string): void {
    const payload: AgentsRefreshedPayload = { sessionId };
    this.emit(CoreEvent.AgentsRefreshed, payload);
  }

  /**
   * Notifies subscribers that admin settings have changed.
   */
  emitAdminSettingsChanged(): void {
    this.emit(CoreEvent.AdminSettingsChanged);
  }

  /**
   * Notifies subscribers that a retry attempt is happening.
   */
  emitRetryAttempt(payload: RetryAttemptPayload): void {
    emitModelRetryScheduled({
      attempt: payload.attempt,
      maxAttempts: payload.maxAttempts,
      delayMs: payload.delayMs,
      error: payload.error,
      model: payload.model,
    });
    this.emit(CoreEvent.RetryAttempt, payload);
  }

  /**
   * Requests consent from the user via the UI.
   */
  emitConsentRequest(payload: ConsentRequestPayload): void {
    this._emitOrQueue(CoreEvent.ConsentRequest, payload);
  }

  /**
   * Notifies subscribers that progress has been made on an MCP tool call.
   */
  emitMcpProgress(payload: McpProgressPayload): void {
    if (!Number.isFinite(payload.progress) || payload.progress < 0) {
      runLogger.log(`Invalid progress value: ${payload.progress}`);
      return;
    }
    this.emit(CoreEvent.McpProgress, payload);
  }

  emitSlashCommandConflicts(conflicts: SlashCommandConflict[]): void {
    const payload: SlashCommandConflictsPayload = { conflicts };
    this._emitOrQueue(CoreEvent.SlashCommandConflicts, payload);
  }

  /**
   * Notifies subscribers that the quota has changed.
   */
  emitQuotaChanged(
    remaining: number | undefined,
    limit: number | undefined,
    resetTime?: string,
  ): void {
    const payload: QuotaChangedPayload = { remaining, limit, resetTime };
    this.emit(CoreEvent.QuotaChanged, payload);
  }

  /**
   * Flushes buffered messages. Call this immediately after primary UI listener
   * subscribes.
   *
   * §5.1 多会话警告：listenerCount(event)===0 时事件不丢弃而是进积压队列（上限
   * MAX_BACKLOG_SIZE），有人订阅后回放。多会话下这意味着后开的会话可能收到它存在
   * 之前、别的会话发出的积压事件——积压回放本身不做会话过滤，不能当作安全。
   * 挡板在消费侧：经 onSessionEvent 订阅时，回放的 payload 携带的是原发射会话的
   * sessionId，与当前会话不匹配会被过滤掉。直接用裸 on() 的消费者（单会话 TUI/worker）
   * 收到全部积压是正确的；任何新的多会话消费者必须走 onSessionEvent，否则积压回放
   * 会把跨会话事件泄漏给它。
   */
  drainBacklogs(): void {
    const backlog = this._eventBacklog;
    const head = this._backlogHead;
    this._eventBacklog = [];
    this._backlogHead = 0;
    for (let i = head; i < backlog.length; i++) {
      const item = backlog[i];
      if (item === undefined) continue;

      (this.emit as (event: keyof CoreEvents, ...args: unknown[]) => boolean)(
        item.event,
        ...item.args,
      );
    }
  }

  emitTrustChanged(sessionId: string, isTrusted: boolean): void {
    const payload: TrustChangedPayload = { sessionId, isTrusted };
    this.emit(CoreEvent.TrustChanged, payload);
  }

  /**
   * Notifies subscribers of goal status updates.
   */
  emitGoalUpdated(payload: GoalUpdatedPayload): void {
    this._emitOrQueue(CoreEvent.GoalUpdated, payload);
  }

  emitGoalCleared(payload: GoalClearedPayload): void {
    this._emitOrQueue(CoreEvent.GoalCleared, payload);
  }

  emitAutoDreamStatus(payload: AutoDreamStatusPayload): void {
    this._emitOrQueue(CoreEvent.AutoDreamStatus, payload);
  }

  emitDynamicCommandsChanged(): void {
    this.emit(CoreEvent.DynamicCommandsChanged);
  }

  /**
   * Publishes structured managed plugin sync results without using UserFeedback.
   * Only interactive TUI consumers subscribe; headless output stays untouched.
   */
  emitManagedPluginSyncComplete(
    organizationId: string,
    result: EnterpriseSyncResult,
  ): void {
    this._emitOrQueue(CoreEvent.ManagedPluginSyncComplete, {
      organizationId,
      result,
    });
  }

  emitCompressionProgress(payload: CompressionProgressPayload): void {
    emitCompressionProgress({
      stage: payload.stage,
      trigger: payload.trigger,
      sessionScopeId: payload.sessionScopeId,
      target: payload.target,
      agentId: payload.agentId,
      tokensBeforeCompact: payload.tokensBeforeCompact,
      tokensAfterCompact: payload.tokensAfterCompact,
      failureReason: payload.failureReason,
    });
    this._emitOrQueue(CoreEvent.CompressionProgress, payload);
  }
}

export const coreEvents = new CoreEventEmitter();
