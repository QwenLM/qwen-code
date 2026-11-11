/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// CLI's current JSONL wire protocol declaration.
export const WIRE_PROTOCOL_VERSION = '1.5.0' as const;

export type { WireProtocolVersion } from './wire/version.js';
export type { SlashCommand } from './wire/index.js';

// MCP wire types
export type {
  McpStdioServerConfig,
  McpSSEServerConfig,
  McpHttpServerConfig,
  McpSdkServerConfig,
  McpClaudeAIProxyServerConfig,
  McpServerConfigForProcessTransport,
  McpServerStatus,
  McpServerStatusConfig,
  McpSetServersResult,
  OAuthToken,
} from './wire/index.js';

// MCP status schema
export { mcpServerStatusSchema } from './schemas/mcp-status.js';
export { shouldExposeTokenUsage } from './token-usage-visibility.js';

// Control protocol envelope schemas
export {
  SDKControlRequestEnvelopeSchema,
  SDKControlResponseEnvelopeSchema,
  SDKControlCancelRequestSchema,
  SDKKeepAliveSchema,
} from './schemas/control.js';

// Control protocol types
export type {
  SDKControlRequest,
  SDKControlResponse,
  SDKControlCancelRequest,
  SDKControlInterruptRequest,
  SDKControlPermissionRequest,
  SDKControlInitializeRequest,
  SDKControlSetPermissionModeRequest,
  SDKControlSetModelRequest,
  QoderModelPurpose,
  SDKControlSetMaxThinkingTokensRequest,
  SDKControlMcpStatusRequest,
  SDKControlGetContextUsageRequest,
  SDKControlAccountInfoRequest,
  SDKHookCallbackRequest,
  SDKControlMcpMessageRequest,
  SDKControlRewindFilesRequest,
  SDKControlCancelAsyncMessageRequest,
  SDKControlSeedReadStateRequest,
  SDKControlMcpSetServersRequest,
  SDKControlReloadPluginsRequest,
  SDKControlMcpReconnectRequest,
  SDKControlMcpToggleRequest,
  SDKControlApplyFlagSettingsRequest,
  SDKControlGetSettingsRequest,
  SDKControlElicitationRequest,
  SDKControlStopTaskRequest,
  SDKControlEndSessionRequest,
  SDKControlChannelEnableRequest,
  SDKControlMcpInjectTokenRequest,
  SDKControlMcpAuthenticateRequest,
  SDKControlMcpAuthenticateResponse,
  SDKControlMcpOAuthCallbackUrlRequest,
  SDKControlMcpClearAuthRequest,
  SDKControlRequestInner,
  SDKControlInitializeResponse,
  SDKControlGetContextUsageResponse,
  SDKControlReloadPluginsResponse,
  SDKControlMcpStatusResponse,
  SDKControlMcpSetServersResponse,
  SDKKeepAliveMessage,
  StdoutMessage,
  ControlMcpServerConfig,
  // Hooks (core has its own HookInput interface — don't re-export
  // protocol's HookInput here to avoid name collision; wire type lives
  // in ./wire/hooks.ts)
  HookEvent,
  HookJSONOutput,
  SyncHookJSONOutput,
  AsyncHookJSONOutput,
  // Agents (core has its own AgentDefinition / AgentMcpServerSpec —
  // intentionally not re-exported; AgentInfo is wire-only and unique)
  AgentInfo,
} from './wire/index.js';

// Utility
export { lazySchema } from './utils/lazySchema.js';

// Common schemas & types
export {
  // Placeholder schemas
  APIUserMessagePlaceholder,
  APIAssistantMessagePlaceholder,
  RawMessageStreamEventPlaceholder,
  UUIDPlaceholder,
  NonNullableUsagePlaceholder,
  // Value schemas
  ModelUsageSchema,
  ApiKeySourceSchema,
  PermissionModeSchema,
  FastModeStateSchema,
  SDKAssistantMessageErrorSchema,
  SDKStatusSchema,
  SDKPermissionDenialSchema,
  SDKPermissionDeniedReasonTypeSchema,
  SDKToolDenialKindSchema,
  SDKToolNonExecutionKindSchema,
  SDKToolResultMetaSchema,
  PluginInfoSchema,
  // Inferred types
  type ModelUsage,
  type ApiKeySource,
  type PermissionMode,
  type FastModeState,
  type SDKAssistantMessageError,
  type SDKStatus,
  type SDKPermissionDenial,
  type SDKPermissionDeniedReasonType,
  type SDKToolDenialKind,
  type SDKToolNonExecutionKind,
  type SDKToolResultMeta,
  type PluginInfo,
  type NonNullableUsage,
  // Re-exported SDK types
  type BetaRawMessageStreamEvent,
  type BetaMessage,
  type BetaUsage,
  type BetaStopReason,
} from './schemas/common.js';

