/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDKMessage — CLI 写到 stdout 的 JSONL 线协议消息类型。
 *
 * SDK consumer（`QueryRunner`）逐行读取并路由这些消息。
 * 每个 schema 的字段名、可选性、discriminant（`type` / `subtype`）
 * 都必须与 SDK 协议保持一致。
 *
 * Most message types come from `../wire/messages.ts`. Each matching schema
 * here is constrained to that protocol type via
 * `satisfies z.ZodType<X>`. CLI-owned
 * protocol additions are declared locally so the CLI can ship them independently of an SDK
 * release.
 */

import { z } from 'zod';
import type { HookDiagnosticsSnapshot } from '../../hooks/hookDiagnostics.js';
import { SHELL_OUTPUT_PREVIEW_MAX_BYTES } from '../../utils/shellOutputPolicy.js';
import type {
  SDKAssistantMessage as ProtoSDKAssistantMessage,
  SDKUserMessage as ProtoSDKUserMessage,
  SDKUserMessageReplay as ProtoSDKUserMessageReplay,
  SDKResultSuccess as ProtoSDKResultSuccess,
  SDKResultError as ProtoSDKResultError,
  SDKSystemMessage as ProtoSDKSystemMessage,
  SDKPartialAssistantMessage as ProtoSDKPartialAssistantMessage,
  SDKStatusMessage as ProtoSDKStatusMessage,
  SDKSessionStateChangedMessage as ProtoSDKSessionStateChangedMessage,
  SDKSessionTitleChangedMessage as ProtoSDKSessionTitleChangedMessage,
  SDKCompactBoundaryMessage as ProtoSDKCompactBoundaryMessage,
  SDKAPIRetryMessage as ProtoSDKAPIRetryMessage,
  SDKLocalCommandOutputMessage as ProtoSDKLocalCommandOutputMessage,
  SDKHookStartedMessage as ProtoSDKHookStartedMessage,
  SDKHookProgressMessage as ProtoSDKHookProgressMessage,
  SDKHookResponseMessage as ProtoSDKHookResponseMessage,
  SDKTaskNotificationMessage as ProtoSDKTaskNotificationMessage,
  SDKTaskStartedMessage as ProtoSDKTaskStartedMessage,
  SDKTaskProgressMessage as ProtoSDKTaskProgressMessage,
  SDKBridgeStateMessage as ProtoSDKBridgeStateMessage,
  SDKFilesPersistedEvent as ProtoSDKFilesPersistedEvent,
  SDKElicitationCompleteMessage as ProtoSDKElicitationCompleteMessage,
  SDKPromptSuggestionMessage as ProtoSDKPromptSuggestionMessage,
  SDKPermissionDeniedMessage as ProtoSDKPermissionDeniedMessage,
  ModelInfo as ProtoModelInfo,
  SDKMessage as ProtoSDKMessage,
} from '../wire/index.js';
import type {
  ModelUsage,
  NonNullableUsage,
  SDKPermissionDenial,
  SDKPermissionDeniedReasonType,
  SDKToolResultMeta,
} from './common.js';
import { lazySchema } from '../utils/lazySchema.js';
import {
  APIUserMessagePlaceholder,
  APIAssistantMessagePlaceholder,
  RawMessageStreamEventPlaceholder,
  UUIDPlaceholder,
  NonNullableUsagePlaceholder,
  ModelUsageSchema,
  ApiKeySourceSchema,
  PermissionModeSchema,
  FastModeStateSchema,
  SDKAssistantMessageErrorSchema,
  SDKStatusSchema,
  SDKPermissionDenialSchema,
  SDKPermissionDeniedReasonTypeSchema,
  SDKToolDenialKindSchema,
  SDKToolResultMetaSchema,
  PluginInfoSchema,
} from './common.js';

// ---------------------------------------------------------------------------
// Re-export wire-protocol message types — single source `../wire/messages.ts`.
// ---------------------------------------------------------------------------
export type {
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKSessionStateChangedMessage,
  SDKSessionTitleChangedMessage,
  SDKAPIRetryMessage,
  SDKLocalCommandOutputMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKBridgeStateMessage,
  SDKFilesPersistedEvent,
  SDKElicitationCompleteMessage,
  SDKPromptSuggestionMessage,
} from '../wire/index.js';

export type SDKUserMessage = ProtoSDKUserMessage & {
  tool_result_meta?: SDKToolResultMeta[];
  origin?: SDKMessageOrigin;
  selected_skills?: Array<{ name: string; arguments?: string }>;
};

export type SDKUserMessageReplay = ProtoSDKUserMessageReplay & {
  tool_result_meta?: SDKToolResultMeta[];
  origin?: SDKMessageOrigin;
  selected_skills?: Array<{ name: string; arguments?: string }>;
};

export type SDKAssistantMessage = ProtoSDKAssistantMessage & {
  request_id?: string;
};

export type SDKHostToolUseMessage = z.infer<ReturnType<typeof SDKHostToolUseMessageSchema>>;
export type SDKHostToolResultMessage = z.infer<ReturnType<typeof SDKHostToolResultMessageSchema>>;
export type SDKCodeModeHostResult =
  Pick<SDKHostToolResultMessage['message']['content'][0], 'content' | 'is_error'> &
  Pick<SDKHostToolResultMessage, 'tool_use_result' | 'tool_result_meta'>;

const HostToolEnvelopeSchema = () => ({
  type: z.literal('system'),
  code_mode_tool_use_id: z.string().min(1),
  uuid: UUIDPlaceholder(),
  session_id: z.string(),
  parent_tool_use_id: z.string().nullable(),
});

