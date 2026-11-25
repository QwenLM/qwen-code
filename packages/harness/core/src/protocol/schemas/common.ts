/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDKMessage schemas 的公共构建块。
 *
 * "Placeholder" schemas 用 `z.custom<T>()` 包裹 Anthropic SDK 类型，
 * 只提供 TypeScript 类型推断，不做运行时结构校验。
 * 这是有意为之——provider adapter 层已经保证了数据格式正确，
 * schema 层再校验一遍是纯开销。后续如果需要可以收紧。
 *
 * Source of truth for the **types** is `../wire/common.ts`. Each zod schema
 * here uses `satisfies z.ZodType<X>` so any
 * field-level drift between the schema and the type breaks the CLI build at
 * compile time.
 */

import { z } from 'zod';
import type {
  // Anthropic primitives
  BetaRawMessageStreamEvent as ProtoBetaRawMessageStreamEvent,
  BetaMessage as ProtoBetaMessage,
  MessageParam as ProtoMessageParam,
  // Wire enums / value types
  PermissionMode as ProtoPermissionMode,
  ApiKeySource as ProtoApiKeySource,
  FastModeState as ProtoFastModeState,
  SDKAssistantMessageError as ProtoSDKAssistantMessageError,
  SDKStatus as ProtoSDKStatus,
  SDKPermissionDenial as ProtoSDKPermissionDenial,
  SDKPermissionDeniedReasonType as ProtoSDKPermissionDeniedReasonType,
  PluginInfo as ProtoPluginInfo,
  ModelUsage as ProtoModelUsage,
  NonNullableUsage as ProtoNonNullableUsage,
} from '../wire/index.js';
import { lazySchema } from '../utils/lazySchema.js';

// ---------------------------------------------------------------------------
// Re-export wire-protocol types — single source is `../wire/common.ts`.
// Existing internal imports continue to use `./common.js` or `../schemas/common.js`.
// ---------------------------------------------------------------------------

export type {
  ApiKeySource,
  PermissionMode,
  FastModeState,
  SDKAssistantMessageError,
  SDKStatus,
  PluginInfo,
  BetaRawMessageStreamEvent,
  BetaMessage,
  BetaUsage,
  BetaStopReason,
} from '../wire/index.js';

/** Request-level metering metadata carried alongside token usage. */
export type NonNullableUsage = ProtoNonNullableUsage & {
  credits?: number;
  original_credits?: number;
  billable?: boolean;
};

/** Session credits added to the SDK's existing per-model result shape. */
export type ModelUsage = ProtoModelUsage & {
  credits?: number;
};

export type SDKPermissionDeniedReasonType =
  | ProtoSDKPermissionDeniedReasonType
  | 'repeatedToolCall';

export type SDKToolDenialKind =
  | 'user-rejected'
  | 'permission-rule'
  | 'automode-blocked'
  | 'automode-unavailable'
  | 'automode-parsing-error';

export type SDKToolNonExecutionKind =
  | 'user-rejected'
  | 'permission-rule'
  | 'automode-blocked'
  | 'automode-unavailable'
  | 'automode-parsing-error'
  | 'interrupted'
  | 'cancelled';

/**
 * 外层展示元数据：给 SDK/IDE 消费方的那一份结构化说明——这个结果没有正常工具
 * 输出，原因是什么、用户留了什么话。它与模型可见的 tool_result 文案**并行**：
 * 拒绝话术和用户留言同样会写进 tool_result 内容，这里不是唯一载体，只是外部
 * 消费方不必去解析文案就能拿到的那一份。
 */
export type SDKToolResultMeta = {
  id: string;
  non_execution_kind: SDKToolNonExecutionKind;
  user_feedback?: string;
};

export type SDKPermissionDenial = Omit<
  ProtoSDKPermissionDenial,
  'decision_reason_type'
> & {
  decision_reason_type?: SDKPermissionDeniedReasonType;
  tool_denial_kind?: SDKToolDenialKind;
};

