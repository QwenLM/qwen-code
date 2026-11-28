/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unified runtime message types.
 *
 * This union is used by conversation state, transcript persistence, and API
 * message projection, so all runtime messages should flow through one of these
 * variants.
 */

import type {
  BetaStopReason,
  NonNullableUsage,
  ToolDenialKind,
  ToolPermissionDenialKind,
} from '../schemas/common.js';
import type { Attachment } from '../../attachments/types.js';
import type { McpResultMeta } from '../../mcp/tools/mcp-result.js';
import type { McpInfo } from '../../mcp/tools/mcp-tool.js';

// ---------------------------------------------------------------------------
// 会话／历史内容契约，不继承标准模型请求、事件或完成消息。
// ---------------------------------------------------------------------------

export interface TextBlockParam {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: string };
}

export interface ImageBlockParam {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
  cache_control?: { type: 'ephemeral'; ttl?: string };
}

export interface TranscriptReasoningItem {
  id?: string;
  type?: string;
  status?: 'in_progress' | 'completed' | 'incomplete';
  summary?: ReadonlyArray<{ type: string; text: string }>;
  content?: ReadonlyArray<{ type: string; text: string }>;
  encrypted_content?: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
  citations?: null;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
  reasoning_item?: TranscriptReasoningItem;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
  reasoning_item?: TranscriptReasoningItem;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputJson?: string;
  mcpInfo?: McpInfo;
  /** Opaque provider data (Gemini thought signature) replayed with history. */
  thoughtSignature?: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock;

/** 稳定会话载荷；transcript 直接存储此形状，不随推理契约变化。 */
export interface AssistantMessagePayload {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  stop_reason: BetaStopReason | null;
  stop_sequence: string | null;
  usage?: NonNullableUsage;
  content: ContentBlock[];
  container: null;
  context_management: null;
}

/**
 * A tool_result content block within a user message.
 *
 * `tool_use_id` links the tool output back to the assistant tool call that
 * produced it.
 */
export interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ReadonlyArray<TextBlockParam | ImageBlockParam>;
  /** Omitted for successful results and set to true for errors. */
  is_error?: boolean;
}

/** Content block types that can appear in UserMessage.message.content arrays. */
export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolResultBlockParam;

// ---------------------------------------------------------------------------
// MessageBase — shared fields across all variants
// ---------------------------------------------------------------------------

/**
 * Base fields shared by all Message variants.
 *
 * Session context fields are optional at runtime and become required when the
 * message is persisted as a transcript entry.
 */
export interface MessageBase {
  /** Unique identifier, assigned once at creation via crypto.randomUUID(). */
  uuid: string;
  /** ISO 8601 timestamp, assigned at creation. */
  timestamp: string;

  // ── Optional flags ──
  /** Synthetic/meta message (not from real user/assistant interaction). */
  isMeta?: boolean;
  /** Visible in transcript views but hidden from the default live conversation view. */
  isVisibleInTranscriptOnly?: boolean;
  /** Runtime-only wrapper message that must not be forwarded back to the model. */
  isVirtual?: boolean;
  /** Whether this message is a compaction summary boundary. */
  isCompactSummary?: boolean;
  /** Session prefix retained by segmented compaction. */
  isCompactionPrefix?: boolean;

  // ── Session context (optional in Message, required in TranscriptMessage) ──
  /** Working directory when the message was created. */
  cwd?: string;
  /** Session ID this message belongs to. */
  sessionId?: string;
  /** User type, for example "external" for interactive messages. */
  userType?: string;
  /** Entrypoint identifier, for example "cli" or "sdk". */
  entrypoint?: string;
  /** CLI/SDK version string. */
  version?: string;
  /** Current git branch when available. */
  gitBranch?: string;
  /** Agent ID (for sub-agent/team scenarios). */
  agentId?: string;
  /** Team name (for multi-agent coordination). */
  teamName?: string;
  /** Agent name (for multi-agent coordination). */
  agentName?: string;
  /** URL slug identifier. */
  slug?: string;
  /** Identifier shared by messages created for the same user turn. */
  promptId?: string;
}

// ---------------------------------------------------------------------------
// UserMessage
// ---------------------------------------------------------------------------