export const SDKHostToolUseMessageSchema = lazySchema(() =>
  z.object({
    ...HostToolEnvelopeSchema(),
    subtype: z.literal('host_tool_use'),
    message: z.object({
      role: z.literal('assistant'),
      content: z.tuple([
        z.object({
          type: z.literal('tool_use'),
          id: z.string().min(1),
          name: z.string(),
          input: z.record(z.string(), z.unknown()),
        }),
      ]),
    }),
  }),
);

export const SDKHostToolResultMessageSchema = lazySchema(() =>
  z.object({
    ...HostToolEnvelopeSchema(),
    subtype: z.literal('host_tool_result'),
    message: z.object({
      role: z.literal('user'),
      content: z.tuple([
        z.object({
          type: z.literal('tool_result'),
          tool_use_id: z.string().min(1),
          content: z.union([
            z.string(),
            z.array(z.object({ type: z.string() }).passthrough()),
          ]),
          is_error: z.boolean().optional(),
        }),
      ]),
    }),
    tool_use_result: z.unknown().optional(),
    tool_result_meta: z.array(SDKToolResultMetaSchema()).optional(),
  }),
);

export type SDKResultSuccess = Omit<
  ProtoSDKResultSuccess,
  'permission_denials' | 'modelUsage' | 'error_code'
> & {
  permission_denials: SDKPermissionDenial[];
  total_credits: number;
  /** When true, total_credits is only the known subtotal, not full history. */
  credits_history_incomplete?: true;
  modelUsage: Record<string, ModelUsage>;
  origin?: SDKMessageOrigin;
  error_code?: number | string;
};

export type SDKResultError = Omit<
  ProtoSDKResultError,
  'permission_denials' | 'modelUsage' | 'error_code'
> & {
  permission_denials: SDKPermissionDenial[];
  total_credits: number;
  /** When true, total_credits is only the known subtotal, not full history. */
  credits_history_incomplete?: true;
  modelUsage: Record<string, ModelUsage>;
  origin?: SDKMessageOrigin;
  error_code?: number | string;
  /** 服务端业务说明，仅做必要脱敏；不替换 errors 展示文案。 */
  error_message?: string;
};

/** 当前轮输入的来源。 */
export type SDKMessageOrigin =
  | { kind: 'task-notification' }
  | {
      kind: 'peer';
      from?: string;
      senderTaskId?: string;
      name?: string;
      body?: string;
    }
  | { kind: 'human' }
  | { kind: 'bridge'; sessionId?: string };

/** @deprecated 请使用 SDKMessageOrigin。 */
export type SDKResultOrigin = SDKMessageOrigin;

const SDKMessageOriginSchema = () =>
  z.union([
    z.object({ kind: z.literal('task-notification') }),
    z.object({
      kind: z.literal('peer'),
      from: z.string().optional(),
      senderTaskId: z.string().optional(),
      name: z.string().optional(),
      body: z.string().optional(),
    }),
    z.object({ kind: z.literal('human') }),
    z.object({
      kind: z.literal('bridge'),
      sessionId: z.string().optional(),
    }),
  ]);

export type SDKResultMessage = SDKResultSuccess | SDKResultError;

export const HOST_ACTIONS = [
  'copy_text',
  'helpful',
  'not_helpful',
  'create_branch_task',
  'copy_markdown',
  'add_reply_to_task',
] as const;

export type HostAction = (typeof HOST_ACTIONS)[number];

export type HostActionEvent = {
  type: 'feedback';
  subtype: 'action';
  uuid: string;
  action: HostAction;
  session_id: string;
  parent_result_uuid: string;
};

export interface SDKTaskUpdatedMessage {
  type: 'system';
  subtype: 'task_updated';
  task_id: string;
  patch: {
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
  uuid: string;
  session_id: string;
}

export interface SDKBackgroundTasksChangedMessage {
  type: 'system';
  subtype: 'background_tasks_changed';
  tasks: Array<{
    task_id: string;
    task_type: string;
    description: string;
  }>;
  uuid: string;
  session_id: string;
}

export type SDKCompactBoundaryMessage = Omit<ProtoSDKCompactBoundaryMessage, 'usage'> & {
  usage?: { context_usage_ratio?: number; credits?: number };
  modelRequestIds?: string[];
  agent_id?: string;
};

export type SDKStatusMessage = Omit<ProtoSDKStatusMessage, 'usage'> & {
  usage?: { context_usage_ratio?: number; credits?: number };
  modelRequestIds?: string[];
  agent_id?: string;
};

export interface SDKSkillEvolutionMessage {
  type: 'system';
  subtype: 'skill_evolution';
  result: {
    status: 'suggested' | 'no_change' | 'skipped' | 'failed';
    attemptId: string;
    reason?: string;
    origin: 'turn_complete';
    reviewScore?: number;
    sourceRequestIds?: string[];
    modelRequestIds?: string[];
    suggestions: Array<{
      skillName: string;
      action: 'create' | 'update';
      summary: string;
      confidence: number;
      rationale?: string;
    }>;
    durationMs: number;
    usage?: NonNullableUsage;
  };
  uuid: string;
  session_id: string;
}

export const SDKSkillEvolutionMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('skill_evolution'),
    result: z.object({
      status: z.enum(['suggested', 'no_change', 'skipped', 'failed']),
      attemptId: z.string(),
      reason: z.string().optional(),
      origin: z.literal('turn_complete'),
      reviewScore: z.number().optional(),
      sourceRequestIds: z.array(z.string()).optional(),
      modelRequestIds: z.array(z.string()).optional(),
      suggestions: z.array(z.object({
        skillName: z.string(),
        action: z.enum(['create', 'update']),
        summary: z.string(),
        confidence: z.number(),
        rationale: z.string().optional(),
      })),
      durationMs: z.number(),
      usage: NonNullableUsagePlaceholder().optional(),
    }),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }) satisfies z.ZodType<SDKSkillEvolutionMessage>,
);