// ---------------------------------------------------------------------------
// Tool permission vocabulary — host-side spellings of the wire enums above
// ---------------------------------------------------------------------------

/**
 * Why a tool call did not run. Set by whichever code made the call — the ask
 * prompt, a rule match, the auto-mode classifier, or execution control — and
 * carried with tool results and classifier transcript outcomes.
 *
 * Never infer it from model- or tool-authored error text: that text is
 * attacker-influenceable, and this value gates behaviour and reporting.
 *
 * This is the wire's `SDKToolNonExecutionKind` under the host's spelling, so
 * the two can never drift apart.
 */
export type ToolDenialKind = SDKToolNonExecutionKind;

/**
 * The subset that is a genuine permission denial. Interruption and
 * cancellation end a call without any permission judgement having been made,
 * so permission summaries must not count them.
 */
export type ToolPermissionDenialKind = SDKToolDenialKind;

// ---------------------------------------------------------------------------
// SDK bidirectional tool permission protocol
//
// When the CLI runs as an SDK subprocess, tool execution requires explicit
// permission from the parent process. The permission protocol works as follows:
//
//   1. query() encounters a tool_use block in the assistant's response
//   2. Before executing, it calls the `canUseTool` callback (if provided)
//   3. The callback sends a `control_request(can_use_tool)` to stdout
//   4. The SDK parent responds with `control_response` (allow/deny)
//   5. If denied, a synthetic error tool_result is created
//   6. If allowed, the tool is executed normally
//
// In TUI mode, the canUseTool callback is either not set (Scheduler handles
// approval internally) or set to a UI-based permission prompt.
// ---------------------------------------------------------------------------

/**
 * Result of a tool permission check in the SDK bidirectional protocol.
 *
 * Internal representation, separate from the SDK wire format
 * (`PermissionResult` with `behavior` / `updatedInput`).
 * Conversion between the two happens in `parsePermissionDecision`.
 */
export interface ToolPermissionDecision {
  /** Whether the tool is allowed to execute. */
  allowed: boolean;
  /**
   * Scope of an allow decision. Omitted means allow this invocation only.
   * Used by repeated-tool-call prompts to support session-scoped exact-call
   * approvals in SDK/headless permission paths.
   */
  permissionScope?: 'once' | 'session';
  /** Reason for denial (only meaningful when allowed=false). */
  reason?: string;
  /** Structured reason category for denial reports and SDK messages. */
  decisionReasonType?: SDKPermissionDeniedReasonType;
  /** Human-readable structured reason detail for denial reports and SDK messages. */
  decisionReason?: string;
  /** Stable denial outcome supplied by the permission decision boundary. */
  toolDenialKind?: ToolDenialKind;
  /**
   * Replacement tool input provided by the SDK parent.
   *
   * When allowed, the agent-loop uses this value instead of the original
   * `block.input`, allowing the SDK to modify parameters before execution.
   */
  updatedInput?: Record<string, unknown>;
}

export interface RepeatedToolCallPermissionContext {
  toolName: string;
  repeatCount: number;
  threshold: number;
  inputKey: string;
  inputPreview: string;
}

export interface ToolPermissionRequestContext {
  permissionKind?: 'tool' | 'repeated_tool_call';
  repeatedToolCall?: RepeatedToolCallPermissionContext;
  decisionReasonType?: ToolPermissionDecision['decisionReasonType'];
  decisionReason?: string;
}

/**
 * Callback invoked before each tool execution to check permission.
 *
 * Implementations:
 *   - SDK mode: sends `control_request(can_use_tool)` to stdout, waits for response
 *   - TUI mode: shows a permission prompt to the user (future)
 *   - Test mode: returns a fixed decision
 *
 * @param toolName  - Name of the tool to be executed (e.g., "Bash", "Write")
 * @param toolInput - Tool input parameters
 * @param toolUseId - Unique ID for this tool invocation (from the assistant's response)
 * @returns Permission decision (allow or deny with optional reason)
 */
export type CanUseToolCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
  context?: ToolPermissionRequestContext,
) => Promise<ToolPermissionDecision>;

