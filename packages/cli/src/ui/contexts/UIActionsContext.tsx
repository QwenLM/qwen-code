/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import { type Key } from '../hooks/useKeypress.js';
import { type IdeIntegrationNudgeResult } from '../IdeIntegrationNudge.js';
import { type CommandMigrationNudgeResult } from '../CommandFormatMigrationNudge.js';
import { type FolderTrustChoice } from '../components/FolderTrustDialog.js';
import { type EditorType, type ApprovalMode } from '@qwen-code/qwen-code-core';
import { type SettingScope } from '../../config/settings.js';
import type { AuthController } from '../auth/useAuth.js';
import type { HistoryItem } from '../types.js';
import type { RestoreOption } from '../components/RewindSelector.js';
import { type ArenaDialogType } from '../hooks/useArenaCommand.js';
import type { StatusLinePresetConfig } from '../statusLinePresets.js';

export type HelpTab = 'general' | 'commands' | 'custom-commands';

export interface UIActions {
  openThemeDialog: () => void;
  openEditorDialog: () => void;
  openMemoryDialog: () => void;
  handleThemeSelect: (
    themeName: string | undefined,
    scope: SettingScope,
  ) => void;
  handleThemeHighlight: (themeName: string | undefined) => void;
  handleApprovalModeSelect: (
    mode: ApprovalMode | undefined,
    scope: SettingScope,
  ) => void;
  auth: AuthController['actions'];
  handleEditorSelect: (
    editorType: EditorType | undefined,
    scope: SettingScope,
  ) => void;
  exitEditorDialog: () => void;
  closeSettingsDialog: () => void;
  closeStatusLineDialog: () => void;
  notifyStatusLineSettingsChanged: (config: StatusLinePresetConfig) => void;
  closeMemoryDialog: () => void;
  closeModelDialog: () => void;
  openModelDialog: (options?: { fastModelMode?: boolean }) => void;
  openArenaDialog: (type: Exclude<ArenaDialogType, null>) => void;
  closeArenaDialog: () => void;
  handleArenaModelsSelected?: (models: string[]) => void;
  dismissProviderUpdate: () => void;
  closeTrustDialog: () => void;
  closePermissionsDialog: () => void;
  setShellModeActive: (value: boolean) => void;
  vimHandleInput: (key: Key) => boolean;
  handleIdePromptComplete: (result: IdeIntegrationNudgeResult) => void;
  handleCommandMigrationComplete: (result: CommandMigrationNudgeResult) => void;
  handleFolderTrustSelect: (choice: FolderTrustChoice) => void;
  setConstrainHeight: (value: boolean) => void;
  onEscapePromptChange: (show: boolean) => void;
  onTabConsumerChange: (active: boolean) => void;
  refreshStatic: () => void;
  handleFinalSubmit: (value: string) => void;
  handleRetryLastPrompt: () => void;
  handleClearScreen: () => void;
  popAllQueuedMessages: () => string | null;
  // Welcome back dialog
  handleWelcomeBackSelection: (choice: 'continue' | 'restart') => void;
  handleWelcomeBackClose: () => void;
  // Worktree exit dialog
  handleWorktreeExit: (
    choice: 'keep' | 'remove' | 'cancel',
  ) => void | Promise<void>;
  // Subagent dialogs
  closeSubagentCreateDialog: () => void;
  closeAgentsManagerDialog: () => void;
  // Skills manager dialog (`/skills`)
  openSkillsManagerDialog: () => void;
  closeSkillsManagerDialog: () => void;
  // Trigger a CommandService rebuild — dialogs that mutate settings
  // affecting the slash-command surface (e.g. SkillsManagerDialog)
  // call this after `setValue` so `/<skill-name>` and the skills
  // listing reflect the new state without restarting the CLI.
  reloadCommands: () => void | Promise<void>;
  // Replace the chat input buffer's text without submitting. Used by
  // dialogs that want to "pick" something into the prompt and let the
  // user review/edit before sending — e.g. SkillsManagerDialog Enter
  // closes the dialog and drops `/<skill-name>` into the input.
  setInputBuffer: (text: string) => void;
  // Extensions manager dialog
  closeExtensionsManagerDialog: () => void;
  // MCP dialog
  closeMcpDialog: () => void;
  // Hooks dialog
  openHooksDialog: () => void;
  // Hooks dialog
  closeHooksDialog: () => void;
  closeStatsDialog: () => void;
  // Resume session dialog
  openResumeDialog: () => void;
  closeResumeDialog: () => void;
  handleResume: (sessionId: string) => void;
  // Branch (fork) session
  handleBranch: (name?: string) => Promise<void>;
  // Delete session dialog
  openDeleteDialog: () => void;
  closeDeleteDialog: () => void;
  handleDelete: (sessionId: string) => void;
  handleDeleteMany: (sessionIds: string[]) => void;
  // Help dialog
  openHelpDialog: () => void;
  closeHelpDialog: () => void;
  setHelpTab: (tab: HelpTab) => void;
  // Feedback dialog
  openFeedbackDialog: () => void;
  closeFeedbackDialog: () => void;
  temporaryCloseFeedbackDialog: () => void;
  submitFeedback: (rating: number) => void;
  // Rewind selector
  openRewindSelector: () => void;
  closeRewindSelector: () => void;
  handleRewindConfirm: (userItem: HistoryItem, option: RestoreOption) => void;
  // Diff dialog
  openDiffDialog: () => void;
  closeDiffDialog: () => void;
}

export const UIActionsContext = createContext<UIActions | null>(null);

export const useUIActions = () => {
  const context = useContext(UIActionsContext);
  if (!context) {
    throw new Error('useUIActions must be used within a UIActionsProvider');
  }
  return context;
};
