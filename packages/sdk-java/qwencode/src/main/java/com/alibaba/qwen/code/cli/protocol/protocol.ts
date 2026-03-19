/* eslint-disable @typescript-eslint/no-explicit-any */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export interface Annotation {
  type: string;
  value: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_tokens?: number;
}

export interface ExtendedUsage extends Usage {
  server_tool_use?: {
    web_search_requests: number;
  };
  service_tier?: string;
  cache_creation?: {
    ephemeral_1h_input_tokens: number;
    ephemeral_5m_input_tokens: number;
  };
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  contextWindow: number;
}

export interface CLIPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
}

export interface TextBlock {
  type: 'text';
  text: string;
  annotations?: Annotation[];
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  annotations?: Annotation[];
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  annotations?: Annotation[];
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  annotations?: Annotation[];
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface APIUserMessage {
  role: 'user';
  content: string | ContentBlock[];
}

export interface APIAssistantMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason?: string | null;
  usage: Usage;
}

export interface SDKUserMessage {
  type: 'user';
  uuid?: string;
  session_id: string;
  message: APIUserMessage;
  parent_tool_use_id: string | null;
  options?: Record<string, unknown>;
}

export interface SDKAssistantMessage {
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: APIAssistantMessage;
  parent_tool_use_id: string | null;
}

export interface SDKSystemMessage {
  type: 'system';
  subtype: string;
  uuid: string;
  session_id: string;
  data?: unknown;
  cwd?: string;
  tools?: string[];
  mcp_servers?: Array<{
    name: string;
    status: string;
  }>;
  model?: string;
  permission_mode?: string;
  slash_commands?: string[];
  qwen_code_version?: string;
  output_style?: string;
  agents?: string[];
  skills?: string[];
  capabilities?: Record<string, unknown>;
  compact_metadata?: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
  };
}

export interface SDKResultMessageSuccess {
  type: 'result';
  subtype: 'success';
  uuid: string;
  session_id: string;
  is_error: false;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  usage: ExtendedUsage;
  modelUsage?: Record<string, ModelUsage>;
  permission_denials: CLIPermissionDenial[];
  [key: string]: unknown;
}

