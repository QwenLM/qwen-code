export { query } from './query/createQuery.js';
export { AbortError, isAbortError } from './types/errors.js';
export { Query } from './query/Query.js';
export { SdkLogger } from './utils/logger.js';

// Daemon HTTP client (talks to `qwen serve`; see GitHub issue #3803)
export {
  DAEMON_APPROVAL_MODES,
  DAEMON_ERROR_KINDS,
  DaemonCapabilityMissingError,
  DaemonClient,
  DaemonHttpError,
  DaemonSessionClient,
  asKnownDaemonEvent,
  createDaemonSessionViewState,
  isDaemonContentHash,
  isDaemonEventType,
  isKnownDaemonEvent,
  isWorkspaceScopedBudgetEvent,
  parseSseStream,
  reduceDaemonSessionEvent,
  reduceDaemonSessionEvents,
  requireWorkspaceCwd,
  SseFramingError,
  type CreateSessionRequest,
  type DaemonApprovalMode,
  type DaemonApprovalModeChangedData,
  type DaemonApprovalModeChangedEvent,
  type DaemonApprovalModeResult,
  type DaemonInitWorkspaceResult,
  type DaemonMcpRestartResult,
  type DaemonSessionRecapResult,
  type DaemonMcpServerRestartedData,
  type DaemonMcpServerRestartedEvent,
  type DaemonMcpServerRestartRefusedData,
  type DaemonMcpServerRestartRefusedEvent,
  type DaemonToolToggleResult,
  type DaemonToolToggledData,
  type DaemonToolToggledEvent,
  type DaemonWorkspaceInitializedData,
  type DaemonWorkspaceInitializedEvent,
  type DaemonAvailableCommand,
  type DaemonCapabilities,
  type DaemonEnvCell,
  type DaemonEnvKind,
  type DaemonErrorKind,
  type DaemonClientEvictedData,
  type DaemonClientEvictedEvent,
  // #4175 F4 prereq (Ilya0527 issue #15) — daemon-emitted resync
  // signal for SSE reconnects past the ring eviction boundary.
  type DaemonStateResyncRequiredData,
  type DaemonStateResyncRequiredEvent,
  type DaemonClientOptions,
  type DaemonContentHash,
  type DaemonControlEvent,
  type DaemonEvent,
  type DaemonEventEnvelope,
  type DaemonKnownEventType,
  // PR 14b — MCP guardrail push-event types.
  type DaemonMcpBudgetWarningData,
  type DaemonMcpBudgetWarningEvent,
  type DaemonMcpChildRefusedBatchData,
  type DaemonMcpChildRefusedBatchEvent,
  type DaemonMcpGuardrailEvent,
  type DaemonMcpRefusedServer,
  type DaemonMcpDiscoveryState,
  type DaemonMcpServerRuntimeStatus,
  type DaemonMcpTransport,
  type DaemonMode,
  type DaemonModelSwitchedData,
  type DaemonModelSwitchedEvent,
  type DaemonModelSwitchFailedData,
  type DaemonModelSwitchFailedEvent,
  type DaemonPermissionOption,
  type DaemonPermissionAlreadyResolvedData,
  type DaemonPermissionAlreadyResolvedEvent,
  type DaemonPermissionForbiddenData,
  type DaemonPermissionForbiddenEvent,
  type DaemonPermissionPartialVoteData,
  type DaemonPermissionPartialVoteEvent,
  type DaemonPermissionRequestData,
  type DaemonPermissionRequestEvent,
  type DaemonPermissionResolvedData,
  type DaemonPermissionResolvedEvent,
  type DaemonProtocolVersions,
  type DaemonRestoredSession,
  type DaemonSession,
  type DaemonSessionClosedReason,
  type DaemonSessionClientOptions,
  type DaemonSessionContextStatus,
  type DaemonSessionDiedData,
  type DaemonSessionDiedEvent,
  type DaemonSessionEvent,
  type DaemonSessionSubscribeOptions,
  type DaemonSessionState,
  type DaemonSessionSummary,
  type DaemonSessionSupportedCommandsStatus,
  type DaemonSkillLevel,
  type DaemonPreflightCell,
  type DaemonPreflightKind,
  type DaemonStatus,
  type DaemonStatusCell,
  type DaemonWorkspaceEnvStatus,
  type DaemonWorkspaceFile,
  type DaemonWorkspaceFileBytes,
  type DaemonWorkspaceFileEditRequest,
  type DaemonWorkspaceFileEditResult,
  type DaemonWorkspaceFileWriteRequest,
  type DaemonWorkspaceFileWriteResult,
  type DaemonWorkspacePreflightStatus,
  type DaemonSessionUpdateData,
  type DaemonSessionUpdateEvent,
  type DaemonSessionViewState,
  type DaemonSlowClientWarningData,
  type DaemonSlowClientWarningEvent,
  type DaemonStreamErrorData,
  type DaemonStreamErrorEvent,
  type DaemonStreamLifecycleEvent,
  type DaemonWorkspaceMcpServerStatus,
  type DaemonWorkspaceMcpStatus,
  type DaemonWorkspaceProviderCurrent,
  type DaemonWorkspaceProviderModel,
  type DaemonWorkspaceProviderStatus,
  type DaemonWorkspaceProvidersStatus,
  type DaemonWorkspaceSkillStatus,
  type DaemonWorkspaceSkillsStatus,
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

// PR #4255 fold-in 9 review thread #11 — Issue #4175 PR 21 auth
// surface. These were re-exported from `./daemon/index.js` but the
// public SDK entry (this file) never re-exported them, so an
// `import { DaemonAuthFlow } from '@qwen-code/sdk'` resolved to
// undefined. The PR description lists `reduceDaemonAuthEvent` as
// SDK surface and `client.auth.start()` works only because
// `DaemonClient` (already exported above) constructs `DaemonAuthFlow`
// internally; every other API path was unreachable.
export {
  DaemonAuthFlow,
  DEVICE_FLOW_EXPIRY_GRACE_MS,
  createDaemonAuthState,
  reduceDaemonAuthEvent,
  reduceDaemonAuthEvents,
  type AwaitCompletionOptions,
  type DaemonAuthDeviceFlowAuthorizedData,
  type DaemonAuthDeviceFlowAuthorizedEvent,
  type DaemonAuthDeviceFlowCancelledData,
  type DaemonAuthDeviceFlowCancelledEvent,
  type DaemonAuthDeviceFlowErrorKind,
  type DaemonAuthDeviceFlowFailedData,
  type DaemonAuthDeviceFlowFailedEvent,
  type DaemonAuthDeviceFlowProviderId,
  type DaemonAuthDeviceFlowStartedData,
  type DaemonAuthDeviceFlowStartedEvent,
  type DaemonAuthDeviceFlowStatus,
  type DaemonAuthDeviceFlowThrottledData,
  type DaemonAuthDeviceFlowThrottledEvent,
  type DaemonAuthEvent,
  type DaemonAuthFlowHandle,
  type DaemonAuthProviderId,
  type DaemonAuthState,
  type DaemonAuthStatusSnapshot,
  type DaemonDeviceFlowReducerState,
  type DaemonDeviceFlowStartResult,
  type DaemonDeviceFlowState,
} from './daemon/index.js';

// SDK MCP Server exports
export { tool } from './daemon-mcp/tool.js';
export { createSdkMcpServer } from './daemon-mcp/createSdkMcpServer.js';
export { createServeBridgeMcpServer } from './daemon-mcp/serve-bridge/index.js';

export type { SdkMcpToolDefinition } from './daemon-mcp/tool.js';

export type {
  CreateSdkMcpServerOptions,
  McpSdkServerConfigWithInstance,
} from './daemon-mcp/createSdkMcpServer.js';

export type { ServeBridgeMcpServerOptions } from './daemon-mcp/serve-bridge/index.js';

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