/**
 * Told to the model when the PermissionDenied hook reverses a refusal.
 *
 * The hook fires after a denial and may say the command is acceptable after all.
 * The call has already been refused at that point, so the only thing left is to
 * tell the model it may try again — silently retrying would hide a permission
 * decision from the transcript.
 */
export const PERMISSION_DENIED_HOOK_RETRY_MESSAGE =
  'The PermissionDenied hook indicated this command is now approved. You may retry it if you would like.';

// ---------------------------------------------------------------------------
// Placeholder schemas — 只给类型，不做运行时校验
// ---------------------------------------------------------------------------

/**
 * "Branded passthrough" placeholder factory: validates at runtime that the
 * value is non-null/non-undefined (anything else passes), but types it as `T`.
 *
 * Why not `z.custom<T>()`? `z.custom` infers `T | undefined` for required
 * fields, which breaks `satisfies z.ZodType<MessageWithRequiredField>`.
 * `z.unknown().refine(...)` keeps the field strictly required.
 */
function brandedPlaceholder<T>(): z.ZodType<T, z.ZodTypeDef, T> {
  return z
    .unknown()
    .refine((v) => v !== undefined && v !== null) as unknown as z.ZodType<
    T,
    z.ZodTypeDef,
    T
  >;
}

/** 用户消息（Anthropic `MessageParam`）。有 TS 类型，无运行时校验。 */
export const APIUserMessagePlaceholder = lazySchema(() =>
  brandedPlaceholder<ProtoMessageParam>(),
);

/** Assistant 完整回复（`BetaMessage`）。有 TS 类型，无运行时校验。 */
export const APIAssistantMessagePlaceholder = lazySchema(() =>
  brandedPlaceholder<ProtoBetaMessage>(),
);

/** 流式 SSE 事件（`BetaRawMessageStreamEvent`）。有 TS 类型，无运行时校验。 */
export const RawMessageStreamEventPlaceholder = lazySchema(() =>
  brandedPlaceholder<ProtoBetaRawMessageStreamEvent>(),
);

/**
 * UUID 字符串（`crypto.randomUUID` 格式）。
 * Protocol 包把 `UUID` 定义为 `string` 别名，所以这里用 `z.string()` 即可。
 */
export const UUIDPlaceholder = lazySchema(() => z.string());

/** `NonNullableUsage` 的 placeholder。有 TS 类型，无运行时校验。 */
export const NonNullableUsagePlaceholder = lazySchema(() =>
  brandedPlaceholder<NonNullableUsage>(),
);

// ---------------------------------------------------------------------------
// ModelUsage — result 消息里按模型拆分的 token / 花费明细
// ---------------------------------------------------------------------------

export const ModelUsageSchema = lazySchema(
  () =>
    z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      cacheReadInputTokens: z.number(),
      cacheCreationInputTokens: z.number(),
      webSearchRequests: z.number(),
      costUSD: z.number(),
      contextWindow: z.number(),
      maxOutputTokens: z.number(),
      credits: z.number().optional(),
    }) satisfies z.ZodType<ModelUsage>,
);

// ---------------------------------------------------------------------------
// ApiKeySource — API key 的来源
// ---------------------------------------------------------------------------

export const ApiKeySourceSchema = lazySchema(
  () =>
    z.enum([
      'user',
      'project',
      'org',
      'temporary',
      'oauth',
      'none',
    ]) satisfies z.ZodType<ProtoApiKeySource>,
);

// ---------------------------------------------------------------------------
// PermissionMode — 工具执行的权限策略
// ---------------------------------------------------------------------------

/**
 * Modes as they appear on the wire.
 *
 * This list is pinned by the published SDK's `PermissionMode` type, so it is not
 * generated from the component's five names: `bypassPermissions` is the old name
 * for `yolo`, and `plan` was never a permission mode. Callers normalize what
 * arrives with `parsePermissionMode`, which maps both onto the internal
 * vocabulary; aligning the SDK type itself is a change to that package.
 */