/**
 * Internal stream-json delivery state for a UUID-stamped queued command.
 *
 * This output is advertised with the `msg_lifecycle_v1` capability.
 * It is intentionally separate from the public Agent SDK message union.
 */
export interface SDKCommandLifecycleMessage {
  type: 'command_lifecycle';
  command_uuid: string;
  state: 'queued' | 'started' | 'completed' | 'cancelled' | 'discarded';
  uuid: string;
  session_id: string;
}

/** Progress for an SDK control request that runs outside the main turn. */
export interface SDKControlRequestProgressMessage {
  type: 'system';
  subtype: 'control_request_progress';
  request_id: string;
  status: 'started' | 'api_retry';
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  uuid: string;
  session_id: string;
}

export type SDKPermissionDeniedMessage = Omit<
  ProtoSDKPermissionDeniedMessage,
  'decision_reason_type'
> & {
  decision_reason_type?: SDKPermissionDeniedReasonType;
  tool_denial_kind?: import('./common.js').SDKToolDenialKind;
};

export type SDKArtifactInfo = {
  path: string;
  display_path: string;
  name: string;
  group?: {
    key: string;
    name: string;
  };
  relative_path?: string;
  size?: number;
  mime?: string;
  mtime?: number;
} & (
  | {
      kind: 'changed';
      additions: number;
      deletions: number;
      is_new: boolean;
    }
  | {
      kind: 'presented';
    }
);

export type SDKArtifactUpdateMessage = {
  type: 'system';
  subtype: 'artifacts_update';
  artifacts: readonly SDKArtifactInfo[];
  uuid: string;
  session_id: string;
};

export type SDKAvailableModelInfo = Omit<ProtoModelInfo, 'source'> & {
  source?: 'system' | 'user' | 'organization' | 'custom';
  outerProvider?: string;
  descriptionEn?: string;
};

export type SDKAvailableModelsUpdateMessage = {
  type: 'system';
  subtype: 'available_models_update';
  models: SDKAvailableModelInfo[];
  currentModel: string;
  uuid: string;
  session_id: string;
};

export type SDKCommandInfo = {
  name: string;
  description: string;
  argumentHint: string;
};

export type SDKCommandsChangedMessage = {
  type: 'system';
  subtype: 'commands_changed';
  commands: SDKCommandInfo[];
  uuid: string;
  session_id: string;
};

export interface SDKAgentsMdSizeWarningMessage {
  type: 'system';
  subtype: 'agents_md_size_warning';
  code: 'AGENTS_MD_SIZE_THRESHOLD_REACHED';
  severity: 'warning';
  total_bytes: number;
  threshold_bytes: number;
  threshold_source: 'qcs' | 'default';
  files: Array<{ path: string; bytes: number }>;
  load_status: 'complete' | 'partial';
  truncated: false;
  uuid: string;
  session_id: string;
}

/** CLI-owned until the matching SDK protocol addition is published. */
export interface SDKHookDiagnosticsMessage {
  type: 'system';
  subtype: 'hook_diagnostics';
  read_status: HookDiagnosticsSnapshot['readStatus'];
  checked_at: string;
  diagnostics: HookDiagnosticsSnapshot['diagnostics'];
  uuid: string;
  session_id: string;
}

export type SDKMessage =
  | SDKHostToolUseMessage
  | SDKHostToolResultMessage
  | SDKHookDiagnosticsMessage
  | SDKToolProgressMessage
  | SDKAgentsMdSizeWarningMessage
  | Exclude<
      ProtoSDKMessage,
      | ProtoSDKAssistantMessage
      | ProtoSDKUserMessage
      | ProtoSDKUserMessageReplay
      | ProtoSDKResultSuccess
      | ProtoSDKResultError
      | ProtoSDKStatusMessage
      | ProtoSDKCompactBoundaryMessage
      | ProtoSDKPermissionDeniedMessage
    >
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKPermissionDeniedMessage
  | SDKArtifactUpdateMessage
  | SDKAvailableModelsUpdateMessage
  | SDKCommandsChangedMessage
  | SDKBackgroundTasksChangedMessage
  | SDKPlanModeChangedMessage
  | SDKGoalUpdatedMessage
  | SDKGoalClearedMessage
  | SDKTaskUpdatedMessage
  | SDKCommandLifecycleMessage
  | SDKSkillEvolutionMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKControlRequestProgressMessage;

// ============================================================================
// SDKUserMessage (type: 'user')
// ============================================================================

/**
 * 用户消息。
 *
 * `uuid` / `session_id` 可选——SDK consumer 向 CLI 发消息时可以不带，
 * 但 CLI 回放历史时一定会带上。
 */