export interface HumanInputSnapshot {
  text: string;
  mode: 'prompt' | 'bash';
}

/**
 * A user message containing plain text input or tool execution results.
 */
export interface UserMessage extends MessageBase {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlockParam[];
  };
  /** Parent tool_use_id if this message was produced by a sub-agent. */
  parent_tool_use_id?: string | null;
  /** Task/request-set started by this human message, when applicable. */
  requestSetId?: string;
  /** Model selected when this user turn began, for restored business attribution. */
  businessModelKey?: string;
  /** 原轮次归属供标题等延迟请求复用，恢复时不读取当前 Query 的类型。 */
  businessIdentity?: Pick<
    import('../../qoder/business-info.js').BusinessInfo,
    'product' | 'type' | 'id' | 'model_key'
  >;
  /** Links tool_result to the assistant message that requested the tool use. */
  sourceToolAssistantUUID?: string;
  /** Permission mode from approval settings. */
  permissionMode?: string;
  /** Origin metadata. */
  origin?: { kind: 'human' | string };
  /** Structured tool result payload persisted alongside tool_result content. */
  toolUseResult?: unknown;
  /** MCP result metadata aligned with toolUseResult (scalar or positional). */
  mcpMeta?: McpResultMeta | Array<McpResultMeta | null>;
  /** Host-only Read replacement paths, scalar or aligned with tool results. */
  readOutputReplacement?: string | Array<string | null>;
  /** Stable permission denial metadata aligned positionally with tool results. */
  toolDenialKind?: ToolDenialKind | Array<ToolDenialKind | undefined>;
  /** 原始用户拒绝反馈，与 tool_result 按位置对齐。 */
  userFeedback?: string | Array<string | undefined>;
  /** Whether this is a replayed message (from resume). */
  isReplay?: boolean;
  /** Exact human-authored input used to reconstruct a Rewind prefill. */
  humanInput?: HumanInputSnapshot;
  /** Meta text relaying a decision the user made in host UI; see QueuedCommand. */
  isUserDecision?: true;
  /** Task text a parent agent wrote for a subagent, not the user's own words. */
  isDelegatedTask?: true;
}

// ---------------------------------------------------------------------------
// AssistantMessage
// ---------------------------------------------------------------------------

/** 会话助手记录：独立历史载荷及宿主元数据，不依赖模型事件流。 */
export interface AssistantMessage extends MessageBase {
  /** Host-generated identity shared by every history block of one model response. */
  responseGroupId?: string;
  /** Internal block coverage for interrupted final projections, absent on SDK wire. */
  partialStreamIndex?: number;
  type: 'assistant';
  message: AssistantMessagePayload;
  /**
   * The responding model's catalog source, persisted only when it is an
   * custom provider. Named `modelSource` rather than `provider` because
   * `Model.connection.provider` already means the upstream provider key
   * ('openai', 'deepseek', …), which is a different axis.
   *
   * 取值必须与 `CUSTOM_PROVIDER_SOURCE`
   * (provider/custom/types.ts) 一致；这里写字面量是为了不让 protocol
   * 层对该包产生运行时依赖。
   */
  modelSource?: 'custom';
  /**
   * Stable Custom Provider identity that produced this response.
   *
   * The wire-level `message.model` is not sufficient because different
   * Custom Providers may expose the same model ID. This field is intentionally
   * secret-free and is persisted so resumed sessions can decide whether
   * provider-scoped reasoning metadata is safe to replay.
   */
  customProviderId?: string;
  /** Secret-free request identity validating reuse of this response's usage. */
  requestTokenAnchor?: {
    request: string;
    response: string;
    requestId?: string;
  };
  /** x-request-id response header for tracing. */
  requestId?: string;
  /** Session ID (may differ from MessageBase.sessionId in fork scenarios). */
  session_id?: string;
  /** Parent tool_use_id if this is a sub-agent response. */
  parent_tool_use_id?: string | null;
  /** Whether this is a synthetic API error message (not a real model response). */
  isApiErrorMessage?: boolean;
  /** Whether this is the synthetic replacement emitted for HTTP 406. */
  isContentFilteredMessage?: boolean;
  /** Classified error type (e.g. 'rate_limit', 'authentication_failed'). */
  error?: string;
  /** Raw error details (stack trace, API error body). */
  errorDetails?: string;
  /** Original error code used by hosts to select dynamic error text. */
  displayErrorCode?: string | number;
  /** Server-provided fallback when no dynamic text exists for the code. */
  errorFallbackMessage?: string;
  /** Provider error fact; hosts select presentation without parsing its message. */
  modelError?: {
    kind: import('../../provider/modelInferenceError.js').ModelInferenceErrorKind;
    status?: number;
    providerSource?: string;
    emptyCompletionReason?: import('../../model-request/empty-assistant-completion.js').EmptyAssistantCompletionReason;
    causeCodes?: string[];
  };
  /**
   * The model stream ended because the turn was interrupted before a stop
   * reason arrived. The projected SDK assistant frame may end mid-token.
   */
  aborted?: true;
}

