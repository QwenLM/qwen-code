/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { FolderTrustDialog } from './FolderTrustDialog.js';
import { ConsentPrompt } from './ConsentPrompt.js';
import { ThemeDialog } from './ThemeDialog.js';
import { SettingsDialogPanel } from './SettingsDialogPanel.js';
import { EditorSettingsDialog } from './EditorSettingsDialog.js';
import { SessionBrowser } from './SessionBrowser.js';
import { theme } from '../semantic-colors.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { AdminSettingsChangedDialog } from './AdminSettingsChangedDialog.js';
import { AgentDetailView } from './AgentDetailView.js';
import { AgentBrowser } from './AgentBrowser.js';
import { McpBrowser } from './McpBrowser.js';
import { McpServerApprovalDialog } from './McpServerApprovalDialog.js';
import { ExternalImportApprovalDialog } from './ExternalImportApprovalDialog.js';
import { PeerInboundApprovalDialog } from './PeerInboundApprovalDialog.js';
import { HooksBrowser } from './HooksBrowser.js';
import { HookDetailView } from './HookDetailView.js';
import { SkillBrowser } from './SkillBrowser.js';
import { SkillDetailView } from './SkillDetailView.js';
import { ConfigErrorDetailView } from './shared/ConfigErrorDetailView.js';
import { PluginBrowser } from './PluginBrowser/PluginSettings.js';
import { WorktreeExitDialog } from './WorktreeExitDialog.js';
import { useRegisterKeyboardContext } from '../contexts/KeyboardContextRegistry.js';

interface DialogManagerProps {
  terminalWidth: number;
}

