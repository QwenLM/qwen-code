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
import { ShellConfirmationDialog } from './ShellConfirmationDialog.js';
import { ConsentPrompt } from './ConsentPrompt.js';
import { SettingInputPrompt } from './SettingInputPrompt.js';
import { PluginChoicePrompt } from './PluginChoicePrompt.js';
import { ThemeDialog } from './ThemeDialog.js';
import { SettingsDialog } from './SettingsDialog.js';
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
import { AgentCreationWizard } from './subagents/create/AgentCreationWizard.js';
import { AgentsManagerDialog } from './subagents/manage/AgentsManagerDialog.js';
import { ExtensionsManagerDialog } from './extensions/ExtensionsManagerDialog.js';
import { MCPManagementDialog } from './mcp/MCPManagementDialog.js';
import { HooksManagementDialog } from './hooks/HooksManagementDialog.js';
import { SessionPicker } from './SessionPicker.js';
import { MemoryDialog } from './MemoryDialog.js';
import { t } from '../../i18n/index.js';

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
  const { constrainHeight, terminalHeight, staticExtraHeight, mainAreaWidth } =
    uiState;

  if (uiState.showWelcomeBackDialog && uiState.welcomeBackInfo?.hasHistory) {
    return (
      <WelcomeBackDialog
        welcomeBackInfo={uiState.welcomeBackInfo}
        onSelect={uiActions.handleWelcomeBackSelection}
        onClose={uiActions.handleWelcomeBackClose}
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
  if (uiState.shellConfirmationRequest) {
    return (
      <ShellConfirmationDialog request={uiState.shellConfirmationRequest} />
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
      />
    );
  }
  if (uiState.confirmUpdateExtensionRequests.length > 0) {
    const request = uiState.confirmUpdateExtensionRequests[0];
    return (
      <ConsentPrompt
        prompt={request.prompt}
        onConfirm={request.onConfirm}
        terminalWidth={terminalWidth}
      />
    );
  }
  if (uiState.codingPlanUpdateRequest) {
    return (
      <ConsentPrompt
        prompt={uiState.codingPlanUpdateRequest.prompt}
        onConfirm={uiState.codingPlanUpdateRequest.onConfirm}
        terminalWidth={terminalWidth}
      />
    );
  }
  if (uiState.settingInputRequests.length > 0) {
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
  if (uiState.pluginChoiceRequests.length > 0) {
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
          availableTerminalHeight={
            constrainHeight ? terminalHeight - staticExtraHeight : undefined
          }
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
            uiActions.closeSettingsDialog();
          }}
          onRestartRequest={() => process.exit(0)}
          availableTerminalHeight={terminalHeight - staticExtraHeight}
          config={config}
        />
      </Box>
    );
  }
  if (uiState.isMemoryDialogOpen) {
    return <MemoryDialog onClose={uiActions.closeMemoryDialog} />;
  }
  if (uiState.isApprovalModeDialogOpen) {
    const currentMode = config.getApprovalMode();
    return (
      <Box flexDirection="column">
        <ApprovalModeDialog
          settings={settings}
          currentMode={currentMode}
          onSelect={uiActions.handleApprovalModeSelect}
          availableTerminalHeight={
            constrainHeight ? terminalHeight - staticExtraHeight : undefined
          }
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

  if (uiState.isAuthDialogOpen || uiState.authError) {
    return (
      <Box flexDirection="column">
        <AuthDialog />
      </Box>
    );
  }

  if (uiState.isAuthenticating) {
    if (
      uiState.pendingAuthType === AuthType.USE_OPENAI &&
      uiState.externalAuthState
    ) {
      return (
        <ExternalAuthProgress
          title={uiState.externalAuthState.title}
          message={uiState.externalAuthState.message}
          detail={uiState.externalAuthState.detail}
        />
      );
    }

    // OpenAI authentication now handled through AuthDialog with coding-plan/custom sub-modes
    // Qwen OAuth remains as a separate flow
    if (uiState.pendingAuthType === AuthType.QWEN_OAUTH) {
      return (
        <QwenOAuthProgress
          deviceAuth={uiState.qwenAuthState.deviceAuth || undefined}
          authStatus={uiState.qwenAuthState.authStatus}
          authMessage={uiState.qwenAuthState.authMessage}
          onTimeout={() => {
            uiActions.onAuthError('Qwen OAuth authentication timed out.');
            uiActions.cancelAuthentication();
            uiActions.setAuthState(AuthState.Updating);
          }}
          onCancel={() => {
            uiActions.cancelAuthentication();
            uiActions.setAuthState(AuthState.Updating);
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
      />
    );
  }

  if (uiState.isDeleteDialogOpen) {
    return (
      <SessionPicker
        sessionService={config.getSessionService()}
        currentBranch={uiState.branchName}
        onSelect={uiActions.handleDelete}
        onCancel={uiActions.closeDeleteDialog}
        title={t('Delete Session')}
      />
    );
  }

  return null;
};