// ---------------------------------------------------------------------------
// SystemMessage
// ---------------------------------------------------------------------------

/**
 * System message subtypes used by the current runtime and transcript logic.
 *
 * Additional subtypes can be added later without changing the structure of
 * `SystemMessage`.
 */
export type SystemSubtype =
  | 'api_error'
  | 'api_retry'
  | 'background_tasks_changed'
  | 'compact_boundary'
  | 'error'
  | 'error_during_execution'
  | 'error_max_turns'
  | 'hook_started'
  | 'hook_progress'
  | 'hook_response'
  | 'informational'
  | 'init'
  | 'interrupt'
  | 'local_command'
  | 'local_command_output'
  | 'memory_saved'
  | 'model_queue_status'
  | 'permission_denied'
  | 'permission_mode_transient'
  | 'permission_retry'
  | 'session_state_changed'
  | 'status'
  | 'success'
  | 'task_notification'
  | 'task_progress'
  | 'task_started'
  | 'task_updated'
  | 'turn_duration';

/**
 * Structured metadata attached to `system/compact_boundary` messages so the
 * boundary entry in the JSONL transcript carries enough context to (a) drive
 * compression-v2's boundary detection on resume and (b) feed UI/reporting
 * without needing a separate sidecar file.
 *
 * Mirrors the wire shape defined in
 * `protocol/schemas/sdk-message.ts:SDKCompactBoundaryMessageSchema`, but
 * stays in camelCase for runtime ergonomics; serialization is direct since
 * transcript JSONL preserves the in-memory shape.
 */
export interface CompactMetadata {
  trigger: 'manual' | 'auto';
  /** Token count of the runtime history before the compaction ran. */
  preTokens: number;
  /** Token count of the resulting compacted history when known. */
  postTokens?: number;
  /** Number of pre-compact messages folded into the summary, when known. */
  messagesSummarized?: number;
  /** Wall-clock duration of the compaction operation in milliseconds. */
  durationMs?: number;
  /**
   * Identifies the original kept response segment and its new post-summary
   * anchor so resume can relink persisted records without changing their UUIDs.
   */
  preservedSegment?: {
    headUuid: string;
    anchorUuid: string;
    tailUuid: string;
    /** Internal resume order, including parallel tool results with sibling parents. */
    messageUuids?: string[];
  };
  /**
   * Names of deferred tools that had been pulled into the request before
   * compaction; the post-compact request path needs these so already-loaded
   * schemas keep flowing to the API. Optional; populated when available.
   */
  preCompactDiscoveredTools?: string[];
}

/**
 * A system message for internal events and legacy transcript records.
 *
 * Current local command context is persisted as meta user messages. Legacy
 * `local_command` / `local_command_output` system entries remain in the type
 * union so older transcripts can be loaded and rendered, but they are not
 * projected to provider requests.
 */