export interface SDKResultMessageError {
  type: 'result';
  subtype: 'error_max_turns' | 'error_during_execution';
  uuid: string;
  session_id: string;
  is_error: true;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  usage: ExtendedUsage;
  modelUsage?: Record<string, ModelUsage>;
  permission_denials: CLIPermissionDenial[];
  error?: {
    type?: string;
    message: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type SDKResultMessage = SDKResultMessageSuccess | SDKResultMessageError;

export interface MessageStartStreamEvent {
  type: 'message_start';
  message: {
    id: string;
    role: 'assistant';
    model: string;
  };
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: ContentBlock;
}

export type ContentBlockDelta =
  | {
      type: 'text_delta';
      text: string;
    }
  | {
      type: 'thinking_delta';
      thinking: string;
    }
  | {
      type: 'input_json_delta';
      partial_json: string;
    };

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentBlockDelta;
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageStopStreamEvent {
  type: 'message_stop';
}

export type StreamEvent =
  | MessageStartStreamEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageStopStreamEvent;

export interface SDKPartialAssistantMessage {
  type: 'stream_event';
  uuid: string;
  session_id: string;
  event: StreamEvent;
  parent_tool_use_id: string | null;
}

export type PermissionMode = 'default' | 'plan' | 'auto-edit' | 'yolo';

/**
 * TODO: Align with `ToolCallConfirmationDetails`
 */
export interface PermissionSuggestion {
  type: 'allow' | 'deny' | 'modify';
  label: string;
  description?: string;
  modifiedInput?: unknown;
}

export interface HookRegistration {
  event: string;
  callback_id: string;
}

export interface HookCallbackResult {
  shouldSkip?: boolean;
  shouldInterrupt?: boolean;
  suppressOutput?: boolean;
  message?: string;
}

export interface CLIControlInterruptRequest {
  subtype: 'interrupt';
}

export interface CLIControlPermissionRequest {
  subtype: 'can_use_tool';
  tool_name: string;
  tool_use_id: string;
  input: unknown;
  permission_suggestions: PermissionSuggestion[] | null;
  blocked_path: string | null;
}

export enum AuthProviderType {
  DYNAMIC_DISCOVERY = 'dynamic_discovery',
  GOOGLE_CREDENTIALS = 'google_credentials',
  SERVICE_ACCOUNT_IMPERSONATION = 'service_account_impersonation',
}

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
  tcp?: string;
  timeout?: number;
  trust?: boolean;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
  extensionName?: string;
  oauth?: Record<string, unknown>;
  authProviderType?: AuthProviderType;
  targetAudience?: string;
  targetServiceAccount?: string;
}

/**
 * SDK MCP Server configuration
 *
 * SDK MCP servers run in the SDK process and are connected via in-memory transport.
 * Tool calls are routed through the control plane between SDK and CLI.
 */
export interface SDKMcpServerConfig {
  /**
   * Type identifier for SDK MCP servers
   */
  type: 'sdk';
  /**
   * Server name for identification and routing
   */
  name: string;
  /**
   * The MCP Server instance created by createSdkMcpServer()
   */
  instance: McpServer;
}

/**
 * Wire format for SDK MCP servers sent to the CLI
 */
export type WireSDKMcpServerConfig = Omit<SDKMcpServerConfig, 'instance'>;

export interface CLIControlInitializeRequest {
  subtype: 'initialize';
  hooks?: HookRegistration[] | null;
  /**
   * SDK MCP servers config
   * These are MCP servers running in the SDK process, connected via control plane.
   * External MCP servers are configured separately in settings, not via initialization.
   */
  sdkMcpServers?: Record<string, WireSDKMcpServerConfig>;
  /**
   * External MCP servers that should be managed by the CLI.
   */
  mcpServers?: Record<string, MCPServerConfig>;
  agents?: SubagentConfig[];
}

export interface CLIControlSetPermissionModeRequest {
  subtype: 'set_permission_mode';
  mode: PermissionMode;
}

export interface CLIHookCallbackRequest {
  subtype: 'hook_callback';
  callback_id: string;
  input: unknown;
  tool_use_id: string | null;
}

export interface CLIControlMcpMessageRequest {
  subtype: 'mcp_message';
  server_name: string;
  message: {
    jsonrpc?: string;
    method: string;
    params?: Record<string, unknown>;
    id?: string | number | null;
  };
}

export interface CLIControlSetModelRequest {
  subtype: 'set_model';
  model: string;
}

export interface CLIControlMcpStatusRequest {
  subtype: 'mcp_server_status';
}

export interface CLIControlSupportedCommandsRequest {
  subtype: 'supported_commands';
}

export type ControlRequestPayload =
  | CLIControlInterruptRequest
  | CLIControlPermissionRequest
  | CLIControlInitializeRequest
  | CLIControlSetPermissionModeRequest
  | CLIHookCallbackRequest
  | CLIControlMcpMessageRequest
  | CLIControlSetModelRequest
  | CLIControlMcpStatusRequest
  | CLIControlSupportedCommandsRequest;

export interface CLIControlRequest {
  type: 'control_request';
  request_id: string;
  request: ControlRequestPayload;
}

export interface PermissionApproval {
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
}

export interface ControlResponse {
  subtype: 'success';
  request_id: string;
  response: unknown;
}

export interface ControlErrorResponse {
  subtype: 'error';
  request_id: string;
  error: string | { message: string; [key: string]: unknown };
}

export interface CLIControlResponse {
  type: 'control_response';
  response: ControlResponse | ControlErrorResponse;
}

export interface ControlCancelRequest {
  type: 'control_cancel_request';
  request_id?: string;
}

export type ControlMessage =
  | CLIControlRequest
  | CLIControlResponse
  | ControlCancelRequest;

/**
 * Union of all SDK message types
 */
export type SDKMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKSystemMessage
  | SDKResultMessage
  | SDKPartialAssistantMessage;

export function isSDKUserMessage(msg: any): msg is SDKUserMessage {
  return (
    msg && typeof msg === 'object' && msg.type === 'user' && 'message' in msg
  );
}

export function isSDKAssistantMessage(msg: any): msg is SDKAssistantMessage {
  return (
    msg &&
    typeof msg === 'object' &&
    msg.type === 'assistant' &&
    'uuid' in msg &&
    'message' in msg &&
    'session_id' in msg &&
    'parent_tool_use_id' in msg
  );
}

export function isSDKSystemMessage(msg: any): msg is SDKSystemMessage {
  return (
    msg &&
    typeof msg === 'object' &&
    msg.type === 'system' &&
    'subtype' in msg &&
    'uuid' in msg &&
    'session_id' in msg
  );
}

export function isSDKResultMessage(msg: any): msg is SDKResultMessage {
  return (
    msg &&
    typeof msg === 'object' &&
    msg.type === 'result' &&
    'subtype' in msg &&
    'duration_ms' in msg &&
    'is_error' in msg &&
    'uuid' in msg &&
    'session_id' in msg
  );
}

export function isSDKPartialAssistantMessage(
  msg: any,
): msg is SDKPartialAssistantMessage {
  return (
    msg &&
    typeof msg === 'object' &&
    msg.type === 'stream_event' &&
    'uuid' in msg &&
    'session_id' in msg &&
    'event' in msg &&
    'parent_tool_use_id' in msg
  );
}

export function isControlRequest(msg: any): msg is CLIControlRequest {
  return (
    msg &&
    typeof msg === 'object' &&
    msg.type === 'control_request' &&
    'request_id' in msg &&
    'request' in msg
  );
}

export function isControlResponse(msg: any): msg is CLIControlResponse {
  return (
    msg &&
    typeof msg === 'object' &&
    msg.type === 'control_response' &&
    'response' in msg
  );
}

export function isControlCancel(msg: any): msg is ControlCancelRequest {
  return (
    msg &&
    typeof msg === 'object' &&
    msg.type === 'control_cancel_request' &&
    'request_id' in msg
  );
}

export function isTextBlock(block: any): block is TextBlock {
  return block && typeof block === 'object' && block.type === 'text';
}

export function isThinkingBlock(block: any): block is ThinkingBlock {
  return block && typeof block === 'object' && block.type === 'thinking';
}

export function isToolUseBlock(block: any): block is ToolUseBlock {
  return block && typeof block === 'object' && block.type === 'tool_use';
}

export function isToolResultBlock(block: any): block is ToolResultBlock {
  return block && typeof block === 'object' && block.type === 'tool_result';
}

export type SubagentLevel = 'session';

export interface ModelConfig {
  model?: string;
  temp?: number;
  top_p?: number;
}

export interface RunConfig {
  max_time_minutes?: number;
  max_turns?: number;
}

export interface SubagentConfig {
  name: string;
  description: string;
  tools?: string[];
  systemPrompt: string;
  level: SubagentLevel;
  filePath?: string;
  modelConfig?: Partial<ModelConfig>;
  runConfig?: Partial<RunConfig>;
  color?: string;
  readonly isBuiltin?: boolean;
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Control Request Types
 *
 * Centralized enum for all control request subtypes supported by the CLI.
 * This enum should be kept in sync with the controllers in:
 * - packages/cli/src/services/control/controllers/systemController.ts
 * - packages/cli/src/services/control/controllers/permissionController.ts
 * - packages/cli/src/services/control/controllers/mcpController.ts
 * - packages/cli/src/services/control/controllers/hookController.ts
 */
export enum ControlRequestType {
  // SystemController requests
  INITIALIZE = 'initialize',
  INTERRUPT = 'interrupt',
  SET_MODEL = 'set_model',
  SUPPORTED_COMMANDS = 'supported_commands',

  // PermissionController requests
  CAN_USE_TOOL = 'can_use_tool',
  SET_PERMISSION_MODE = 'set_permission_mode',

  // MCPController requests
  MCP_MESSAGE = 'mcp_message',
  MCP_SERVER_STATUS = 'mcp_server_status',

  // HookController requests
  HOOK_CALLBACK = 'hook_callback',
}