const SDKUserMessageContentSchema = lazySchema(() =>
  z.object({
    type: z.literal('user'),
    message: APIUserMessagePlaceholder(),
    parent_tool_use_id: z.string().nullable(),
    selected_skills: z
      .array(
        z.object({
          name: z.string(),
          arguments: z.string().optional(),
        }),
      )
      .optional(),
    isSynthetic: z.boolean().optional(),
    tool_use_result: z.unknown().optional(),
    tool_result_meta: z.array(SDKToolResultMetaSchema()).optional(),
    origin: SDKMessageOriginSchema().optional(),
    priority: z.enum(['now', 'next', 'later']).optional(),
    shouldQuery: z.boolean().optional(),
    timestamp: z.string().optional(),
  }),
);

export const SDKUserMessageSchema = lazySchema(
  () =>
    SDKUserMessageContentSchema().extend({
      uuid: UUIDPlaceholder().optional(),
      session_id: z.string().optional(),
    }) satisfies z.ZodType<SDKUserMessage>,
);

/**
 * 回放变体——恢复会话 / 历史重播时使用。
 * 内容字段与 SDKUserMessage 相同，但 `uuid`、`session_id`、`isReplay` 全部必填。
 *
 * 注意：在 z.union 里必须排在 SDKUserMessage 前面，
 * 否则 base schema 的 optional uuid/session_id 会先匹配，`isReplay` 会被吞掉。
 */
export const SDKUserMessageReplaySchema = lazySchema(
  () =>
    SDKUserMessageContentSchema().extend({
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
      isReplay: z.literal(true),
    }) satisfies z.ZodType<SDKUserMessageReplay>,
);

// ============================================================================
// SDKAssistantMessage (type: 'assistant')
// ============================================================================

/**
 * 一个完整的 assistant 回复（单 turn）。
 * `message` 是完整的 Anthropic `BetaMessage`，包含所有 content blocks
 * （text / thinking / tool_use 等）。流式传输结束后才发射。
 */
export const SDKAssistantMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('assistant'),
      message: APIAssistantMessagePlaceholder(),
      parent_tool_use_id: z.string().nullable(),
      error: SDKAssistantMessageErrorSchema().optional(),
      aborted: z.literal(true).optional(),
      request_id: z.string().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKAssistantMessage>,
);

// ============================================================================
// SDKPartialAssistantMessage (type: 'stream_event')
// ============================================================================

/**
 * 流式 SSE 事件（text delta / thinking delta 等），原样透传。
 * 只在 SDK 选项 `includePartialMessages` 开启时才会发射。
 * 主 Agent 的 `parent_tool_use_id` 为 null；Subagent 事件通过非空值关联到父级 Agent 工具调用。
 */
export const SDKPartialAssistantMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('stream_event'),
      event: RawMessageStreamEventPlaceholder(),
      parent_tool_use_id: z.string().nullable(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKPartialAssistantMessage>,
);

// ============================================================================
// SDKResultMessage (type: 'result')
// ============================================================================

/** agentic loop 成功完成。包含最终文本、累计 token 用量、花费和可选的 structured output。 */
export const SDKResultSuccessSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('result'),
      subtype: z.literal('success'),
      duration_ms: z.number(),
      duration_api_ms: z.number(),
      is_error: z.boolean(),
      num_turns: z.number(),
      result: z.string(),
      stop_reason: z.string().nullable(),
      total_cost_usd: z.number(),
      total_credits: z.number(),
      credits_history_incomplete: z.literal(true).optional(),
      usage: NonNullableUsagePlaceholder(),
      modelUsage: z.record(z.string(), ModelUsageSchema()),
      permission_denials: z.array(SDKPermissionDenialSchema()),
      error_code: z.union([z.number(), z.string()]).optional(),
      structured_output: z.unknown().optional(),
      deferred_tool_use: z.unknown().optional(),
      terminal_reason: z.string().nullable().optional(),
      fast_mode_state: FastModeStateSchema().optional(),
      origin: SDKMessageOriginSchema().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKResultSuccess>,
);

/** agentic loop 异常终止。`subtype` 区分原因：运行时错误 / 超轮次 / 超预算 / structured output 重试超限。 */
export const SDKResultErrorSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('result'),
      subtype: z.enum([
        'error_during_execution',
        'error_max_turns',
        'error_max_budget_usd',
        'error_max_structured_output_retries',
      ]),
      duration_ms: z.number(),
      duration_api_ms: z.number(),
      is_error: z.boolean(),
      num_turns: z.number(),
      stop_reason: z.string().nullable(),
      total_cost_usd: z.number(),
      total_credits: z.number(),
      credits_history_incomplete: z.literal(true).optional(),
      usage: NonNullableUsagePlaceholder(),
      modelUsage: z.record(z.string(), ModelUsageSchema()),
      permission_denials: z.array(SDKPermissionDenialSchema()),
      errors: z.array(z.string()),
      error_message: z.string().optional(),
      error_code: z.union([z.number(), z.string()]).optional(),
      terminal_reason: z.string().nullable().optional(),
      fast_mode_state: FastModeStateSchema().optional(),
      origin: SDKMessageOriginSchema().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKResultError>,
);

/** 成功或失败，按 `subtype` 区分。 */
export const SDKResultMessageSchema = lazySchema(
  () =>
    z.union([
      SDKResultSuccessSchema(),
      SDKResultErrorSchema(),
    ]) satisfies z.ZodType<SDKResultMessage>,
);

export const HostActionEventSchema = lazySchema(
  () =>
    z
      .object({
        type: z.literal('feedback'),
        subtype: z.literal('action'),
        uuid: z.string().uuid(),
        action: z.enum(HOST_ACTIONS),
        session_id: z.string().min(1),
        parent_result_uuid: z.string().uuid(),
      })
      .strict() satisfies z.ZodType<HostActionEvent>,
);

