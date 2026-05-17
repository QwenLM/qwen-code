export { query } from './query/createQuery.js';
export { AbortError, isAbortError } from './types/errors.js';
export { Query } from './query/Query.js';
export { SdkLogger } from './utils/logger.js';

// Daemon HTTP client (talks to `qwen serve`; see GitHub issue #3803)
export {
  DaemonCapabilityMissingError,
  DaemonClient,
  DaemonHttpError,
  DaemonSessionClient,
  asKnownDaemonEvent,
  createDaemonSessionViewState,
  isDaemonEventType,
  isKnownDaemonEvent,
  parseSseStream,
  reduceDaemonSessionEvent,
  reduceDaemonSessionEvents,
  requireWorkspaceCwd,
  SseFramingError,
  type CreateSessionRequest,
  type DaemonCapabilities,
  type DaemonClientEvictedData,
  type DaemonClientEvictedEvent,
  type DaemonClientOptions,
  type DaemonControlEvent,
  type DaemonEvent,
  type DaemonEventEnvelope,
  type DaemonKnownEventType,
  type DaemonMode,
  type DaemonModelSwitchedData,
  type DaemonModelSwitchedEvent,
  type DaemonModelSwitchFailedData,
  type DaemonModelSwitchFailedEvent,
  type DaemonPermissionOption,
  type DaemonPermissionAlreadyResolvedData,
  type DaemonPermissionAlreadyResolvedEvent,
  type DaemonPermissionRequestData,
  type DaemonPermissionRequestEvent,
  type DaemonPermissionResolvedData,
  type DaemonPermissionResolvedEvent,
  type DaemonProtocolVersions,
  type DaemonRestoredSession,
  type DaemonSession,
  type DaemonSessionClosedReason,
  type DaemonSessionClientOptions,
  type DaemonSessionDiedData,
  type DaemonSessionDiedEvent,
  type DaemonSessionEvent,
  type DaemonSessionSubscribeOptions,
  type DaemonSessionState,
  type DaemonSessionSummary,
  type DaemonSessionUpdateData,
  type DaemonSessionUpdateEvent,
  type DaemonSessionViewState,
  type DaemonSlowClientWarningData,
  type DaemonSlowClientWarningEvent,
  type DaemonStreamErrorData,
  type DaemonStreamErrorEvent,
  type DaemonStreamLifecycleEvent,
  type HeartbeatResult,
  type KnownDaemonEvent,
  type PermissionOutcome,
  type PermissionOutcomeCancelled,
  type PermissionOutcomeSelected,
  type PermissionResponse,
  type PromptContentBlock,
  // BRSCv: drop the historical `Daemon`-prefixed aliases for
  // consistency with the rest of the daemon-type exports
  // (CreateSessionRequest / DaemonSession / PromptResult / etc. are
  // all exported un-prefixed). The prefix on these two was a
  // transitional artifact from when the daemon types lived alongside
  // older non-daemon types of the same name; they don't anymore.
  // The SDK is Stage-1-experimental with no shipping consumers, so
  // breaking the alias is cheaper than carrying inconsistent naming
  // forward into Stage 2.
  type PromptRequest,
  type PromptResult,
  type PromptTextContent,
  type RestoreSessionRequest,
  type SetModelResult,
  type SessionMetadataResult,
  type SubscribeOptions,
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
