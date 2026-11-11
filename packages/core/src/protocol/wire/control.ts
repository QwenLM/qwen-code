/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Control protocol (bidirectional CLI ↔ SDK requests outside the agentic
 * loop): permission prompts, model switches, MCP management, hooks, etc.
 *
 * Wire envelope is `control_request` / `control_response` /
 * `control_cancel_request` / `control_cancel`. Inner request payloads are
 * discriminated by `type` (with some legacy `subtype` variants).
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { HookEvent, HookInput } from './hooks.js';
import type { McpServerStatus, McpSetServersResult, McpServerStatusConfig, McpServerConfigForProcessTransport, OAuthToken } from './mcp.js';
import type { PermissionMode, PermissionUpdate } from './permissions.js';
import type { SDKMessage } from './messages.js';
import type { AgentDefinition, AgentInfo } from './agents.js';
import type { AccountInfo, FastModeState, ModelInfo, SlashCommand, SdkPluginConfig } from './common.js';
export type SDKControlRequest = {
    type: 'control_request';
    request_id: string;
    request: SDKControlRequestInner;
};
type ControlSuccessResponse = {
    subtype: 'success';
    request_id: string;
    response?: Record<string, unknown>;
};
type ControlErrorResponse = {
    subtype: 'error';
    request_id: string;
    error: string;
    pending_permission_requests?: SDKControlRequest[];
};
export type SDKControlResponse = {
    type: 'control_response';
    response: ControlSuccessResponse | ControlErrorResponse;
};
export type SDKControlCancelRequest = {
    type: 'control_cancel_request' | 'control_cancel';
    request_id: string;
};
export type SDKControlInterruptRequest = {
    type: 'interrupt';
};
export type SDKControlConfirmationDetails = Record<string, unknown> & {
    type?: string;
    title?: string;
    planPath?: string;
    planContent?: string;
};
export type SDKControlPermissionRequest = {
    subtype: 'can_use_tool';
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: PermissionUpdate[];
    blocked_path?: string;
    decision_reason?: string;
    title?: string;
    display_name?: string;
    description?: string;
    tool_use_id: string;
    agent_id?: string;
    /** Rich confirmation details for tool-specific approval UX. */
    details?: SDKControlConfirmationDetails;
    /** ExitPlanMode plan path on disk (when tool_name === 'ExitPlanMode'). */
    plan_path?: string;
    /** ExitPlanMode plan body (when tool_name === 'ExitPlanMode'). */
    plan_content?: string;
} | {
    type: 'permission_response';
    tool_name: string;
    tool_input: Record<string, unknown>;
    suggestions?: PermissionUpdate[];
    blocked_path?: string;
    decision_reason?: string;
    title?: string;
    display_name?: string;
    description?: string;
    tool_use_id: string;
    agent_id?: string;
    details?: SDKControlConfirmationDetails;
    plan_path?: string;
    plan_content?: string;
};
/**
 * Wire form of MCP server config sent by SDK in `initialize` and
 * `mcp_set_servers` requests. Excludes the in-process variant
 * (`McpSdkServerConfigWithInstance`) because that carries a runtime
 * `McpServer` instance — the SDK substitutes a `McpSdkServerConfig`
 * (just `{ type: 'sdk', name }`) on the wire and registers the instance
 * locally.
 */