// ============================================================================
// SDKSystemMessage (type: 'system', subtype: 'init')
// ============================================================================

/**
 * 初始化握手，session 开始时发射一次。
 * 上报运行环境信息（model / tools / MCP servers / plugins / permissionMode 等），
 * SDK consumer 据此填充 `initializationResult()`。
 */
export const SDKSystemMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('init'),
      agents: z.array(z.string()).optional(),
      apiKeySource: ApiKeySourceSchema(),
      betas: z.array(z.string()).optional(),
      protocol_version: z.string().optional(),
      cwd: z.string(),
      tools: z.array(z.string()),
      mcp_servers: z.array(
        z.object({
          name: z.string(),
          status: z.string(),
        }),
      ),
      model: z.string(),
      permissionMode: PermissionModeSchema(),
      slash_commands: z.array(z.string()),
      output_style: z.string(),
      skills: z.array(z.string()),
      plugins: z.array(PluginInfoSchema()),
      fast_mode_state: FastModeStateSchema().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKSystemMessage>,
);

// ============================================================================
// SDKArtifactUpdateMessage (type: 'system', subtype: 'artifacts_update')
// ============================================================================

const SDKArtifactInfoSchema = () =>
  z.union([
    z.object({
      path: z.string(),
      display_path: z.string(),
      name: z.string(),
      group: z
        .object({
          key: z.string(),
          name: z.string(),
        })
        .optional(),
      relative_path: z.string().optional(),
      size: z.number().optional(),
      mime: z.string().optional(),
      mtime: z.number().optional(),
      kind: z.literal('changed'),
      additions: z.number(),
      deletions: z.number(),
      is_new: z.boolean(),
    }),
    z.object({
      path: z.string(),
      display_path: z.string(),
      name: z.string(),
      group: z
        .object({
          key: z.string(),
          name: z.string(),
        })
        .optional(),
      relative_path: z.string().optional(),
      size: z.number().optional(),
      mime: z.string().optional(),
      mtime: z.number().optional(),
      kind: z.literal('presented'),
    }),
  ]) satisfies z.ZodType<SDKArtifactInfo>;

export const SDKArtifactUpdateMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('artifacts_update'),
      artifacts: z.array(SDKArtifactInfoSchema()),
      uuid: z.string(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKArtifactUpdateMessage>,
);

// ============================================================================
// SDKAvailableModelsUpdateMessage (type: 'system', subtype: 'available_models_update')
// ============================================================================

const SDKAvailableModelInfoSchema = () =>
  z
    .object({
      value: z.string(),
      modelId: z.string().optional(),
      displayName: z.string(),
      description: z.string(),
      descriptionEn: z.string().optional(),
      source: z.enum(['system', 'user', 'organization', 'custom']).optional(),
    })
    .passthrough() satisfies z.ZodType<SDKAvailableModelInfo>;

export const SDKAvailableModelsUpdateMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('available_models_update'),
      models: z.array(SDKAvailableModelInfoSchema()),
      currentModel: z.string(),
      uuid: z.string(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKAvailableModelsUpdateMessage>,
);

// ============================================================================
// SDKCommandsChangedMessage (type: 'system', subtype: 'commands_changed')
// ============================================================================

export const SDKCommandsChangedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('commands_changed'),
      commands: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          argumentHint: z.string(),
        }),
      ),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKCommandsChangedMessage>,
);

// ============================================================================
// SDKStatusMessage (type: 'system', subtype: 'status')
// ============================================================================

/** 瞬态状态变更。`status` 为 `'compacting'` 表示正在压缩上下文，`null` 表示空闲。 */
export const SDKStatusMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('status'),
      status: SDKStatusSchema(),
      permissionMode: PermissionModeSchema().optional(),
      usage: z.object({
        context_usage_ratio: z.number().optional(),
        credits: z.number().optional(),
      }).optional(),
      modelRequestIds: z.array(z.string()).optional(),
      agent_id: z.string().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKStatusMessage>,
);

// ============================================================================
// SDKPermissionDeniedMessage (type: 'system', subtype: 'permission_denied')
// ============================================================================

export const SDKPermissionDeniedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('permission_denied'),
      tool_name: z.string(),
      tool_use_id: z.string(),
      message: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
      agent_id: z.string().optional(),
      decision_reason_type: SDKPermissionDeniedReasonTypeSchema().optional(),
      decision_reason: z.string().optional(),
      tool_denial_kind: SDKToolDenialKindSchema().optional(),
    }) satisfies z.ZodType<SDKPermissionDeniedMessage>,
);

// ============================================================================
// SDKSessionStateChangedMessage (type: 'system', subtype: 'session_state_changed')
// ============================================================================

/**
 * Session 生命周期变更。
 * - `idle` — turn 结束，等待新输入
 * - `running` — 模型/工具执行中
 * - `requires_action` — 等待用户操作（如权限确认）
 */
export const SDKSessionStateChangedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('session_state_changed'),
      state: z.enum(['idle', 'running', 'requires_action']),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKSessionStateChangedMessage>,
);

// ============================================================================
// Plan Mode messages (type: 'system', subtype: 'plan_mode_changed')
// ============================================================================

/** Structured snapshot of the main session's independent Plan Mode state. */
export interface SDKPlanModeSnapshot {
  active: boolean;
}

/** The main session entered or left Plan Mode. */
export interface SDKPlanModeChangedMessage {
  type: 'system';
  subtype: 'plan_mode_changed';
  plan_mode: SDKPlanModeSnapshot;
  uuid: string;
  session_id: string;
}

