/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  extractServerTimestamp,
  normalizeDaemonEvent,
  getSessionUpdatePayload,
} from './normalizer.js';
export { createDaemonToolPreview } from './toolPreview.js';
export {
  appendLocalUserTranscriptMessage,
  createDaemonTranscriptState,
  formatBlockTimestamp,
  isSubagentChildBlock,
  rebuildDaemonTranscriptBlockIndex,
  reduceDaemonTranscriptEvents,
  selectApprovalMode,
  selectCurrentTool,
  selectLastFollowupSuggestion,
  selectPendingPermissionBlocks,
  selectSubagentChildBlocks,
  selectToolProgress,
  selectTranscriptBlocks,
  selectTranscriptBlocksOrderedByEventId,
} from './transcript.js';
export { createDaemonTranscriptStore } from './store.js';
export { DAEMON_GOAL_STATUS_SENTINEL_PREFIX } from './sentinels.js';
export {
  daemonUiEventToTerminalText,
  transcriptBlockToTerminalText,
} from './terminal.js';
export {
  daemonBlockToHtml,
  daemonBlockToMarkdown,
  daemonBlockToPlainText,
  daemonToolPreviewToMarkdown,
} from './render.js';
export type { DaemonHtmlRenderOptions, DaemonRenderOptions } from './render.js';
export {
  DAEMON_UI_CONFORMANCE_FIXTURES,
  runAdapterConformanceSuite,
} from './conformance.js';
export type {
  ConformanceFailure,
  ConformanceSuiteResult,
  DaemonUiAdapterUnderTest,
  DaemonUiConformanceFixture,
  RunConformanceOptions,
} from './conformance.js';
export {
  extractContentPart,
  getOutputText,
  isSensitiveKey as isDaemonUiSensitiveKey,
  redactSensitiveFields as redactDaemonUiSensitiveFields,
  sanitizeTerminalText,
  stringifyJson,
  stripOscSequences,
} from './utils.js';
export { DAEMON_PLAN_TOOL_CALL_ID } from './types.js';
export type { DaemonUiContentPart } from './utils.js';
export type {
  DaemonShellTranscriptBlock,
  DaemonUserShellTranscriptBlock,
  DaemonPermissionTranscriptBlock,
  DaemonStatusTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonTextDeltaMeta,
  DaemonToolPreview,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
  DaemonTranscriptBlockKind,
  DaemonTranscriptQuestion,
  DaemonTranscriptQuestionOption,
  DaemonTranscriptReducerOptions,
  DaemonTranscriptSidechannelState,
  DaemonTranscriptState,
  DaemonTranscriptStore,
  // Chat-stream events
  DaemonUiAssistantDoneEvent,
  DaemonUiErrorEvent,
  DaemonUiEvent,
  DaemonUiEventBase,
  DaemonUiEventType,
  DaemonUiModelChangedEvent,
  DaemonUiPermissionOption,
  DaemonUiPermissionRequestEvent,
  DaemonUiPermissionResolvedEvent,
  DaemonUiSessionActions,
  DaemonUiShellOutputEvent,
  DaemonUiStatusEvent,
  DaemonUiTextEvent,
  DaemonUiToolUpdateEvent,
  DaemonUiToolProvenance,
  // Session-meta events
  DaemonUiSessionMetadataChangedEvent,
  DaemonUiSessionApprovalModeChangedEvent,
  DaemonUiSessionAvailableCommandsEvent,
  DaemonUiStateResyncRequiredEvent,
  DaemonUiReplayCompleteEvent,
  DaemonUiPromptCancelledEvent,
  // Daemon assist push (server-side ghost-text suggestion)
  DaemonUiFollowupSuggestionEvent,
  // Workspace events
  DaemonUiWorkspaceMemoryChangedEvent,
  DaemonUiWorkspaceAgentChangedEvent,
  DaemonUiWorkspaceToolToggledEvent,
  DaemonUiWorkspaceSettingsChangedEvent,
  DaemonUiTrustChangeRequestedEvent,
  DaemonUiWorkspaceInitializedEvent,
  DaemonUiGithubSetupCompletedEvent,
  DaemonUiMcpBudgetWarningEvent,
  DaemonUiMcpChildRefusedEvent,
  DaemonUiMcpServerRestartedEvent,
  DaemonUiMcpServerRestartRefusedEvent,
  // Auth device-flow events
  DaemonUiAuthDeviceFlowEvent,
  DaemonUiAuthDeviceFlowStartedEvent,
  DaemonUiAuthDeviceFlowThrottledEvent,
  DaemonUiAuthDeviceFlowAuthorizedEvent,
  DaemonUiAuthDeviceFlowFailedEvent,
  DaemonUiAuthDeviceFlowCancelledEvent,
  NormalizeDaemonEventOptions,
} from './types.js';
