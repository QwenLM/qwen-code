/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDKMessage — the JSONL line format the CLI emits to stdout.
 *
 * Single source of truth for both the CLI (which writes them) and the SDK
 * (which parses them). CLI-side zod schemas in
 * `@google/gemini-cli-core/protocol/schemas` are kept aligned via
 * `satisfies z.ZodType<...>` against these types.
 */
import type { BetaMessage, BetaRawMessageStreamEvent, MessageParam, UUID, SDKAssistantMessageError, FastModeState, ApiKeySource, ModelUsage, NonNullableUsage, PluginInfo, SDKStatus } from './common.js';
import type { PermissionMode } from './permissions.js';
export type SDKAssistantMessage = {
    type: 'assistant';
    message: BetaMessage;
    parent_tool_use_id: string | null;
    error?: SDKAssistantMessageError;
    uuid: UUID;
    session_id: string;
};
export type SDKUserMessage = {
    type: 'user';
    message: MessageParam;
    parent_tool_use_id: string | null;
    file_attachments?: SDKFileAttachment[];
    isSynthetic?: boolean;
    tool_use_result?: unknown;
    priority?: 'now' | 'next' | 'later';
    timestamp?: string;
    uuid?: UUID;
    session_id?: string;
};
export type SDKUserMessageReplay = {
    type: 'user';
    message: MessageParam;
    parent_tool_use_id: string | null;
    file_attachments?: SDKFileAttachment[];
    isSynthetic?: boolean;
    tool_use_result?: unknown;
    priority?: 'now' | 'next' | 'later';
    timestamp?: string;
    uuid: UUID;
    session_id: string;
    isReplay: true;
};
export type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    result: string;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    structured_output?: unknown;
    deferred_tool_use?: unknown;
    terminal_reason?: string | null;
    fast_mode_state?: FastModeState;
    uuid: UUID;
    session_id: string;
};
export type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    errors: string[];
    terminal_reason?: string | null;
    fast_mode_state?: FastModeState;
    uuid: UUID;
    session_id: string;
};
export type SDKFileAttachment = {
    file_id: string;
    relative_path: string;
};
export type SDKResultMessage = SDKResultSuccess | SDKResultError;
export type SDKSystemMessage = {
    type: 'system';
    subtype: 'init';
    agents?: string[];
    apiKeySource: ApiKeySource;
    /**
     * Wire protocol version (`WIRE_PROTOCOL_VERSION` from `src/protocol/version.ts`).
     *
     * Optional for backward compatibility with older CLIs that predate the
     * handshake — the SDK falls back to a warning when absent. New CLI
     * builds always emit this field.
     */
    protocol_version?: string;
    cwd: string;
    tools: string[];
    mcp_servers: Array<{
        name: string;
        status: string;
    }>;
    model: string;
    permissionMode: PermissionMode;
    slash_commands: string[];
    output_style: string;
    skills: string[];
    plugins: PluginInfo[];
    fast_mode_state?: FastModeState;
    uuid: UUID;
    session_id: string;
};
export type SDKPartialAssistantMessage = {
    type: 'stream_event';
    event: BetaRawMessageStreamEvent;
    parent_tool_use_id: string | null;
    uuid: UUID;
    session_id: string;
};
export type SDKCompactBoundaryMessage = {
    type: 'system';
    subtype: 'compact_boundary';
    compact_metadata: {
        trigger: 'manual' | 'auto';
        pre_tokens: number;
        preserved_segment?: {
            head_uuid: UUID;
            anchor_uuid: UUID;
            tail_uuid: UUID;
        };
    };
    uuid: UUID;
    session_id: string;
};
export type SDKStatusMessage = {
    type: 'system';
    subtype: 'status';
    status: SDKStatus;
    permissionMode?: PermissionMode;
    uuid: UUID;
    session_id: string;
};
export type SDKAPIRetryMessage = {
    type: 'system';
    subtype: 'api_retry';
    attempt: number;
    max_retries: number;
    retry_delay_ms: number;
    error_status: number | null;
    error: SDKAssistantMessageError;
    uuid: UUID;
    session_id: string;
};
export type SDKLocalCommandOutputMessage = {
    type: 'system';
    subtype: 'local_command_output';
    content: string;
    uuid: UUID;
    session_id: string;
};
export type SDKHookStartedMessage = {
    type: 'system';
    subtype: 'hook_started';
    hook_id: string;
    hook_name: string;
    hook_event: string;
    uuid: UUID;
    session_id: string;
};
export type SDKHookProgressMessage = {
    type: 'system';
    subtype: 'hook_progress';
    hook_id: string;
    hook_name: string;
    hook_event: string;
    stdout: string;
    stderr: string;
    output: string;
    uuid: UUID;
    session_id: string;
};
export type SDKHookResponseMessage = {
    type: 'system';
    subtype: 'hook_response';
    hook_id: string;
    hook_name: string;
    hook_event: string;
    output: string;
    stdout: string;
    stderr: string;
    exit_code?: number;
    outcome: 'success' | 'error' | 'cancelled';
    uuid: UUID;
    session_id: string;
};
export type SDKTaskNotificationMessage = {
    type: 'system';
    subtype: 'task_notification';
    task_id: string;
    tool_use_id?: string;
    status: 'completed' | 'failed' | 'stopped';
    output_file: string;
    summary: string;
    usage?: {
        total_tokens?: number;
        tool_uses: number;
        duration_ms: number;
    };
    uuid: UUID;
    session_id: string;
};
export type SDKTaskStartedMessage = {
    type: 'system';
    subtype: 'task_started';
    task_id: string;
    tool_use_id?: string;
    description: string;
    task_type?: string;
    workflow_name?: string;
    prompt?: string;
    uuid: UUID;
    session_id: string;
};
export type SDKTaskProgressMessage = {
    type: 'system';
    subtype: 'task_progress';
    task_id: string;
    tool_use_id?: string;
    description: string;
    usage?: {
        total_tokens?: number;
        tool_uses: number;
        duration_ms: number;
    };
    last_tool_name?: string;
    summary?: string;
    uuid: UUID;
    session_id: string;
};
export type SDKSessionStateChangedMessage = {
    type: 'system';
    subtype: 'session_state_changed';
    state: 'idle' | 'running' | 'requires_action';
    uuid: UUID;
    session_id: string;
};
/**
 * Session title update. Emitted only when the host negotiated support.
 * (Was missing on the SDK side before protocol extraction.)
 */
