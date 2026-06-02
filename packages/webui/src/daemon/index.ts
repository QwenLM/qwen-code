/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// ── Session axis (per-conversation) ────────────────────────────────
export {
  DaemonSessionProvider,
  useDaemonActions,
  useDaemonActiveTodoList,
  useDaemonConnection,
  useDaemonLatestTodoList,
  useDaemonMessages,
  useDaemonPendingPermissionRequest,
  useDaemonPendingPermissions,
  useDaemonPromptStatus,
  useDaemonStreamingState,
  useDaemonSession,
  useDaemonTodoLists,
  useDaemonTranscriptBlocks,
  useDaemonTranscriptState,
  useDaemonTranscriptStore,
  useDaemonWorkspaceEventSignals,
  extractDaemonTodosFromToolBlock,
  hasDaemonActiveTodos,
  isDaemonSubAgentToolBlock,
  parseDaemonTodoItemsFromEntries,
  selectDaemonActiveTodoList,
  selectDaemonLatestTodoList,
  selectDaemonPendingPermissions,
  selectDaemonPendingPermissionRequest,
  selectDaemonSubAgentToolBlocks,
  selectDaemonStreamingState,
  selectDaemonTodoLists,
  selectDaemonTranscriptStreamingState,
  toDaemonPromptContent,
  transcriptBlocksToDaemonMessages,
} from './session/index.js';
export type {
  DaemonCommandInfo,
  DaemonConnectionState,
  DaemonConnectionStatus,
  DaemonMessage,
  DaemonAssistantMessage,
  DaemonInsightProgressMessage,
  DaemonInsightReadyMessage,
  DaemonMessageToolCall,
  DaemonMessageToolCallContent,
  DaemonMessageToolCallStatus,
  DaemonMessageToolKind,
  DaemonMessageToolCallLocation,
  DaemonMessageTodoItem,
  DaemonModelInfo,
  DaemonPendingPermissionRequest,
  DaemonPermissionOptionKind,
  DaemonPermissionRequestOption,
  DaemonPlanMessage,
  DaemonPromptImage,
  DaemonPromptStatus,
  DaemonSessionActions,
  DaemonSessionContextValue,
  DaemonSessionProviderProps,
  DaemonSystemMessage,
  DaemonTodoItem,
  DaemonTodoList,
  DaemonTodoPriority,
  DaemonTodoStatus,
  DaemonToolGroupMessage,
  DaemonStreamingState,
  DaemonUserMessage,
  DaemonUserShellMessage,
  DaemonWorkspaceEventSignals,
  SendPromptOptions,
} from './session/index.js';

// ── Workspace axis (per-workspace, outlives sessions) ──────────────
export {
  DaemonWorkspaceProvider,
  useDaemonWorkspace,
  useDaemonWorkspaceActions,
  useOptionalDaemonWorkspace,
  useDaemonAgents,
  useDaemonAuth,
  useDaemonDiagnostics,
  useDaemonFiles,
  useDaemonGlob,
  useDaemonMcp,
  useDaemonMemory,
  useDaemonResource,
  useDaemonSessions,
  useDaemonSkills,
  useDaemonTools,
} from './workspace/index.js';
export type {
  DaemonDirectoryEntry,
  DaemonDirectoryListing,
  DaemonFileStat,
  DaemonGlobOptions,
  DaemonGlobResult,
  DaemonResourceOptions,
  DaemonWorkspaceActions,
  DaemonWorkspaceContextValue,
  DaemonWorkspaceProviderProps,
  DaemonWorkspaceStatus,
  ResourceResult,
  ResourceState,
} from './workspace/index.js';

// ── Shared (daemon → webui bridge) ─────────────────────────────────
export { daemonTranscriptToUnifiedMessages } from './transcriptAdapter.js';
export {
  useDaemonFollowupSuggestion,
  type UseDaemonFollowupSuggestionReturn,
} from './useDaemonFollowupSuggestion.js';

// ── Re-exported SDK types/constants for UI consumers ──────────────
// These allow web-shell and other UI packages to depend only on
// @qwen-code/webui without importing @qwen-code/sdk/daemon directly.
export { DAEMON_APPROVAL_MODES } from '@qwen-code/sdk/daemon';
export type {
  DaemonApprovalMode,
  DaemonContextCategoryBreakdown,
  DaemonContextFileScope,
  DaemonContextMemoryDetail,
  DaemonContextSkillDetail,
  DaemonContextToolDetail,
  DaemonSessionContextUsage,
  DaemonSessionContextUsageStatus,
  DaemonSessionStatsModelMetrics,
  DaemonSessionStatsStatus,
  DaemonSessionStatsToolByName,
  DaemonSessionSummary,
  DaemonWorkspaceAgentDetail,
  DaemonWorkspaceAgentSummary,
  DaemonWorkspaceMcpServerStatus,
  DaemonWorkspaceMcpToolStatus,
  DaemonWorkspaceMcpToolsStatus,
  DaemonWorkspaceMemoryFile,
  DaemonWorkspaceSkillStatus,
  DaemonWorkspaceToolStatus,
} from '@qwen-code/sdk/daemon';