// SDKMessage schemas & types
export {
  // Core agentic loop schemas
  SDKUserMessageSchema,
  SDKUserMessageReplaySchema,
  SDKAssistantMessageSchema,
  SDKPartialAssistantMessageSchema,
  SDKResultSuccessSchema,
  SDKResultErrorSchema,
  SDKResultMessageSchema,
  HostActionEventSchema,
  // System message schemas
  SDKSystemMessageSchema,
  SDKArtifactUpdateMessageSchema,
  SDKAvailableModelsUpdateMessageSchema,
  SDKCommandsChangedMessageSchema,
  SDKStatusMessageSchema,
  SDKPermissionDeniedMessageSchema,
  SDKSessionStateChangedMessageSchema,
  SDKPlanModeSnapshotSchema,
  SDKPlanModeChangedMessageSchema,
  SDKSessionTitleChangedMessageSchema,
  SDKCompactBoundaryMessageSchema,
  SDKAPIRetryMessageSchema,
  SDKLocalCommandOutputMessageSchema,
  SDKHookStartedMessageSchema,
  SDKHookProgressMessageSchema,
  SDKHookResponseMessageSchema,
  SDKTaskNotificationMessageSchema,
  SDKTaskStartedMessageSchema,
  SDKTaskProgressMessageSchema,
  SDKTaskUpdatedMessageSchema,
  SDKBridgeStateMessageSchema,
  SDKFilesPersistedEventSchema,
  SDKElicitationCompleteMessageSchema,
  SDKSkillEvolutionMessageSchema,
  // Non-system message schemas
  SDKPromptSuggestionMessageSchema,
  SDKCommandLifecycleMessageSchema,
  SDKControlRequestProgressMessageSchema,
  // Union schema
  SDKMessageSchema,
  // Inferred types
  type SDKUserMessage,
  type SDKUserMessageReplay,
  type SDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type SDKResultSuccess,
  type SDKResultError,
  type SDKMessageOrigin,
  type SDKResultOrigin,
  type SDKResultMessage,
  type HostAction,
  type HostActionEvent,
  HOST_ACTIONS,
  type SDKSystemMessage,
  type SDKArtifactInfo,
  type SDKArtifactUpdateMessage,
  type SDKAvailableModelInfo,
  type SDKAvailableModelsUpdateMessage,
  type SDKCommandInfo,
  type SDKCommandsChangedMessage,
  type SDKStatusMessage,
  type SDKPermissionDeniedMessage,
  type SDKSessionStateChangedMessage,
  type SDKPlanModeSnapshot,
  type SDKPlanModeChangedMessage,
  type SDKGoalStatus,
  SDK_GOAL_STATUSES,
  type SDKGoalSnapshot,
  type SDKGoalUpdatedMessage,
  type SDKGoalClearedMessage,
  type SDKSessionTitleChangedMessage,
  type SDKCompactBoundaryMessage,
  type SDKAPIRetryMessage,
  type SDKLocalCommandOutputMessage,
  type SDKHookStartedMessage,
  type SDKHookProgressMessage,
  type SDKHookResponseMessage,
  type SDKTaskNotificationMessage,
  type SDKTaskStartedMessage,
  type SDKTaskProgressMessage,
  type SDKTaskUpdatedMessage,
  type SDKBridgeStateMessage,
  type SDKFilesPersistedEvent,
  type SDKElicitationCompleteMessage,
  type SDKSkillEvolutionMessage,
  type SDKAgentsMdSizeWarningMessage,
  SDKAgentsMdSizeWarningMessageSchema,
  type SDKPromptSuggestionMessage,
  type SDKCommandLifecycleMessage,
  type SDKControlRequestProgressMessage,
  type SDKMessage,
} from './schemas/sdk-message.js';

// Transcript runtime message types
export {
  type Message,
  type MessageType,
  type MessageBase,
  type UserMessage,
  type AssistantMessage,
  type AssistantMessagePayload,
  type ThinkingBlock,
  type SystemMessage,
  type SystemSubtype,
  type ProgressMessage,
  type AttachmentMessage as TranscriptAttachmentMessage,
  type AttachmentType,
  type ToolUseSummaryMessage,
  type TombstoneMessage,
  type ContentBlockParam,
  type ToolResultBlockParam,
} from './transcript/message.js';

// Transcript JSONL entry types
export {
  type TranscriptMessage,
  type SummaryMessage,
  type CustomTitleEntry,
  type AiTitleEntry,
  type LastPromptEntry,
  type TagEntry,
  type SessionMode,
  type ModeEntry,
  type RuntimeConfigEntry,
  type ContentReplacementEntry,
  type TranscriptWorktreeSession,
  type Entry,
  isTranscriptMessage,
} from './transcript/entry.js';

// Transcript conversion helpers
export {
  createAssistantMessage,
  modelMessageToAssistantPayload,
  modelInputToTranscriptBlock,
  transcriptInputToModelBlock,
  toolResultPartToTranscriptBlock,
  createUserMessage,
  createSyntheticUserCaveatMessage,
  createToolResultMessage,
  createSystemMessage,
  transcriptToMessage,
} from './transcript/conversions.js';

// Provider adapter — Anthropic runtime messages → provider-neutral requests
export { normalizeMessagesForAPI, cloneUsage } from './provider/index.js';