export type ControlMcpServerConfig = McpServerConfigForProcessTransport | McpServerStatusConfig;
export type SDKControlInitializeRequest = {
    type: 'initialize';
    model?: string;
    cwd?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    mcpServers?: Record<string, ControlMcpServerConfig>;
    agents?: Record<string, AgentDefinition>;
    plugins?: SdkPluginConfig[];
    systemPrompt?: string;
    appendSystemPrompt?: string;
    excludeDynamicSections?: boolean;
    permissionMode?: PermissionMode;
    maxThinkingTokens?: number;
    enableFileCheckpointing?: boolean;
    sdkMcpServers?: string[];
    jsonSchema?: Record<string, unknown>;
    promptSuggestions?: boolean;
    agentProgressSummaries?: boolean;
    hooks?: Partial<Record<HookEvent, Array<{
        hookCallbackIds: string[];
        timeout?: number;
        matcher?: string;
    }>>>;
    /**
     * Scene identifier for model filtering (e.g. 'quest', 'assistant').
     * @deprecated The SDK no longer sends this field; scene is now driven by
     * the `ENV_SCENE` environment variable at CLI process boot. Kept for
     * backward compatibility with older SDK versions.
     */
    scene?: string;
};
export type SDKControlSetPermissionModeRequest = {
    type: 'set_permission_mode';
    mode: PermissionMode;
};
export type SDKControlSetModelRequest = {
    type: 'set_model';
    model: string;
};
export const QoderModelPurpose = {
    /** 主对话 LLM 调用 */
  Main: 'main',
    /** 规划阶段调用 */
  Plan: 'plan',
    /** 子任务执行 */
  Task: 'task',
    /** 上下文压缩/摘要 */
  Compact: 'compact',
    /** 标题生成 */
  Title: 'title',
    /** 提示建议生成 */
  Suggestion: 'suggestion',
    /** 独立生成（非对话模式） */
  Generate: 'generate',
    /** Hook prompt 执行 */
  HookPrompt: 'hook_prompt',
    /** 子代理（subagent）调用 */
  Subagent: 'subagent',
    /** WebFetch 工具触发的 LLM 调用 */
  WebFetch: 'web_fetch',
    /** ImageGen 工具触发的 LLM 调用 */
  ImageGen: 'image_gen',
    /** 上下文压缩触发的 LLM 调用 */
  Compression: 'compression',
    /** 辅助性调用（兜底） */
  Utility: 'utility',
} as const;
export type QoderModelPurpose = (typeof QoderModelPurpose)[keyof typeof QoderModelPurpose];
/**
 * CLI sends this before each LLM request to ask the SDK which model to use.
 * The SDK delegates to the host's `resolveModel` callback.
 */
export type SDKControlGetModelPolicyRequest = {
    type: 'get_model_policy';
    /** The purpose of this LLM request. */
    purpose: QoderModelPurpose;
    /** Current session ID. */
    sessionId: string;
    /** Current conversation turn index. */
    turnIndex: number;
    /** Current agent ID (for subagent scenarios). */
    agentId?: string;
    /** Context window usage ratio (0~1). */
    contextUsage?: number;
    /** Estimated input token count for this prompt. */
    estimatedInputTokens?: number;
    /** Estimated output token count for this prompt. */
    estimatedOutputTokens?: number;
    /** Retry information when retrying after a failure. */
    retry?: {
        attempt: number;
        lastError: string;
        lastModelId: string;
    };
    /** Currently available models. Provided by CLI on each request. */
    models?: ModelInfo[];
};
/**
 * SDK responds with the model the CLI should use for this request.
 */
export type SDKControlGetModelPolicyResponse = {
    type: 'get_model_policy';
    /** The model to use for this request. */
    model: string;
    /** Optional parameter overrides (temperature, max_tokens, etc.). */
    parameters?: Record<string, unknown>;
    /**
     * Optional per-call BYOK credential payload. When present, the CLI
     * dispatches the LLM request through the third-party provider using
     * the supplied API key instead of the default upstream.
     */
    custom_model?: CustomModel;
};
export type SDKControlSetMaxThinkingTokensRequest = {
    type: 'set_max_thinking_tokens';
    max_thinking_tokens: number | null;
};
export type SDKControlMcpStatusRequest = {
    type: 'mcp_status';
};
export type SDKControlGetContextUsageRequest = {
    type: 'get_context_usage';
};
export type SDKControlAccountInfoRequest = {
    type: 'account_info';
};
export type SDKHookCallbackRequest = {
    subtype: 'hook_callback';
    callback_id: string;
    input: HookInput;
    tool_use_id?: string;
} | {
    type: 'hook_callback';
    hook_id: string;
    hook_event: HookEvent;
    input: HookInput;
    tool_use_id?: string;
};
export type SDKControlMcpMessageRequest = {
    subtype: 'mcp_message';
    server_name: string;
    message: JSONRPCMessage;
} | {
    type: 'mcp_message';
    server_name: string;
    message: JSONRPCMessage;
};
export type SDKControlRewindFilesRequest = {
    type: 'rewind_files';
    user_message_id: string;
    dry_run?: boolean;
};
export type SDKControlCancelAsyncMessageRequest = {
    type: 'cancel_async_message';
    message_id: string;
};
export type SDKControlSeedReadStateRequest = {
    type: 'seed_read_state';
    path: string;
    mtime: number;
};
export type SDKControlMcpSetServersRequest = {
    type: 'mcp_set_servers';
    servers: Record<string, ControlMcpServerConfig>;
};
export type SDKControlReloadPluginsRequest = {
    type: 'reload_plugins';
};
export type SDKControlMcpReconnectRequest = {
    type: 'mcp_reconnect';
    serverName: string;
};
export type SDKControlMcpToggleRequest = {
    type: 'mcp_toggle';
    serverName: string;
    enabled: boolean;
};
export type SDKControlApplyFlagSettingsRequest = {
    type: 'apply_flag_settings';
    settings: Record<string, unknown>;
};
export type SDKControlGetSettingsRequest = {
    type: 'get_settings';
};
export type SDKControlElicitationRequest = {
    subtype: 'elicitation';
    mcp_server_name: string;
    message: string;
    mode?: 'form' | 'url';
    url?: string;
    elicitation_id?: string;
    requested_schema?: Record<string, unknown>;
    title?: string;
    display_name?: string;
    description?: string;
} | {
    type: 'elicitation_response';
    elicitation_id: string;
    prompt: string;
    options?: string[];
    tool_use_id?: string;
};
export type SDKControlStopTaskRequest = {
    type: 'stop_task';
    task_id: string;
};
export type SDKControlEndSessionRequest = {
    type: 'end_session';
    reason?: string;
};
export type SDKControlChannelEnableRequest = {
    type: 'channel_enable';
    channel: string;
    enabled: boolean;
};
/**
 * SDK requests the CLI's BYOK (Bring Your Own Key) configuration.
 * The CLI responds with the server-side provider/model catalog.
 */
