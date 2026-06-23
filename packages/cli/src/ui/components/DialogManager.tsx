/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { IdeIntegrationNudge } from '../IdeIntegrationNudge.js';
import { CommandFormatMigrationNudge } from '../CommandFormatMigrationNudge.js';
import { LoopDetectionConfirmation } from './LoopDetectionConfirmation.js';
import { FolderTrustDialog } from './FolderTrustDialog.js';
import { MCPServerApprovalDialog } from './mcp/MCPServerApprovalDialog.js';
import { ShellConfirmationDialog } from './ShellConfirmationDialog.js';
import { ConsentPrompt } from './ConsentPrompt.js';
import { ProviderUpdatePrompt } from './ProviderUpdatePrompt.js';
import { SettingInputPrompt } from './SettingInputPrompt.js';
import { PluginChoicePrompt } from './PluginChoicePrompt.js';
import { ThemeDialog } from './ThemeDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
import { StatusLineDialog } from './StatusLineDialog.js';
import { QwenOAuthProgress } from './QwenOAuthProgress.js';
import { ExternalAuthProgress } from './ExternalAuthProgress.js';
import { AuthDialog } from '../auth/AuthDialog.js';
import { EditorSettingsDialog } from './EditorSettingsDialog.js';
import { TrustDialog } from './TrustDialog.js';
import { PermissionsDialog } from './PermissionsDialog.js';
import { ModelDialog } from './ModelDialog.js';
import { ArenaStartDialog } from './arena/ArenaStartDialog.js';
import { ArenaSelectDialog } from './arena/ArenaSelectDialog.js';
import { ArenaStopDialog } from './arena/ArenaStopDialog.js';
import { ArenaStatusDialog } from './arena/ArenaStatusDialog.js';
import { ApprovalModeDialog } from './ApprovalModeDialog.js';
import { theme } from '../semantic-colors.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { AuthState } from '../types.js';
import { AuthType } from '@qwen-code/qwen-code-core';
import process from 'node:process';
import { type UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import { IdeTrustChangeDialog } from './IdeTrustChangeDialog.js';
import { WelcomeBackDialog } from './WelcomeBackDialog.js';
import { WorktreeExitDialog } from './WorktreeExitDialog.js';
import { AgentCreationWizard } from './subagents/create/AgentCreationWizard.js';
import { AgentsManagerDialog } from './subagents/manage/AgentsManagerDialog.js';
import { SkillsManagerDialog } from './skills/SkillsManagerDialog.js';
import { ExtensionsManagerDialog } from './extensions/ExtensionsManagerDialog.js';
import { MCPManagementDialog } from './mcp/MCPManagementDialog.js';
import { HooksManagementDialog } from './hooks/HooksManagementDialog.js';
import { StatsDialog } from './StatsDialog.js';
import { SessionPicker } from './SessionPicker.js';
import { RewindSelector } from './RewindSelector.js';
import { DiffDialog } from './DiffDialog.js';
import { MemoryDialog } from './MemoryDialog.js';
import { Help } from './Help.js';
import { BackgroundTasksDialog } from './background-view/BackgroundTasksDialog.js';
import { useBackgroundTaskViewState } from '../contexts/BackgroundTaskViewContext.js';
import { t } from '../../i18n/index.js';
import { getDialogMaxHeight } from '../utils/layoutUtils.js';

interface DialogManagerProps {
  addItem: UseHistoryManagerReturn['addItem'];
  terminalWidth: number;
}

// Props for DialogManager
export const DialogManager = ({
  addItem,
  terminalWidth,
}: DialogManagerProps) => {
  const config = useConfig();
  const settings = useSettings();

  const uiState = useUIState();
  const uiActions = useUIActions();
  const { dialogOpen: bgTasksDialogOpen } = useBackgroundTaskViewState();
  const { constrainHeight, terminalHeight, staticExtraHeight, mainAreaWidth } =
    uiState;
  const dialogMaxHeight = getDialogMaxHeight(terminalHeight, staticExtraHeight);
  const constrainedDialogHeight = constrainHeight ? dialogMaxHeight : undefined;
  // Long list-style dialogs use this finite budget for their own internal
  // virtualization even when the outer app layout is not height-constrained.
  const listDialogHeight = dialogMaxHeight;

  if (uiState.showWelcomeBackDialog && uiState.welcomeBackInfo?.hasHistory) {
    return (
      <WelcomeBackDialog
        welcomeBackInfo={uiState.welcomeBackInfo}
        onSelect={uiActions.handleWelcomeBackSelection}
        onClose={uiActions.handleWelcomeBackClose}
      />
    );
  }
  if (uiState.showWorktreeExitDialog && uiState.activeWorktree) {
    return (
      <WorktreeExitDialog
        slug={uiState.activeWorktree.slug}
        branch={uiState.activeWorktree.branch}
        worktreePath={uiState.activeWorktree.path}
        originalHeadCommit={uiState.activeWorktree.originalHeadCommit}
        onKeep={() => void uiActions.handleWorktreeExit('keep')}
        onRemove={() => void uiActions.handleWorktreeExit('remove')}
        onCancel={() => void uiActions.handleWorktreeExit('cancel')}
      />
    );
  }
  if (uiState.showIdeRestartPrompt) {
    return <IdeTrustChangeDialog reason={uiState.ideTrustRestartReason} />;
  }
  if (uiState.shouldShowIdePrompt) {
    return (
      <IdeIntegrationNudge
        ide={uiState.currentIDE!}
        onComplete={uiActions.handleIdePromptComplete}
      />
    );
  }
  if (uiState.shouldShowCommandMigrationNudge) {
    return (
      <CommandFormatMigrationNudge
        tomlFiles={uiState.commandMigrationTomlFiles}
        onComplete={uiActions.handleCommandMigrationComplete}
      />
    );
  }
  if (uiState.isFolderTrustDialogOpen) {
    return (
      <FolderTrustDialog
        onSelect={uiActions.handleFolderTrustSelect}
        isRestarting={uiState.isRestarting}
      />
    );
  }
  if (uiState.isMcpApprovalDialogOpen && uiState.currentMcpApproval) {
    return (
      <MCPServerApprovalDialog
        serverName={uiState.currentMcpApproval.name}
        summary={uiState.currentMcpApproval.summary}
        source={uiState.currentMcpApproval.source}
        pendingServers={uiState.pendingMcpApprovals}
        remaining={uiState.mcpApprovalRemaining}
        onSelect={uiActions.handleMcpApprovalSelect}
      />
    );
  }
  if (uiState.shellConfirmationRequest) {
    return (
      <ShellConfirmationDialog
        request={uiState.shellConfirmationRequest}
        availableTerminalHeight={constrainedDialogHeight}
        contentWidth={mainAreaWidth}
      />
    );
  }
  if (uiState.loopDetectionConfirmationRequest) {
    return (
      <LoopDetectionConfirmation
        onComplete={uiState.loopDetectionConfirmationRequest.onComplete}
      />
    );
  }
  if (uiState.confirmationRequest) {
    return (
      <ConsentPrompt
        prompt={uiState.confirmationRequest.prompt}
        onConfirm={uiState.confirmationRequest.onConfirm}
        terminalWidth={terminalWidth}
        availableTerminalHeight={constrainedDialogHeight}
      />
    );
  }
  // Extension install/update requests (consent, setting input, plugin choice)
  // are rendered inside the ExtensionsManagerDialog when it is open, so the
  // dialog keeps its tab/list state instead of being unmounted.
  if (
    uiState.confirmUpdateExtensionRequests.length > 0 &&
    !uiState.isExtensionsManagerDialogOpen
  ) {
    const request = uiState.confirmUpdateExtensionRequests[0];
    return (
      <ConsentPrompt
        prompt={request.prompt}
        onConfirm={request.onConfirm}
        terminalWidth={terminalWidth}
        availableTerminalHeight={constrainedDialogHeight}
      />
    );
  }
  if (uiState.providerUpdateRequest) {
    return (
      <ProviderUpdatePrompt
        entries={uiState.providerUpdateRequest.entries}
        onConfirm={uiState.providerUpdateRequest.onConfirm}
      />
    );
  }
  if (
    uiState.settingInputRequests.length > 0 &&
    !uiState.isExtensionsManagerDialogOpen
  ) {
    const request = uiState.settingInputRequests[0];
    // Use settingName as key to force re-mount when switching between different settings
    return (
      <SettingInputPrompt
        key={request.settingName}
        settingName={request.settingName}
        settingDescription={request.settingDescription}
        sensitive={request.sensitive}
        onSubmit={request.onSubmit}
        onCancel={request.onCancel}
        terminalWidth={terminalWidth}
      />
    );
  }
  if (
    uiState.pluginChoiceRequests.length > 0 &&
    !uiState.isExtensionsManagerDialogOpen
  ) {
    const request = uiState.pluginChoiceRequests[0];
    return (
      <PluginChoicePrompt
        key={request.marketplaceName}
        marketplaceName={request.marketplaceName}
        plugins={request.plugins}
        onSelect={request.onSelect}
        onCancel={request.onCancel}
        terminalWidth={terminalWidth}
      />
    );
  }
  if (uiState.isThemeDialogOpen) {
    return (
      <Box flexDirection="column">
        {uiState.themeError && (
          <Box marginBottom={1}>
            <Text color={theme.status.error}>{uiState.themeError}</Text>
          </Box>
        )}
        <ThemeDialog
          onSelect={uiActions.handleThemeSelect}
          onHighlight={uiActions.handleThemeHighlight}
          settings={settings}
          availableTerminalHeight={constrainedDialogHeight}
          terminalWidth={mainAreaWidth}
        />
      </Box>
    );
  }
  if (uiState.isEditorDialogOpen) {
    return (
      <Box flexDirection="column">
        {uiState.editorError && (
          <Box marginBottom={1}>
            <Text color={theme.status.error}>{uiState.editorError}</Text>
          </Box>
        )}
        <EditorSettingsDialog
          onSelect={uiActions.handleEditorSelect}
          settings={settings}
          onExit={uiActions.exitEditorDialog}
        />
      </Box>
    );
  }
  if (uiState.isModelDialogOpen) {
    return (
      <ModelDialog
        onClose={uiActions.closeModelDialog}
        isFastModelMode={uiState.isFastModelMode}
        isVoiceModelMode={uiState.isVoiceModelMode}
        isVisionModelMode={uiState.isVisionModelMode}
      />
    );
  }
  if (uiState.isSettingsDialogOpen) {
    return (
      <Box flexDirection="column">
        <SettingsDialog
          settings={settings}
          onSelect={(settingName) => {
            if (settingName === 'ui.theme') {
              uiActions.openThemeDialog();
              return;
            }
            if (settingName === 'general.preferredEditor') {
              uiActions.openEditorDialog();
              return;
            }
            if (settingName === 'fastModel') {
              uiActions.openModelDialog({ fastModelMode: true });
              return;
            }
            if (settingName === 'visionModel') {
              uiActions.openModelDialog({ visionModelMode: true });
              return;
            }
            uiActions.closeSettingsDialog();
          }}
          onRestartRequest={() => process.exit(0)}
          availableTerminalHeight={listDialogHeight}
          config={config}
        />
      </Box>
    );
  }
  if (uiState.isStatusLineDialogOpen) {
    return (
      <StatusLineDialog
        settings={settings}
        config={config}
        uiState={uiState}
        addItem={addItem}
        onSaved={uiActions.notifyStatusLineSettingsChanged}
        onClose={uiActions.closeStatusLineDialog}
        availableTerminalHeight={listDialogHeight}
      />
    );
  }
  if (uiState.isMemoryDialogOpen) {
    return <MemoryDialog onClose={uiActions.closeMemoryDialog} />;
  }
  if (uiState.isHelpDialogOpen) {
    return (
      <Help
        commands={uiState.slashCommands}
        width={mainAreaWidth}
        activeTab={uiState.activeHelpTab}
        onTabChange={uiActions.setHelpTab}
        onClose={uiActions.closeHelpDialog}
        isInteractive
      />
    );
  }
  if (uiState.isApprovalModeDialogOpen) {
    const currentMode = config.getApprovalMode();
    return (
      <Box flexDirection="column">
        <ApprovalModeDialog
          settings={settings}
          currentMode={currentMode}
          onSelect={uiActions.handleApprovalModeSelect}
          availableTerminalHeight={constrainedDialogHeight}
        />
      </Box>
    );
  }
  if (uiState.activeArenaDialog === 'start') {
    return (
      <ArenaStartDialog
        onClose={() => uiActions.closeArenaDialog()}
        onConfirm={(models) => uiActions.handleArenaModelsSelected?.(models)}
      />
    );
  }
  if (uiState.activeArenaDialog === 'status') {
    const arenaManager = config.getArenaManager();
    if (arenaManager) {
      return (
        <ArenaStatusDialog
          manager={arenaManager}
          closeArenaDialog={uiActions.closeArenaDialog}
          width={mainAreaWidth}
        />
      );
    }
  }
  if (uiState.activeArenaDialog === 'stop') {
    return (
      <ArenaStopDialog
        config={config}
        addItem={addItem}
        closeArenaDialog={uiActions.closeArenaDialog}
      />
    );
  }
  if (uiState.activeArenaDialog === 'select') {
    const arenaManager = config.getArenaManager();
    if (arenaManager) {
      return (
        <ArenaSelectDialog
          manager={arenaManager}
          config={config}
          addItem={addItem}
          closeArenaDialog={uiActions.closeArenaDialog}
        />
      );
    }
  }

  if (uiState.auth.isAuthDialogOpen || uiState.auth.authError) {
    return (
      <Box flexDirection="column">
        <AuthDialog />
      </Box>
    );
  }

  if (uiState.auth.isAuthenticating) {
    if (
      uiState.auth.pendingAuthType === AuthType.USE_OPENAI &&
      uiState.auth.externalAuthState
    ) {
      return (
        <ExternalAuthProgress
          title={uiState.auth.externalAuthState.title}
          message={uiState.auth.externalAuthState.message}
          detail={uiState.auth.externalAuthState.detail}
          onCancel={() => {
            uiActions.auth.cancelAuthentication();
            uiActions.auth.setAuthState(AuthState.Updating);
          }}
        />
      );
    }

    // OpenAI authentication now handled through AuthDialog with coding-plan/custom sub-modes
    // Qwen OAuth remains as a separate flow
    if (uiState.auth.pendingAuthType === AuthType.QWEN_OAUTH) {
      return (
        <QwenOAuthProgress
          deviceAuth={uiState.auth.qwenAuthState.deviceAuth || undefined}
          authStatus={uiState.auth.qwenAuthState.authStatus}
          authMessage={uiState.auth.qwenAuthState.authMessage}
          onTimeout={() => {
            uiActions.auth.onAuthError('Qwen OAuth authentication timed out.');
            uiActions.auth.cancelAuthentication();
            uiActions.auth.setAuthState(AuthState.Updating);
          }}
          onCancel={() => {
            uiActions.auth.cancelAuthentication();
            uiActions.auth.setAuthState(AuthState.Updating);
          }}
        />
      );
    }
  }
  if (uiState.isTrustDialogOpen) {
    return (
      <TrustDialog onExit={uiActions.closeTrustDialog} addItem={addItem} />
    );
  }

  if (uiState.isPermissionsDialogOpen) {
    return <PermissionsDialog onExit={uiActions.closePermissionsDialog} />;
  }

  if (uiState.isSubagentCreateDialogOpen) {
    return (
      <AgentCreationWizard
        onClose={uiActions.closeSubagentCreateDialog}
        config={config}
      />
    );
  }

  if (uiState.isAgentsManagerDialogOpen) {
    return (
      <AgentsManagerDialog
        onClose={uiActions.closeAgentsManagerDialog}
        config={config}
      />
    );
  }

  if (uiState.isSkillsManagerDialogOpen) {
    return (
      <SkillsManagerDialog
        settings={settings}
        config={config}
        addItem={addItem}
        onClose={uiActions.closeSkillsManagerDialog}
        reloadCommands={uiActions.reloadCommands}
        setInputBuffer={uiActions.setInputBuffer}
        availableTerminalHeight={constrainedDialogHeight}
      />
    );
  }

  if (uiState.isExtensionsManagerDialogOpen) {
    return (
      <ExtensionsManagerDialog
        onClose={uiActions.closeExtensionsManagerDialog}
        config={config}
      />
    );
  }
  if (uiState.isHooksDialogOpen) {
    return <HooksManagementDialog onClose={uiActions.closeHooksDialog} />;
  }
  if (uiState.isStatsDialogOpen) {
    return (
      <StatsDialog onClose={uiActions.closeStatsDialog} width={mainAreaWidth} />
    );
  }
  if (uiState.isMcpDialogOpen) {
    return <MCPManagementDialog onClose={uiActions.closeMcpDialog} />;
  }

  if (uiState.isResumeDialogOpen) {
    return (
      <SessionPicker
        sessionService={config.getSessionService()}
        currentBranch={uiState.branchName}
        onSelect={uiActions.handleResume}
        onCancel={uiActions.closeResumeDialog}
        initialSessions={uiState.resumeMatchedSessions}
        enablePreview
      />
    );
  }

  if (uiState.isDeleteDialogOpen) {
    const currentSessionId = config.getSessionId();
    return (
      <SessionPicker
        sessionService={config.getSessionService()}
        currentBranch={uiState.branchName}
        onSelect={uiActions.handleDelete}
        onCancel={uiActions.closeDeleteDialog}
        title={t('Delete Session')}
        enableMultiSelect
        onConfirmMulti={uiActions.handleDeleteMany}
        disabledIds={currentSessionId ? [currentSessionId] : undefined}
      />
    );
  }

  if (uiState.isRewindSelectorOpen) {
    return (
      <RewindSelector
        history={uiState.history}
        onRewind={uiActions.handleRewindConfirm}
        onCancel={uiActions.closeRewindSelector}
        fileCheckpointingEnabled={config.getFileCheckpointingEnabled()}
        fileHistoryService={config.getFileHistoryService()}
      />
    );
  }

  if (uiState.isDiffDialogOpen) {
    return (
      <DiffDialog
        history={uiState.history}
        cwd={config.getWorkingDir() || config.getProjectRoot()}
        fileHistoryService={config.getFileHistoryService()}
        fileCheckpointingEnabled={config.getFileCheckpointingEnabled()}
        onClose={uiActions.closeDiffDialog}
      />
    );
  }

  // Background tasks dialog — lowest priority so other dialogs
  // (permissions, trust prompts, auth, etc.) always take precedence. The
  // dialog is part of the shared dialogsVisible machinery (see
  // AppContainer) so its visibility mutes the composer and the global
  // Ctrl+C / Esc handlers route through `closeAnyOpenDialog`.
  if (bgTasksDialogOpen) {
    return (
      <BackgroundTasksDialog
        availableTerminalHeight={listDialogHeight}
        terminalWidth={mainAreaWidth}
      />
    );
  }

  return null;
};