// Props for DialogManager
export const DialogManager = ({ terminalWidth }: DialogManagerProps) => {
  const config = useConfig();
  const settings = useSettings();

  const uiState = useUIState();
  const uiActions = useUIActions();
  const {
    constrainHeight,
    terminalHeight,
    staticExtraHeight,
    terminalWidth: uiTerminalWidth,
  } = uiState;

  // ─── Keyboard Context Registration (Phase 1) ───
  // Compute whether any dialog is open (mirrors the if/else chain below).
  const isDialogOpen = !!(
    uiState.adminSettingsChanged ||
    uiState.isFolderTrustDialogOpen ||
    uiState.commandConfirmationRequest ||
    uiState.authConsentRequest ||
    uiState.confirmUpdateExtensionRequests.length > 0 ||
    uiState.isThemeDialogOpen ||
    uiState.isSettingsDialogOpen ||
    uiState.isHookConfigDialogOpen ||
    uiState.isEditorDialogOpen ||
    uiState.isSessionBrowserOpen ||
    uiState.isAgentBrowserOpen ||
    uiState.isAgentConfigDialogOpen ||
    uiState.isMcpBrowserOpen ||
    uiState.isHookBrowserOpen ||
    uiState.isSkillBrowserOpen ||
    uiState.isSkillDetailViewOpen ||
    uiState.isConfigErrorDetailOpen ||
    uiState.isWorktreeExitDialogOpen ||
    uiState.isPluginBrowserOpen ||
    uiState.peerInboundApprovalRequest
  );
  useRegisterKeyboardContext('Dialog', isDialogOpen);

  if (uiState.adminSettingsChanged) {
    return <AdminSettingsChangedDialog />;
  }
  if (uiState.isWorktreeExitDialogOpen) {
    const worktreeSettings = config?.getWorktreeSettings();
    if (worktreeSettings) {
      return (
        <WorktreeExitDialog
          worktreeSettings={worktreeSettings}
          onDone={uiActions.closeWorktreeExitDialog}
        />
      );
    }
  }
  if (uiState.isFolderTrustDialogOpen) {
    return (
      <FolderTrustDialog
        onSelect={uiActions.handleFolderTrustSelect}
        discoveryResults={uiState.folderDiscoveryResults}
      />
    );
  }
  if (
    uiState.isMcpApprovalDialogOpen &&
    Object.keys(uiState.pendingProjectMcpServers).length > 0
  ) {
    return (
      <McpServerApprovalDialog
        pendingServers={uiState.pendingProjectMcpServers}
        onComplete={uiActions.handleMcpApproval}
      />
    );
  }
  if (
    uiState.isExternalImportApprovalOpen &&
    uiState.pendingExternalImports.length > 0
  ) {
    return (
      <ExternalImportApprovalDialog
        pendingImports={uiState.pendingExternalImports}
        onComplete={uiActions.handleExternalImportApproval}
      />
    );
  }
  // commandConfirmationRequest and authConsentRequest are kept separate
  // to avoid focus deadlocks and state race conditions between the
  // synchronous command loop and the asynchronous auth flow.
  if (uiState.commandConfirmationRequest) {
    return (
      <ConsentPrompt
        prompt={uiState.commandConfirmationRequest.prompt}
        onConfirm={uiState.commandConfirmationRequest.onConfirm}
        onCancel={uiState.commandConfirmationRequest.onCancel}
        showCancelOption={uiState.commandConfirmationRequest.showCancelOption}
        hideTitle={uiState.commandConfirmationRequest.hideTitle}
        confirmLabel={uiState.commandConfirmationRequest.confirmLabel}
        cancelLabel={uiState.commandConfirmationRequest.cancelLabel}
        terminalWidth={terminalWidth}
      />
    );
  }
  if (uiState.authConsentRequest) {
    return (
      <ConsentPrompt
        prompt={uiState.authConsentRequest.prompt}
        onConfirm={uiState.authConsentRequest.onConfirm}
        showCancelOption={uiState.authConsentRequest.showCancelOption}
        hideTitle={uiState.authConsentRequest.hideTitle}
        confirmLabel={uiState.authConsentRequest.confirmLabel}
        cancelLabel={uiState.authConsentRequest.cancelLabel}
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
        onCancel={request.onCancel}
        showCancelOption={request.showCancelOption}
        hideTitle={request.hideTitle}
        confirmLabel={request.confirmLabel}
        cancelLabel={request.cancelLabel}
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
          onCancel={uiActions.closeThemeDialog}
          onHighlight={uiActions.handleThemeHighlight}
          settings={settings}
          availableTerminalHeight={
            constrainHeight ? terminalHeight - staticExtraHeight : undefined
          }
          terminalWidth={uiTerminalWidth}
        />
      </Box>
    );
  }
  if (uiState.isSettingsDialogOpen) {
    return <SettingsDialogPanel onClose={uiActions.closeSettingsDialog} />;
  }
  if (
    uiState.isAgentConfigDialogOpen &&
    uiState.selectedAgentName &&
    uiState.selectedAgentDefinition
  ) {
    return (
      <AgentDetailView
        agentName={uiState.selectedAgentName}
        description={uiState.selectedAgentDefinition.description ?? ''}
        definition={uiState.selectedAgentDefinition}
        filePath={uiState.selectedAgentDefinition.metadata?.filePath}
        source={uiState.selectedAgentDefinition.metadata?.source}
        config={config}
        settings={settings}
        onClose={uiActions.closeAgentConfigDialog}
        onSave={async () => {
          // Reload agent registry to pick up changes
          const agentRegistry = config?.getAgentRegistry();
          if (agentRegistry) {
            await agentRegistry.reload();
          }
        }}
        onRunAgent={(name: string, query: string) => {
          uiActions.runAgent(name, query);
        }}
      />
    );
  }
  if (uiState.isHookConfigDialogOpen && uiState.selectedHookEntry) {
    return (
      <HookDetailView
        hookEntry={uiState.selectedHookEntry}
        config={config}
        settings={settings}
        onClose={uiActions.closeHookConfigDialog}
        onSave={uiActions.closeHookConfigDialog}
      />
    );
  }
  if (uiState.isSkillDetailViewOpen && uiState.selectedSkillInfo) {
    // Look up any tolerated-load warning for this skill (e.g. YAML fallback)
    const skillWarning = config
      ?.getSkillManager()
      ?.getLoadErrors()
      ?.find(
        (e) =>
          e.severity === 'warning' &&
          e.name === uiState.selectedSkillInfo?.name,
      );
    return (
      <SkillDetailView
        skill={uiState.selectedSkillInfo}
        config={config}
        settings={settings}
        onClose={uiActions.closeSkillDetailView}
        onSave={async () => {
          await config?.reloadSkills();
        }}
        loadWarning={skillWarning}
      />
    );
  }
  if (uiState.isConfigErrorDetailOpen && uiState.selectedConfigError) {
    return (
      <ConfigErrorDetailView
        error={uiState.selectedConfigError}
        configLabel={uiState.configErrorLabel ?? 'config'}
        onClose={uiActions.closeConfigErrorDetail}
      />
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
  if (uiState.isSessionBrowserOpen) {
    return (
      <SessionBrowser
        config={config}
        currentGitBranch={uiState.branchName}
        initialSearchQuery={uiState.sessionBrowserInitialSearchQuery}
        onResumeSession={uiActions.handleResumeSession}
        onDeleteSession={uiActions.handleDeleteSession}
        onExit={uiActions.closeSessionBrowser}
      />
    );
  }

  if (uiState.isAgentBrowserOpen) {
    return (
      <AgentBrowser
        config={config}
        settings={settings}
        activeSourceTab={uiState.agentBrowserActiveTab}
        onSourceTabChange={uiActions.setAgentBrowserActiveTab}
        onOpenConfig={(name, definition) => {
          uiActions.openAgentConfigDialog(name, definition);
        }}
        onCreateAgent={(prompt) => {
          uiActions.closeAgentBrowser();
          uiActions.closeAgentConfigDialog();
          void uiActions.handleFinalSubmit(prompt);
        }}
        onExit={uiActions.closeAgentBrowser}
      />
    );
  }

  if (uiState.isSkillBrowserOpen) {
    return (
      <SkillBrowser
        config={config}
        settings={settings}
        onOpenConfig={(skill) => {
          uiActions.openSkillDetailView(skill);
        }}
        onCreateSkill={(prompt) => {
          uiActions.closeSkillBrowser();
          uiActions.closeSkillDetailView();
          void uiActions.handleFinalSubmit(prompt);
        }}
        onExit={uiActions.closeSkillBrowser}
      />
    );
  }

  if (uiState.isPluginBrowserOpen) {
    return (
      <PluginBrowser
        config={config}
        settings={settings}
        args={uiState.pluginBrowserArgs}
        errors={config?.getPluginErrors() ?? []}
        onExit={uiActions.closePluginBrowser}
      />
    );
  }

  if (uiState.isMcpBrowserOpen) {
    return (
      <McpBrowser
        config={config}
        settings={settings}
        onCreateMcpServer={(prompt) => {
          uiActions.closeMcpBrowser();
          void uiActions.handleFinalSubmit(prompt);
        }}
        onExit={uiActions.closeMcpBrowser}
      />
    );
  }

  if (uiState.isHookBrowserOpen) {
    return (
      <HooksBrowser
        config={config}
        settings={settings}
        allHooksDisabled={settings.merged.disableAllHooks === true}
        onOpenConfig={(hookEntry) => {
          uiActions.openHookConfigDialog(hookEntry);
        }}
        onCreateHook={(prompt) => {
          uiActions.closeHookBrowser();
          uiActions.closeHookConfigDialog();
          void uiActions.handleFinalSubmit(prompt);
        }}
        onExit={uiActions.closeHookBrowser}
      />
    );
  }

  // Last of every branch, because inbound peer traffic is the only thing here
  // the user did not ask for: it waits behind anything they opened themselves
  // rather than displacing a prompt they are mid-answer on. The hook declines to
  // take the question at all while another surface owns the screen, so a message
  // that would render nowhere stays queued for `/peers` instead.
  if (uiState.peerInboundApprovalRequest) {
    return (
      <PeerInboundApprovalDialog
        request={uiState.peerInboundApprovalRequest}
        onComplete={uiActions.handlePeerInboundApproval}
      />
    );
  }

  return null;
};