export type SDKSessionTitleChangedMessage = {
    type: 'system';
    subtype: 'session_title_changed';
    title: string;
    source: 'ai' | 'custom';
    revision: number;
    uuid: UUID;
    session_id: string;
};
export type SDKBridgeStateMessage = {
    type: 'system';
    subtype: 'bridge_state';
    state: string;
    detail?: string;
    uuid: UUID;
    session_id: string;
};
export type SDKFilesPersistedEvent = {
    type: 'system';
    subtype: 'files_persisted';
    files: Array<{
        filename: string;
        file_id: string;
    }>;
    failed: Array<{
        filename: string;
        error: string;
    }>;
    processed_at: string;
    uuid: UUID;
    session_id: string;
};
export type SDKElicitationCompleteMessage = {
    type: 'system';
    subtype: 'elicitation_complete';
    mcp_server_name: string;
    elicitation_id: string;
    uuid: UUID;
    session_id: string;
};
export type SDKPromptSuggestionMessage = {
    type: 'prompt_suggestion';
    suggestion: string;
    uuid: UUID;
    session_id: string;
};
export type SDKCloudAgentEventMessage = {
    type: 'cloud_agent_event';
    event: string;
    id?: string;
    data: unknown;
    uuid: UUID;
    session_id: string;
};
export type SDKPermissionDenial = {
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
    message?: string;
    decision_reason_type?: SDKPermissionDeniedReasonType;
    decision_reason?: string;
};
export type SDKPermissionDeniedReasonType = 'rule' | 'mode' | 'subcommandResults' | 'permissionPromptTool' | 'hook' | 'asyncAgent' | 'sandboxOverride' | 'workingDir' | 'safetyCheck' | 'classifier' | 'other';
export type SDKPermissionDeniedMessage = {
    type: 'system';
    subtype: 'permission_denied';
    tool_name: string;
    tool_use_id: string;
    message: string;
    uuid: UUID;
    session_id: string;
    agent_id?: string;
    decision_reason_type?: SDKPermissionDeniedReasonType;
    decision_reason?: string;
};
export type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPermissionDeniedMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | SDKAPIRetryMessage | SDKLocalCommandOutputMessage | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskProgressMessage | SDKSessionStateChangedMessage | SDKSessionTitleChangedMessage | SDKBridgeStateMessage | SDKFilesPersistedEvent | SDKElicitationCompleteMessage | SDKPromptSuggestionMessage | SDKCloudAgentEventMessage;