export const SDKPlanModeSnapshotSchema = lazySchema(
  () =>
    z.object({
      active: z.boolean(),
    }) satisfies z.ZodType<SDKPlanModeSnapshot>,
);

export const SDKPlanModeChangedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('plan_mode_changed'),
      plan_mode: SDKPlanModeSnapshotSchema(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKPlanModeChangedMessage>,
);

// ============================================================================
// Goal messages (type: 'system', subtype: 'goal_updated' | 'goal_cleared')
//
// Wire types are defined locally (CLI is the protocol owner for goal control);
// SDKs mirror this shape by convention, like the Python SDK does for the rest
// of the protocol.
// ============================================================================

/** Lifecycle status values of the session goal on the wire. Single source of truth. */
export const SDK_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
] as const;

/** Lifecycle status of the session goal on the wire. */
export type SDKGoalStatus = (typeof SDK_GOAL_STATUSES)[number];

/** Structured snapshot of the session goal (wire shape). */
export interface SDKGoalSnapshot {
  id: string;
  objective: string;
  status: SDKGoalStatus;
  turns_used: number;
  max_turns?: number;
  time_used_seconds: number;
  credits_budget?: number;
  credits_used?: number;
  created_at: number;
  updated_at: number;
}

/** Goal created / redirected / transitioned / budget changed. */
export interface SDKGoalUpdatedMessage {
  type: 'system';
  subtype: 'goal_updated';
  goal: SDKGoalSnapshot;
  reason?: string;
  uuid: string;
  session_id: string;
}

/** Goal was cleared. */
export interface SDKGoalClearedMessage {
  type: 'system';
  subtype: 'goal_cleared';
  goal_id: string;
  reason?: string;
  uuid: string;
  session_id: string;
}



/** Structured snapshot of the session goal (wire shape shared by all goal messages). */
export const SDKGoalSnapshotSchema = lazySchema(
  () =>
    z.object({
      id: z.string(),
      objective: z.string(),
      status: z.enum(SDK_GOAL_STATUSES),
      turns_used: z.number(),
      max_turns: z.number().optional(),
      time_used_seconds: z.number(),
      credits_budget: z.number().optional(),
      credits_used: z.number().optional(),
      created_at: z.number(),
      updated_at: z.number(),
    }) satisfies z.ZodType<SDKGoalSnapshot>,
);

/** Goal created / redirected / transitioned / budget changed. */
export const SDKGoalUpdatedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('goal_updated'),
      goal: SDKGoalSnapshotSchema(),
      reason: z.string().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKGoalUpdatedMessage>,
);

/** Goal cleared. */
export const SDKGoalClearedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('goal_cleared'),
      goal_id: z.string(),
      reason: z.string().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKGoalClearedMessage>,
);

// ============================================================================
// SDKSessionTitleChangedMessage (type: 'system', subtype: 'session_title_changed')
// ============================================================================

/** Session title update. Emitted only when the host negotiated support. */
export const SDKSessionTitleChangedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('session_title_changed'),
      title: z.string(),
      source: z.enum(['ai', 'custom']),
      revision: z.number(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKSessionTitleChangedMessage>,
);

// ============================================================================
// SDKCompactBoundaryMessage (type: 'system', subtype: 'compact_boundary')
// ============================================================================

/** 上下文压缩边界标记。记录压缩触发方式和保留片段信息。 */
export const SDKCompactBoundaryMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('compact_boundary'),
      compact_metadata: z.object({
        trigger: z.enum(['manual', 'auto']),
        pre_tokens: z.number(),
        post_tokens: z.number().optional(),
        messages_summarized: z.number().optional(),
        duration_ms: z.number().optional(),
        preserved_segment: z
          .object({
            head_uuid: UUIDPlaceholder(),
            anchor_uuid: UUIDPlaceholder(),
            tail_uuid: UUIDPlaceholder(),
          })
          .optional(),
      }),
      usage: z.object({
        context_usage_ratio: z.number().optional(),
        credits: z.number().optional(),
      }).optional(),
      modelRequestIds: z.array(z.string()).optional(),
      agent_id: z.string().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKCompactBoundaryMessage>,
);

// ============================================================================
// SDKAPIRetryMessage (type: 'system', subtype: 'api_retry')
// ============================================================================

/** API 请求重试通知。包含重试次数、延迟和错误信息。 */
export const SDKAPIRetryMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('api_retry'),
      attempt: z.number(),
      max_retries: z.number(),
      retry_delay_ms: z.number(),
      error_status: z.number().nullable(),
      error: SDKAssistantMessageErrorSchema(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKAPIRetryMessage>,
);

// ============================================================================
// SDKLocalCommandOutputMessage (type: 'system', subtype: 'local_command_output')
// ============================================================================

/** 本地命令（如 slash command）的文本输出。 */
export const SDKLocalCommandOutputMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('local_command_output'),
      content: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKLocalCommandOutputMessage>,
);

// ============================================================================
// SDKHookStartedMessage (type: 'system', subtype: 'hook_started')
// ============================================================================

/** Existing static configuration diagnostics, independent of execution events. */
export const SDKHookDiagnosticsMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('hook_diagnostics'),
      read_status: z.enum(['complete', 'partial', 'failed']),
      checked_at: z.string(),
      diagnostics: z.array(
        z.object({
          code: z.enum([
            'hook_validation_error',
            'settings_load_error',
            'plugin_hook_load_error',
            'hook_reload_error',
          ]),
          message: z.string(),
          event: z.string().optional(),
          field: z.string().optional(),
          hook_ref: z.string().optional(),
        }),
      ),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKHookDiagnosticsMessage>,
);