export interface SystemMessage extends MessageBase {
  type: 'system';
  subtype: SystemSubtype;
  content: string;
  level: 'info' | 'error';
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  task_type?: string;
  subagent_type?: string;
  workflow_name?: string;
  prompt?: string;
  status?: 'completed' | 'failed' | 'stopped' | 'queued' | 'ready';
  output_file?: string;
  summary?: string;
  usage?: {
    total_tokens?: number;
    tool_uses: number;
    duration_ms: number;
  };
  last_tool_name?: string;
  patch?: {
    status?:
      | 'pending'
      | 'running'
      | 'completed'
      | 'failed'
      | 'killed'
      | 'paused';
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  /**
   * Present on `task_started` for subagent tasks. Names of all tools available
   * to the subagent at task start time, post tool whitelist / MCP discovery
   * / disallowedTools blacklist. Forwarded to SDKTaskStartedMessage.tools.
   */
  tools?: string[];
  tasks?: Array<{
    task_id: string;
    task_type: string;
    description: string;
  }>;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  agent_id?: string;
  request_id?: string;
  request_set_id?: string;
  model_key?: string;
  queue_type?: string;
  queue_count?: number;
  wait_time_ms?: number;
  queue_wait_elapsed_ms?: number;
  queue_max_wait_ms?: number;
  service_available?: boolean;
  decision_reason_type?:
    | 'rule'
    | 'mode'
    | 'subcommandResults'
    | 'permissionPromptTool'
    | 'hook'
    | 'asyncAgent'
    | 'sandboxOverride'
    | 'workingDir'
    | 'safetyCheck'
    | 'classifier'
    | 'repeatedToolCall'
    | 'other';
  decision_reason?: string;
  tool_denial_kind?: ToolPermissionDenialKind;
  /**
   * Present iff `subtype === 'compact_boundary'`. Carries the compaction
   * trigger, pre-/post-token counts, and any preserved-segment anchors so
   * compression-v2 can rehydrate boundary state from the transcript alone.
   */
  compactMetadata?: CompactMetadata;
  compactUsage?: NonNullableUsage;
  modelRequestIds?: string[];
  agentId?: string;
  /**
   * Persisted compact boundaries set this flag when pruning requires a later
   * active-leaf record whose `compactBoundaryUuid` matches this message.
   * Missing means the legacy, pre-commit-protocol boundary behavior.
   */
  requiresActiveLeafCommit?: boolean;
}

// ---------------------------------------------------------------------------
// ProgressMessage (not persisted)
// ---------------------------------------------------------------------------

/**
 * A progress message — display-only, never persisted to JSONL.
 *
 * `cleanMessagesForLogging()` filters out all `type === "progress"` messages
 * before persistence. They also don't participate in the parentUuid chain.
 */
export interface ProgressMessage extends MessageBase {
  type: 'progress';
  data: unknown;
  toolUseID?: string;
}

// ---------------------------------------------------------------------------
// AttachmentMessage
// ---------------------------------------------------------------------------

/**
 * Attachment types recognized by the runtime attachment pipeline.
 */
export type AttachmentType = Attachment['type'] | 'hook_error';
export type TranscriptAttachment = {
  type: AttachmentType;
  [key: string]: unknown;
};

/**
 * An attachment message for hook results, memories, or structured output.
 *
 * Attachment messages are retained by the transcript writer. Provider
 * projection decides whether a given attachment contributes model context.
 */
export interface AttachmentMessage extends MessageBase {
  type: 'attachment';
  attachment: TranscriptAttachment;
}

// ---------------------------------------------------------------------------
// ToolUseSummaryMessage
// ---------------------------------------------------------------------------

/**
 * A tool use summary — collapses multiple tool uses into a single
 * summary entry for display purposes.
 */
export interface ToolUseSummaryMessage extends MessageBase {
  type: 'tool_use_summary';
  summary: unknown;
  precedingToolUseIds: string[];
}

// ---------------------------------------------------------------------------
// TombstoneMessage
// ---------------------------------------------------------------------------

/**
 * A tombstone message marks assistant content that should be deleted.
 *
 * This is useful for streaming flows that may emit partial assistant content
 * before deciding it should be discarded. The type exists now so runtime and
 * transcript code can evolve without changing the message union later.
 */
export interface TombstoneMessage extends MessageBase {
  type: 'tombstone';
  /** The original message content being marked for deletion. */
  message: unknown;
}

// ---------------------------------------------------------------------------
// Message union
// ---------------------------------------------------------------------------

/**
 * The unified runtime message union.
 *
 * The `type` field is the discriminant for all message variants.
 */
export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage
  | ToolUseSummaryMessage
  | TombstoneMessage;

/**
 * MessageType — the discriminant values of the Message union.
 */
export type MessageType = Message['type'];
