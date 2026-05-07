export { query } from './query/createQuery.js';
export { AbortError, isAbortError } from './types/errors.js';
export { Query } from './query/Query.js';
export { SdkLogger } from './utils/logger.js';

// Daemon HTTP client (talks to `qwen serve`; see GitHub issue #3803)
export {
  DaemonClient,
  DaemonHttpError,
  parseSseStream,
  type CreateSessionRequest,
  type DaemonCapabilities,
  type DaemonClientOptions,
  type DaemonEvent,
  type DaemonMode,
  type DaemonSession,
  type DaemonSessionSummary,
  type PermissionOutcome,
  type PermissionOutcomeCancelled,
  type PermissionOutcomeSelected,
  type PermissionResponse,
  type PromptContentBlock,
  type PromptRequest as DaemonPromptRequest,
  type PromptResult,
  type PromptTextContent,
  type SetModelResult,
  type SubscribeOptions as DaemonSubscribeOptions,
} from './daemon/index.js';

// SDK MCP Server exports
export { tool } from './mcp/tool.js';
export { createSdkMcpServer } from './mcp/createSdkMcpServer.js';

export type { SdkMcpToolDefinition } from './mcp/tool.js';

export type {
  CreateSdkMcpServerOptions,
  McpSdkServerConfigWithInstance,
} from './mcp/createSdkMcpServer.js';

export type { QueryOptions } from './query/createQuery.js';
export type { LogLevel, LoggerConfig, ScopedLogger } from './utils/logger.js';

export type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKMessage,
  SDKMcpServerConfig,
  ControlMessage,
  CLIControlRequest,
  CLIControlResponse,
  ControlCancelRequest,
  SubagentConfig,
  SubagentLevel,
  RunConfig,
} from './types/protocol.js';

export {
  isSDKUserMessage,
  isSDKAssistantMessage,
  isSDKSystemMessage,
  isSDKResultMessage,
  isSDKPartialAssistantMessage,
  isControlRequest,
  isControlResponse,
  isControlCancel,
} from './types/protocol.js';

export type {
  PermissionMode,
  CanUseTool,
  PermissionResult,
  QuerySystemPrompt,
  QuerySystemPromptPreset,
  CLIMcpServerConfig,
  McpServerConfig,
  McpOAuthConfig,
  McpAuthProviderType,
} from './types/types.js';

export { isSdkMcpServerConfig } from './types/types.js';