/** Hook 开始执行通知。 */
export const SDKHookStartedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('hook_started'),
      hook_id: z.string(),
      hook_name: z.string(),
      hook_event: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKHookStartedMessage>,
);

// ============================================================================
// SDKHookProgressMessage (type: 'system', subtype: 'hook_progress')
// ============================================================================

/** Hook 执行中间输出。 */
export const SDKHookProgressMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('hook_progress'),
      hook_id: z.string(),
      hook_name: z.string(),
      hook_event: z.string(),
      stdout: z.string(),
      stderr: z.string(),
      output: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKHookProgressMessage>,
);

// ============================================================================
// SDKHookResponseMessage (type: 'system', subtype: 'hook_response')
// ============================================================================

/** Hook 执行完成响应，包含退出码和结果。 */
export const SDKHookResponseMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('hook_response'),
      hook_id: z.string(),
      hook_name: z.string(),
      hook_event: z.string(),
      output: z.string(),
      stdout: z.string(),
      stderr: z.string(),
      exit_code: z.number().optional(),
      outcome: z.enum(['success', 'error', 'cancelled']),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKHookResponseMessage>,
);

// ============================================================================
// SDKTaskNotificationMessage (type: 'system', subtype: 'task_notification')
// ============================================================================

/** 子任务完成/失败/停止通知。 */
export const SDKTaskNotificationMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('task_notification'),
      task_id: z.string(),
      tool_use_id: z.string().optional(),
      status: z.enum(['completed', 'failed', 'stopped']),
      output_file: z.string(),
      summary: z.string(),
      usage: z
        .object({
          total_tokens: z.number().optional(),
          tool_uses: z.number(),
          duration_ms: z.number(),
        })
        .optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKTaskNotificationMessage>,
);

// ============================================================================
// SDKTaskStartedMessage (type: 'system', subtype: 'task_started')
// ============================================================================

/** 子任务启动通知。 */
export const SDKTaskStartedMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('task_started'),
      task_id: z.string(),
      tool_use_id: z.string().optional(),
      description: z.string(),
      task_type: z.string().optional(),
      subagent_type: z.string().optional(),
      workflow_name: z.string().optional(),
      prompt: z.string().optional(),
      tools: z.array(z.string()).optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKTaskStartedMessage>,
);

// ============================================================================
// SDKTaskProgressMessage (type: 'system', subtype: 'task_progress')
// ============================================================================

/** 子任务执行进度更新。 */
export const SDKTaskProgressMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('task_progress'),
      task_id: z.string(),
      tool_use_id: z.string().optional(),
      description: z.string(),
      usage: z
        .object({
          total_tokens: z.number().optional(),
          tool_uses: z.number(),
          duration_ms: z.number(),
        })
        .optional(),
      last_tool_name: z.string().optional(),
      subagent_type: z.string().optional(),
      summary: z.string().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKTaskProgressMessage>,
);

export const SDKTaskUpdatedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('task_updated'),
    task_id: z.string(),
    patch: z.object({
      status: z
        .enum(['pending', 'running', 'completed', 'failed', 'killed', 'paused'])
        .optional(),
      description: z.string().optional(),
      end_time: z.number().optional(),
      total_paused_ms: z.number().optional(),
      error: z.string().optional(),
      is_backgrounded: z.boolean().optional(),
    }),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
);

export const SDKBackgroundTasksChangedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('background_tasks_changed'),
    tasks: z.array(
      z.object({
        task_id: z.string(),
        task_type: z.string(),
        description: z.string(),
      }),
    ),
    uuid: UUIDPlaceholder(),
    session_id: z.string(),
  }),
);

// ============================================================================
// SDKBridgeStateMessage (type: 'system', subtype: 'bridge_state')
// ============================================================================

/** Bridge 状态变更通知。 */
export const SDKBridgeStateMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('bridge_state'),
      state: z.string(),
      detail: z.string().optional(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKBridgeStateMessage>,
);

// ============================================================================
// SDKFilesPersistedEvent (type: 'system', subtype: 'files_persisted')
// ============================================================================

/** 文件持久化完成事件。报告成功和失败的文件列表。 */
export const SDKFilesPersistedEventSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('files_persisted'),
      files: z.array(
        z.object({
          filename: z.string(),
          file_id: z.string(),
        }),
      ),
      failed: z.array(
        z.object({
          filename: z.string(),
          error: z.string(),
        }),
      ),
      processed_at: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKFilesPersistedEvent>,
);

// ============================================================================
// SDKElicitationCompleteMessage (type: 'system', subtype: 'elicitation_complete')
// ============================================================================

/** MCP elicitation 完成通知。 */
export const SDKElicitationCompleteMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('elicitation_complete'),
      mcp_server_name: z.string(),
      elicitation_id: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKElicitationCompleteMessage>,
);

// ============================================================================
// SDKPromptSuggestionMessage (type: 'prompt_suggestion')
// ============================================================================

/** 提示建议消息。 */
export const SDKPromptSuggestionMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('prompt_suggestion'),
      suggestion: z.string(),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<ProtoSDKPromptSuggestionMessage>,
);

// ============================================================================
// SDKCommandLifecycleMessage (type: 'command_lifecycle')
// ============================================================================

