/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import { type FolderTrustChoice } from '../components/FolderTrustDialog.js';
import { type McpApprovalResult } from '../components/McpServerApprovalDialog.js';
import { type ExternalImportApprovalResult } from '../components/ExternalImportApprovalDialog.js';
import { type PeerInboundApprovalResult } from '../components/PeerInboundApprovalDialog.js';
import {
  type EditorType,
  type AgentDefinition,
  type HookRegistryEntry,
  type PastedContent,
  type ConfigLoadError,
} from '@qwen-code/core';
import { type LoadableSettingScope } from '../../config/settings.js';
import type { SessionInfo } from '../../utils/sessionUtils.js';
import type { SessionBrowserOpenOptions } from '../hooks/useSessionBrowser.js';
import type { SkillDisplayInfo } from '../components/SkillBrowser.js';
import type { SourceTabKey } from '../components/AgentBrowser.js';
import type { SessionGateState } from '../sessionGate.js';

export interface UIActions {
  handleThemeSelect: (
    themeName: string,
    scope: LoadableSettingScope,
  ) => Promise<void>;
  closeThemeDialog: () => void;
  handleThemeHighlight: (themeName: string | undefined) => void;
  onSessionGateStateChange: (state: SessionGateState) => void;
  handleEditorSelect: (
    editorType: EditorType | undefined,
    scope: LoadableSettingScope,
  ) => void;
  exitEditorDialog: () => void;
  closeSettingsDialog: () => void;
  openAgentConfigDialog: (name: string, definition: AgentDefinition) => void;
  closeAgentConfigDialog: () => void;
  openAgentBrowser: () => void;
  closeAgentBrowser: () => void;
  setAgentBrowserActiveTab: (tab: SourceTabKey) => void;
  openMcpBrowser: () => void;
  closeMcpBrowser: () => void;
  openHookBrowser: () => void;
  closeHookBrowser: () => void;
  openHookConfigDialog: (hookEntry: HookRegistryEntry) => void;
  closeHookConfigDialog: () => void;
  openSkillBrowser: () => void;
  closeSkillBrowser: () => void;
  openSkillDetailView: (skill: SkillDisplayInfo) => void;
  closeSkillDetailView: () => void;
  openConfigErrorDetail: (error: ConfigLoadError, label: string) => void;
  closeConfigErrorDetail: () => void;
  openWorktreeExitDialog: () => void;
  closeWorktreeExitDialog: (choice: 'keep' | 'remove', message: string) => void;
  openPluginBrowser: (args?: string) => void;
  closePluginBrowser: () => void;
  setShellModeActive: (value: boolean) => void;
  handleFolderTrustSelect: (choice: FolderTrustChoice) => void;
  handleMcpApproval: (results: McpApprovalResult[]) => void;
  handleExternalImportApproval: (result: ExternalImportApprovalResult) => void;
  handlePeerInboundApproval: (result: PeerInboundApprovalResult) => void;
  setConstrainHeight: (value: boolean) => void;
  onEscapePromptChange: (show: boolean) => void;
  requestRender: () => void;
  handleFinalSubmit: (
    value: string,
    imagePastedContents?: Record<number, PastedContent>,
    preExpansionText?: string,
    slashCommandSource?: import('@qwen-code/core').SlashCommandSource,
    suppressWorkflowKeyword?: boolean,
  ) => Promise<void>;
  handleClearScreen: () => void;
  openSessionBrowser: (options?: SessionBrowserOpenOptions) => void;
  closeSessionBrowser: () => void;
  openRewindDialog: () => void;
  handleResumeSession: (session: SessionInfo) => Promise<void>;
  handleDeleteSession: (session: SessionInfo) => Promise<void>;
  setQueueErrorMessage: (message: string | null) => void;
  addMessage: (
    message: string,
    options?: {
      pastedContents?: Record<number, PastedContent>;
      preExpansionText?: string;
      suppressWorkflowKeyword?: boolean;
    },
  ) => void;
  popAllMessages: () => string | undefined;
  /**
   * Interrupt the running model turn so the queued user prompts are sent as
   * the next turn. No-op when the queue holds no user prompt.
   */
  sendQueuedNow: () => void;
  setShortcutsHelpVisible: (visible: boolean) => void;
  setCleanUiDetailsVisible: (visible: boolean) => void;
  toggleCleanUiDetailsVisible: () => void;
  revealCleanUiDetailsTemporarily: (durationMs?: number) => void;
  handleWarning: (message: string) => void;
  openBackgroundTaskList: () => boolean;
  viewAgentSession: (taskId: string) => void;
  viewWorkflowSessions: () => void;
  viewWorkflowSession: (taskId: string) => void;
  viewMainSession: () => void;
  onHintInput: (char: string) => void;
  onHintBackspace: () => void;
  onHintClear: () => void;
  onHintSubmit: (hint: string) => void;
  handleRestart: () => void;
  getPreferredEditor: () => EditorType | undefined;
  runAgent: (name: string, query: string) => void;
  setInputText: (text: string) => void;
}

export const UIActionsContext = createContext<UIActions | null>(null);

export const useUIActions = () => {
  const context = useContext(UIActionsContext);
  if (!context) {
    throw new Error('useUIActions must be used within a UIActionsProvider');
  }
  return context;
};