export const PermissionModeSchema = lazySchema(
  () =>
    z.enum([
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
      'dontAsk',
      'auto',
    ]) satisfies z.ZodType<ProtoPermissionMode>,
);

// ---------------------------------------------------------------------------
// FastModeState — Haiku 快速模式开关状态
// ---------------------------------------------------------------------------

export const FastModeStateSchema = lazySchema(
  () =>
    z.enum(['off', 'cooldown', 'on']) satisfies z.ZodType<ProtoFastModeState>,
);

// ---------------------------------------------------------------------------
// SDKAssistantMessageError — assistant 消息上的错误分类
// ---------------------------------------------------------------------------

export const SDKAssistantMessageErrorSchema = lazySchema(
  () =>
    z.enum([
      'authentication_failed',
      'billing_error',
      'rate_limit',
      'invalid_request',
      'server_error',
      'unknown',
      'max_output_tokens',
    ]) satisfies z.ZodType<ProtoSDKAssistantMessageError>,
);

// ---------------------------------------------------------------------------
// SDKStatus — 瞬态 session 状态（如 compacting）
// ---------------------------------------------------------------------------

export const SDKStatusSchema = lazySchema(
  () =>
    z.union([
      z.literal('compacting'),
      z.null(),
    ]) satisfies z.ZodType<ProtoSDKStatus>,
);

// ---------------------------------------------------------------------------
// SDKPermissionDenial — 被用户拒绝的工具调用
// ---------------------------------------------------------------------------

export const SDKPermissionDenialSchema = lazySchema(
  () =>
    z.object({
      tool_name: z.string(),
      tool_use_id: z.string(),
      tool_input: z.record(z.string(), z.unknown()),
      message: z.string().optional(),
      decision_reason_type: SDKPermissionDeniedReasonTypeSchema().optional(),
      decision_reason: z.string().optional(),
      tool_denial_kind: SDKToolDenialKindSchema().optional(),
    }) satisfies z.ZodType<SDKPermissionDenial>,
);

export const SDKToolDenialKindSchema = lazySchema(() =>
  z.enum([
    'user-rejected',
    'permission-rule',
    'automode-blocked',
    'automode-unavailable',
    'automode-parsing-error',
  ]),
);

export const SDKToolNonExecutionKindSchema = lazySchema(
  () =>
    z.enum([
      'user-rejected',
      'permission-rule',
      'automode-blocked',
      'automode-unavailable',
      'automode-parsing-error',
      'interrupted',
      'cancelled',
    ]) satisfies z.ZodType<SDKToolNonExecutionKind>,
);

export const SDKToolResultMetaSchema = lazySchema(
  () =>
    z.object({
      id: z.string(),
      non_execution_kind: SDKToolNonExecutionKindSchema(),
      user_feedback: z.string().optional(),
    })
      .describe(
        'Display metadata for tool_result blocks, keyed by tool_use_id. Absent means the tool ran to completion. user_feedback is only present for human-authored permission feedback. This is a wrapper-level sibling and is never replayed to the model.',
      ) satisfies z.ZodType<SDKToolResultMeta>,
);

export const SDKPermissionDeniedReasonTypeSchema = lazySchema(
  () =>
    z.enum([
      'rule',
      'mode',
      'subcommandResults',
      'permissionPromptTool',
      'hook',
      'asyncAgent',
      // Retained for reading sessions written before tool sandbox removal.
      'sandboxOverride',
      'workingDir',
      'safetyCheck',
      'classifier',
      'repeatedToolCall',
      'other',
    ]) satisfies z.ZodType<SDKPermissionDeniedReasonType>,
);

// ---------------------------------------------------------------------------
// PluginInfo — 插件信息（含可选 source）
// ---------------------------------------------------------------------------

export const PluginInfoSchema = lazySchema(
  () =>
    z.object({
      name: z.string(),
      path: z.string(),
      source: z.string().optional(),
    }) satisfies z.ZodType<ProtoPluginInfo>,
);