export const SDKCommandLifecycleMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('command_lifecycle'),
      command_uuid: z.string(),
      state: z.enum([
        'queued',
        'started',
        'completed',
        'cancelled',
        'discarded',
      ]),
      uuid: UUIDPlaceholder(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKCommandLifecycleMessage>,
);

export const SDKControlRequestProgressMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('control_request_progress'),
      request_id: z.string(),
      status: z.enum(['started', 'api_retry']),
      attempt: z.number().int().optional(),
      max_retries: z.number().int().optional(),
      retry_delay_ms: z.number().optional(),
      error_status: z.number().nullable().optional(),
      uuid: z.string(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKControlRequestProgressMessage>,
);

// ============================================================================
// SDKMessage — 顶层 union
// ============================================================================

/**
 * 所有 SDK 线协议消息的联合类型，按 `type`（+ `subtype`）区分。
 * z.union 的顺序有讲究——更严格的 schema 要排前面（如 Replay 在 User 前）。
 *
 * 完整对齐 `../wire/messages.ts` 的 `SDKMessage`。
 */
export const SDKMessageSchema = lazySchema(
  () =>
    z.union([
      // --- Core agentic loop messages ---
      SDKHostToolUseMessageSchema(),
      SDKHostToolResultMessageSchema(),
      SDKAssistantMessageSchema(),
      SDKUserMessageReplaySchema(),
      SDKUserMessageSchema(),
      SDKResultMessageSchema(),
      SDKPartialAssistantMessageSchema(),
      // --- System messages (type: 'system', discriminated by subtype) ---
      SDKSystemMessageSchema(),
      SDKArtifactUpdateMessageSchema(),
      SDKAvailableModelsUpdateMessageSchema(),
      SDKCommandsChangedMessageSchema(),
      SDKStatusMessageSchema(),
      SDKPermissionDeniedMessageSchema(),
      SDKSessionStateChangedMessageSchema(),
      SDKPlanModeChangedMessageSchema(),
      SDKGoalUpdatedMessageSchema(),
      SDKGoalClearedMessageSchema(),
      SDKSessionTitleChangedMessageSchema(),
      SDKCompactBoundaryMessageSchema(),
      SDKAPIRetryMessageSchema(),
      SDKLocalCommandOutputMessageSchema(),
      SDKHookDiagnosticsMessageSchema(),
      SDKHookStartedMessageSchema(),
      SDKHookProgressMessageSchema(),
      SDKHookResponseMessageSchema(),
      SDKTaskNotificationMessageSchema(),
      SDKTaskStartedMessageSchema(),
      SDKTaskProgressMessageSchema(),
      SDKToolProgressMessageSchema(),
      SDKBackgroundTasksChangedMessageSchema(),
      SDKTaskUpdatedMessageSchema(),
      SDKBridgeStateMessageSchema(),
      SDKFilesPersistedEventSchema(),
      SDKElicitationCompleteMessageSchema(),
      SDKPromptSuggestionMessageSchema(),
      SDKCommandLifecycleMessageSchema(),
      SDKSkillEvolutionMessageSchema(),
      SDKAgentsMdSizeWarningMessageSchema(),
      SDKControlRequestProgressMessageSchema(),
    ]) satisfies z.ZodType<SDKMessage>,
);

export const SDKAgentsMdSizeWarningMessageSchema = lazySchema(
  () =>
    z.object({
      type: z.literal('system'),
      subtype: z.literal('agents_md_size_warning'),
      code: z.literal('AGENTS_MD_SIZE_THRESHOLD_REACHED'),
      severity: z.literal('warning'),
      total_bytes: z.number().int().nonnegative(),
      threshold_bytes: z.number().int().positive(),
      threshold_source: z.enum(['qcs', 'default']),
      files: z.array(
        z.object({ path: z.string(), bytes: z.number().int().nonnegative() }),
      ),
      load_status: z.enum(['complete', 'partial']),
      truncated: z.literal(false),
      uuid: z.string(),
      session_id: z.string(),
    }) satisfies z.ZodType<SDKAgentsMdSizeWarningMessage>,
);

/** 工具耗时通知；显式订阅时可附带前台命令的有界替换预览。 */
export const SDKToolProgressMessageSchema = lazySchema(() => z.object({
  type: z.literal('tool_progress'),
  parent_tool_use_id: z.string().nullable(),
  elapsed_time_seconds: z.number().int().nonnegative(),
  task_id: z.string().optional(),
  heartbeat: z.boolean().optional(),
  uuid: z.string().min(1),
  session_id: z.string().min(1),
  tool_use_id: z.string().min(1),
  tool_name: z.string().min(1),
  execution_id: z.string().min(1).optional(),
  progress_sequence: z.number().int().positive().optional(),
  phase: z.enum(['running', 'ended']).optional(),
  started_at_ms: z.number().finite().nonnegative().optional(),
  elapsed_ms: z.number().finite().nonnegative().optional(),
  output: z.string().refine(value => new TextEncoder().encode(value).length <= SHELL_OUTPUT_PREVIEW_MAX_BYTES).optional(),
  total_bytes: z.number().int().nonnegative().optional(),
  total_lines: z.number().int().nonnegative().optional(),
  preview_truncated: z.boolean().optional(),
  mcp: z.object({
    server_name: z.string(),
    progress: z.number().finite(),
    total: z.number().finite().optional(),
    message: z.string().optional(),
  }).optional(),
}));
export type SDKToolProgressMessage = z.infer<ReturnType<typeof SDKToolProgressMessageSchema>>;
