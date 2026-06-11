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
  useDaemonPendingPermissions,
  useDaemonPromptStatus,
  useDaemonSessionNotices,
  useDaemonStreamingState,
  useDaemonSession,
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
  selectDaemonSubAgentToolBlocks,
  selectDaemonStreamingState,
  selectDaemonTodoLists,
  selectDaemonTranscriptStreamingState,
  toDaemonPromptContent,
} from './session/index.js';
export type {
  DaemonCommandInfo,
  DaemonConnectionState,
  DaemonConnectionStatus,
  DaemonModelInfo,
  DaemonNoticeCategory,
  DaemonNoticeOperation,
  DaemonNoticeSeverity,
  DaemonPromptImage,
  DaemonPromptStatus,
  DaemonSessionActions,
  DaemonSessionContextValue,
  DaemonSessionNotice,
  DaemonSessionProviderProps,
  DaemonTodoItem,
  DaemonTodoList,
  DaemonTodoPriority,
  DaemonTodoStatus,
  DaemonStreamingState,
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
  useDaemonSettings,
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
  DaemonAuthProviderBaseUrlOption,
  DaemonAuthProviderCatalog,
  DaemonAuthProviderDescriptor,
  DaemonAuthProviderInstallRequest,
  DaemonAuthProviderInstallResult,
  DaemonAuthProviderModel,
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
  DaemonSettingDescriptor,
  DaemonWorkspaceSettingsStatus,
  DaemonSettingUpdateResult,
} from '@qwen-code/sdk/daemon';
