/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Annotation for attaching metadata to content blocks
 */
export interface Annotation {
  type: string;
  value: string;
}

/**
 * Usage information types
 */
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

/**
 * Permission denial information
 */
export interface CLIPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
}

/**
 * Content block types from Anthropic SDK
 */
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

/**
 * Anthropic SDK Message types
 */
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

/**
 * CLI Message wrapper types
 */
export interface CLIUserMessage {
  type: 'user';
  uuid?: string;
  session_id: string;
  message: APIUserMessage;
  parent_tool_use_id: string | null;
  options?: Record<string, unknown>;
}

export interface CLIAssistantMessage {
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: APIAssistantMessage;
  parent_tool_use_id: string | null;
}

export interface CLISystemMessage {
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
  permissionMode?: string;
  slash_commands?: string[];
  apiKeySource?: string;
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

export interface CLIResultMessageSuccess {
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

export interface CLIResultMessageError {
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

export type CLIResultMessage = CLIResultMessageSuccess | CLIResultMessageError;

/**
 * Stream event types for real-time message updates
 */
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

export interface CLIPartialAssistantMessage {
  type: 'stream_event';
  uuid: string;
  session_id: string;
  event: StreamEvent;
  parent_tool_use_id: string | null;
}

export type PermissionMode = 'default' | 'plan' | 'auto-edit' | 'yolo';

/**
 * Permission suggestion for tool use requests
 * TODO: Align with `ToolCallConfirmationDetails`
 */
export interface PermissionSuggestion {
  type: 'allow' | 'deny' | 'modify';
  label: string;
  description?: string;
  modifiedInput?: unknown;
}

/**
 * Hook callback placeholder for future implementation
 */
export interface HookRegistration {
  event: string;
  callback_id: string;
}

/**
 * Hook callback result placeholder for future implementation
 */
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

export interface CLIControlInitializeRequest {
  subtype: 'initialize';
  hooks?: HookRegistration[] | null;
  sdkMcpServers?: string[];
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

/**
 * Permission approval result
 */
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
 * Union of all CLI message types
 */
export type CLIMessage =
  | CLIUserMessage
  | CLIAssistantMessage
  | CLISystemMessage
  | CLIResultMessage
  | CLIPartialAssistantMessage;

/**
 * Type guard functions for message discrimination
 */

export function isCLIUserMessage(msg: any): msg is CLIUserMessage {
  return (
    msg && typeof msg === 'object' && msg.type === 'user' && 'message' in msg
  );
}

export function isCLIAssistantMessage(msg: any): msg is CLIAssistantMessage {
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

export function isCLISystemMessage(msg: any): msg is CLISystemMessage {
  return (
    msg &&
    typeof msg === 'object' &&
    msg.type === 'system' &&
    'subtype' in msg &&
    'uuid' in msg &&
    'session_id' in msg
  );
}

export function isCLIResultMessage(msg: any): msg is CLIResultMessage {
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

export function isCLIPartialAssistantMessage(
  msg: any,
): msg is CLIPartialAssistantMessage {
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

/**
 * Content block type guards
 */

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