export type SDKControlGetByokConfigRequest = {
    type: 'get_byok_config';
};
/**
 * Response to `get_byok_config`. Contains the BYOK provider catalog
 * from the server.
 */
export type SDKControlGetByokConfigResponse = {
    providers: BYOKProviderInfo[];
};
/** A third-party LLM provider in the BYOK catalog. */
export type BYOKProviderInfo = {
    /** Provider identifier, e.g. "openai", "deepseek" */
    key: string;
    /** Display name (may be localized object or plain string) */
    display_name: string;
    /** URL where the user can obtain an API key */
    api_key_url: string;
    /** Base URL for inference requests */
    url: string;
    /** Fields the user must fill in */
    fields: BYOKFieldInfo[];
    /** Model groups offered by this provider */
    types: BYOKModelTypeInfo[];
};
/** A required field for a BYOK provider (e.g. "api_key"). */
export type BYOKFieldInfo = {
    key: string;
    display_name: string;
    type: string;
    /** Whether the user must fill this field. */
    mandatory?: boolean;
};
/** A model group within a provider (e.g. "Chat", "Reasoning"). */
export type BYOKModelTypeInfo = {
    /** Group identifier, e.g. "cp" (coding plan), "tp" (token plan), "pg" (pay-as-you-go). */
    key?: string;
    display_name: string;
    models: BYOKModelInfo[];
};
/** A specific model offered by a BYOK provider. */
export type BYOKModelInfo = {
    key: string;
    display_name: string;
    is_vl: boolean;
    is_reasoning: boolean;
    format: string;
    max_input_tokens: number;
    /** Explicit reasoning effort levels supported. */
    efforts?: string[];
    /** Whether this model supports disabling thinking explicitly. */
    supports_disabled?: boolean;
};
/**
 * Per-call BYOK credential payload returned by `resolveModel`.
 *
 * Defined in the SDK protocol module so public npm builds do not depend on
 * internal protocol packages. When the host attaches
 * `custom_model` to a `ModelPolicyResult`, the SDK forwards it to the CLI
 * on the wire so the CLI dispatches the LLM call through the third-party
 * provider with the supplied API key.
 *
 * NOTE: `style` defaults to `"openai"` — the SDK fills the default before
 * forwarding to the CLI, so the CLI always receives an explicit value.
 */
