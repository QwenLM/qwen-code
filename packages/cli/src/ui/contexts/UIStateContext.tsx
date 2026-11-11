/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type {
  HistoryItem,
  ConfirmationRequest,
  HistoryItemWithoutId,
  StreamingState,
  ActiveHook,
  ModelQueueProps,
} from '../types.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';

import type {
  PermissionMode,
  AgentDefinition,
  FolderDiscoveryResults,
  HookRegistryEntry,
  MCPServerConfig,
  BlockedExternalImport,
  ConfigLoadError,
  ReasoningEffortLevel,
  CompressionProgressStage,
  UnifiedTask,
  WorkflowUnifiedTask,
} from '@qwen-code/core';
import { type TransientMessageType } from '../../utils/events.js';
import type { DOMElement } from 'ink';
import type { SessionStatsState } from './SessionContext.js';
import type { ExtensionUpdateState } from '../state/extensions.js';
import type { UpdateObject } from '../utils/updateCheck.js';

import { type UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import type { TerminalBackgroundColor } from '../utils/terminalCapabilityManager.js';
import type { SkillDisplayInfo } from '../components/SkillBrowser.js';
import type { PeerInboundApprovalRequestState } from '../components/PeerInboundApprovalDialog.js';
import type { SourceTabKey } from '../components/AgentBrowser.js';

export type SessionRailSelectionMode = 'workflows';

export type ConversationScreen = 'prompt' | 'transcript';

export interface ModelNextActionSuggestions {
  id: number;
  promptId: string;
  items: readonly string[];
}

export interface CompressionProgressView {
  stage: CompressionProgressStage;
  label: string;
  /** Phase progress for display only; never derived from token usage. */
  percent: number;
  tone: 'active' | 'warning';
}

export interface UIState {
  history: HistoryItem[];
  historyManager: UseHistoryManagerReturn;
  mcpAuthNotice: string | null;
  isThemeDialogOpen: boolean;
  themeError: string | null;
  isConfigInitialized: boolean;
  /** The product session gate is showing its own UI in the controls area. */
  sessionGateVisible: boolean;
  editorError: string | null;
  isEditorDialogOpen: boolean;
  corgiMode: boolean;
  debugMessage: string;
  quittingMessages: HistoryItem[] | null;
  isSettingsDialogOpen: boolean;
  isSessionBrowserOpen: boolean;
  sessionBrowserInitialSearchQuery?: string;
  isAgentConfigDialogOpen: boolean;
  isAgentBrowserOpen: boolean;
  agentBrowserActiveTab: SourceTabKey;
  isMcpBrowserOpen: boolean;
  selectedAgentName?: string;
  selectedAgentDefinition?: AgentDefinition;
  isHookBrowserOpen: boolean;
  isHookConfigDialogOpen: boolean;
  selectedHookEntry?: HookRegistryEntry;
  isSkillBrowserOpen: boolean;
  isSkillDetailViewOpen: boolean;
  selectedSkillInfo?: SkillDisplayInfo;
  isConfigErrorDetailOpen: boolean;
  selectedConfigError?: ConfigLoadError;
  configErrorLabel?: string;
  isWorktreeExitDialogOpen: boolean;
  isPluginBrowserOpen: boolean;
  pluginBrowserArgs?: string;
  slashCommands: readonly SlashCommand[] | undefined;
  pendingSlashCommandHistoryItems: HistoryItemWithoutId[];
  commandContext: CommandContext;
  commandConfirmationRequest: ConfirmationRequest | null;
  authConsentRequest: ConfirmationRequest | null;
  confirmUpdateExtensionRequests: ConfirmationRequest[];
  memoryMdFileCount: number;
  streamingState: StreamingState;
  /** True while a model-owned turn is active, including tool execution. */
  isModelTurnActive: boolean;
  /** True while a local command provides an explicit progress message. */
  isCommandProgressActive: boolean;
  compressionProgress: CompressionProgressView | null;
  modelNextActionSuggestions: ModelNextActionSuggestions | null;
  /** Whether the editor is mounted, including command/session transitions. */
  isInputVisible: boolean;
  /** Whether pending stashed input may be restored. */
  isInputActive: boolean;
  /** Sanitized custom session title for the prompt border label; undefined when unnamed. */
  sessionName: string | undefined;
  isResuming: boolean;
  isFolderTrustDialogOpen: boolean;
  folderDiscoveryResults: FolderDiscoveryResults | null;
  isMcpApprovalDialogOpen: boolean;
  pendingProjectMcpServers: Record<string, MCPServerConfig>;
  isExternalImportApprovalOpen: boolean;
  pendingExternalImports: readonly BlockedExternalImport[];
  peerInboundApprovalRequest: PeerInboundApprovalRequestState | null;
  isTrustedFolder: boolean | undefined;
  constrainHeight: boolean;
  showErrorDetails: boolean;
  renderMarkdown: boolean;
  ctrlCPressedOnce: boolean;
  ctrlDPressedOnce: boolean;
  shortcutsHelpVisible: boolean;
  cleanUiDetailsVisible: boolean;
  elapsedTime: number;
  currentLoadingPhrase: string | undefined;
  currentTip: string | undefined;
  currentWittyPhrase: string | undefined;
  conversationKey: number;
  conversationScreen: ConversationScreen;
  activeHooks: ActiveHook[];
  messageQueue: string[];
  queueErrorMessage: string | null;
  showPermissionModeIndicator: PermissionMode;
  allowPlanMode: boolean;
  /**
   * Whether startup supplied a SessionUiBinding for this UI.
   * Ordinary local TUI uses its existing path without this binding.
   * Existing input and queue guards follow the binding path.
   */
  hasSessionBinding: boolean;
  currentModel: string;
  currentReasoningEffort?: ReasoningEffortLevel;
  currentContextWindow?: number;
  contextFileNames: string[];
  errorCount: number;
  availableTerminalHeight: number | undefined;
  stableControlsHeight: number;
  mainAreaWidth: number;
  staticAreaMaxItemHeight: number;
  staticExtraHeight: number;
  dialogsVisible: boolean;
  /** True when some pending tool call is awaiting approval. */
  hasPendingToolConfirmation: boolean;
  /** Foreground model-capacity queue phase shown by StatusRow. */
  activeModelQueue: ModelQueueProps | null;
  nightly: boolean;
  branchName: string | undefined;
  sessionStats: SessionStatsState;
  terminalWidth: number;
  terminalHeight: number;
  mainControlsRef: (node: DOMElement | null) => void;
  // NOTE: This is for performance profiling only.
  rootUiRef: React.MutableRefObject<DOMElement | null>;
  updateInfo: UpdateObject | null;
  extensionsUpdateState: Map<string, ExtensionUpdateState>;
  activeShellId: number | undefined;
  showDebugProfiler: boolean;
  showFullTodos: boolean;
  customDialog: React.ReactNode | null;
  fullScreenDialog: React.ReactNode | null;
  terminalBackgroundColor: TerminalBackgroundColor;
  settingsNonce: number;
  unifiedTasks: UnifiedTask[];
  workflowHistoryTasks?: WorkflowUnifiedTask[];
  unifiedRunningCount: number;
  viewedAgentTaskId?: string;
  sessionRailSelectionMode?: SessionRailSelectionMode;
  viewedWorkflowTaskId?: string;
  adminSettingsChanged: boolean;
  showIsExpandableHint: boolean;
  hintMode: boolean;
  hintBuffer: string;
  transientMessage: {
    text: string;
    type: TransientMessageType;
  } | null;
}

export const UIStateContext = createContext<UIState | null>(null);

export const useUIState = () => {
  const context = useContext(UIStateContext);
  if (!context) {
    throw new Error('useUIState must be used within a UIStateProvider');
  }
  return context;
};
