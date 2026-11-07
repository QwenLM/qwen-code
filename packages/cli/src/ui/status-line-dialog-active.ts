/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UIState } from './contexts/UIStateContext.js';

// Keep the preview's reservation aligned with DialogManager's modal priority.
export function isStatusLineDialogActive(state: UIState): boolean {
  return Boolean(
    state.isStatusLineDialogOpen &&
      !(state.showWelcomeBackDialog && state.welcomeBackInfo?.hasHistory) &&
      !(state.showWorktreeExitDialog && state.activeWorktree) &&
      !state.showIdeRestartPrompt &&
      !state.shouldShowIdePrompt &&
      !state.shouldShowCommandMigrationNudge &&
      !state.isFolderTrustDialogOpen &&
      !(state.isMcpApprovalDialogOpen && state.currentMcpApproval) &&
      !(state.isProjectHooksApprovalDialogOpen && state.pendingProjectHooks) &&
      !state.shellConfirmationRequest &&
      !state.loopDetectionConfirmationRequest &&
      !state.confirmationRequest &&
      !(
        state.confirmUpdateExtensionRequests.length > 0 &&
        !state.isExtensionsManagerDialogOpen
      ) &&
      !state.providerUpdateRequest &&
      !(
        state.settingInputRequests.length > 0 &&
        !state.isExtensionsManagerDialogOpen
      ) &&
      !(
        state.pluginChoiceRequests.length > 0 &&
        !state.isExtensionsManagerDialogOpen
      ) &&
      !state.isThemeDialogOpen &&
      !state.isEditorDialogOpen &&
      !state.isModelDialogOpen &&
      !state.isSettingsDialogOpen,
  );
}