export type CustomModel = {
    /** BYOK provider identifier, e.g. "openai", "deepseek", "kimi". */
    provider: string;
    /** User-provided third-party API key. */
    api_key: string;
    /** Third-party model identifier, typically matching the outer model value. */
    model?: string;
    /** Optional provider base URL override. */
    url?: string;
    /** Provider wire format. The SDK defaults this to "openai" before forwarding. */
    style?: string;
};
export type SDKControlMcpInjectTokenRequest = {
    type: 'mcp_inject_token';
    serverName: string;
    token: OAuthToken;
};
export type SDKControlMcpAuthenticateRequest = {
    type: 'mcp_authenticate';
    serverName: string;
    redirectUri?: string;
};
export type SDKControlMcpOAuthCallbackUrlRequest = {
    type: 'mcp_oauth_callback_url';
    serverName: string;
    callbackUrl: string;
};
export type SDKControlMcpClearAuthRequest = {
    type: 'mcp_clear_auth';
    serverName: string;
};
export type SDKControlRequestInner = SDKControlInterruptRequest | SDKControlPermissionRequest | SDKControlInitializeRequest | SDKControlSetPermissionModeRequest | SDKControlSetModelRequest | SDKControlSetMaxThinkingTokensRequest | SDKControlMcpStatusRequest | SDKControlGetContextUsageRequest | SDKControlGetModelPolicyRequest | SDKControlAccountInfoRequest | SDKHookCallbackRequest | SDKControlMcpMessageRequest | SDKControlRewindFilesRequest | SDKControlCancelAsyncMessageRequest | SDKControlSeedReadStateRequest | SDKControlMcpSetServersRequest | SDKControlReloadPluginsRequest | SDKControlMcpReconnectRequest | SDKControlMcpToggleRequest | SDKControlApplyFlagSettingsRequest | SDKControlGetSettingsRequest | SDKControlElicitationRequest | SDKControlStopTaskRequest | SDKControlEndSessionRequest | SDKControlChannelEnableRequest | SDKControlMcpInjectTokenRequest | SDKControlMcpAuthenticateRequest | SDKControlMcpOAuthCallbackUrlRequest | SDKControlMcpClearAuthRequest | SDKControlGetByokConfigRequest;
export type SDKControlInitializeResponse = {
    commands: SlashCommand[];
    agents: AgentInfo[];
    output_style: string;
    available_output_styles: string[];
    models: ModelInfo[];
    account: AccountInfo;
    fast_mode_state?: FastModeState;
};
export type SDKControlGetContextUsageResponse = {
    categories: Array<{
        name: string;
        tokens: number;
        color: string;
        isDeferred?: boolean;
    }>;
    totalTokens: number;
    maxTokens: number;
    rawMaxTokens: number;
    percentage: number;
    gridRows: Array<Array<{
        color: string;
        isFilled: boolean;
        categoryName: string;
        tokens: number;
        percentage: number;
        squareFullness: number;
    }>>;
    model: string;
    memoryFiles: Array<{
        path: string;
        type: string;
        tokens: number;
    }>;
    mcpTools: Array<{
        name: string;
        serverName: string;
        tokens: number;
        isLoaded?: boolean;
    }>;
    deferredBuiltinTools?: Array<{
        name: string;
        tokens: number;
        isLoaded: boolean;
    }>;
    systemTools?: Array<{
        name: string;
        tokens: number;
    }>;
    systemPromptSections?: Array<{
        name: string;
        tokens: number;
    }>;
    agents: Array<{
        agentType: string;
        source: string;
        tokens: number;
    }>;
    slashCommands?: {
        totalCommands: number;
        includedCommands: number;
        tokens: number;
    };
    skills?: {
        totalSkills: number;
        includedSkills: number;
        tokens: number;
        skillFrontmatter: Array<{
            name: string;
            source: string;
            tokens: number;
        }>;
    };
    autoCompactThreshold?: number;
    isAutoCompactEnabled: boolean;
    messageBreakdown?: {
        toolCallTokens: number;
        toolResultTokens: number;
        attachmentTokens: number;
        assistantMessageTokens: number;
        userMessageTokens: number;
        toolCallsByType: Array<{
            name: string;
            callTokens: number;
            resultTokens: number;
        }>;
        attachmentsByType: Array<{
            name: string;
            tokens: number;
        }>;
    };
    apiUsage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens: number;
        cache_read_input_tokens: number;
    } | null;
};
export type SDKControlReloadPluginsResponse = {
    commands: SlashCommand[];
    agents: AgentInfo[];
    plugins: Array<{
        name: string;
        path: string;
        source?: string;
    }>;
    mcpServers: McpServerStatus[];
    error_count: number;
};
export type SDKControlMcpStatusResponse = {
    servers: McpServerStatus[];
};
export type SDKControlMcpSetServersResponse = McpSetServersResult;
export type SDKControlMcpAuthenticateResponse = {
    authUrl?: string;
    requiresUserAction: boolean;
};
export type SDKKeepAliveMessage = {
    type: 'keep_alive';
};
export type StdoutMessage = SDKMessage | SDKControlResponse | SDKControlRequest | SDKControlCancelRequest | SDKKeepAliveMessage;
export {};