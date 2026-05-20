/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { normalizeDaemonEvent, getSessionUpdatePayload } from './normalizer.js';
export { createDaemonToolPreview } from './toolPreview.js';
export {
  appendLocalUserTranscriptMessage,
  createDaemonTranscriptState,
  formatBlockTimestamp,
  rebuildDaemonTranscriptBlockIndex,
  reduceDaemonTranscriptEvents,
  selectApprovalMode,
  selectCurrentTool,
  selectPendingPermissionBlocks,
  selectToolProgress,
  selectTranscriptBlocks,
  selectTranscriptBlocksOrderedByEventId,
} from './transcript.js';
export { createDaemonTranscriptStore } from './store.js';
export {
  daemonUiEventToTerminalText,
  transcriptBlockToTerminalText,
} from './terminal.js';
export {
  getOutputText,
  isSensitiveKey as isDaemonUiSensitiveKey,
  redactSensitiveFields as redactDaemonUiSensitiveFields,
  sanitizeTerminalText,
  stringifyJson,
  stripOscSequences,
} from './utils.js';
export { DAEMON_PLAN_TOOL_CALL_ID } from './types.js';
export type {
  DaemonShellTranscriptBlock,
  DaemonStatusTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolPreview,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
  DaemonTranscriptBlockKind,
  DaemonTranscriptQuestion,
  DaemonTranscriptQuestionOption,
  DaemonTranscriptReducerOptions,
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
  // Workspace events
  DaemonUiWorkspaceMemoryChangedEvent,
  DaemonUiWorkspaceAgentChangedEvent,
  DaemonUiWorkspaceToolToggledEvent,
  DaemonUiWorkspaceInitializedEvent,
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
