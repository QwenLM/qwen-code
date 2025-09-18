/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';
import { SettingScope } from '../../config/settings.js';
import type { AuthType } from '@qwen-code/qwen-code-core';

export interface DialogCloseOptions {
  // Theme dialog
  isThemeDialogOpen: boolean;
  handleThemeSelect: (theme: string | undefined, scope: SettingScope) => void;

  // Auth dialog
  isAuthDialogOpen: boolean;
  handleAuthSelect: (
    authType: AuthType | undefined,
    scope: SettingScope,
  ) => Promise<void>;
  selectedAuthType: AuthType | undefined;

  // Editor dialog
  isEditorDialogOpen: boolean;
  exitEditorDialog: () => void;

  // Settings dialog
  isSettingsDialogOpen: boolean;
  closeSettingsDialog: () => void;

  // Folder trust dialog
  isFolderTrustDialogOpen: boolean;

  // Privacy notice
  showPrivacyNotice: boolean;
  setShowPrivacyNotice: (show: boolean) => void;

  // Welcome back dialog
  showWelcomeBackDialog: boolean;
  handleWelcomeBackClose: () => void;

  // Quit confirmation dialog
  quitConfirmationRequest: {
    onConfirm: (shouldQuit: boolean, action?: string) => void;
  } | null;
}

/**
 * Hook that handles closing dialogs when Ctrl+C is pressed.
 * This mimics the ESC key behavior by calling the same handlers that ESC uses.
 * Returns true if a dialog was closed, false if no dialogs were open.
 */
export function useDialogClose(options: DialogCloseOptions) {
  const closeAnyOpenDialog = useCallback((): boolean => {
    // Check each dialog in priority order and close using the same logic as ESC key

    if (options.isThemeDialogOpen) {
      // Mimic ESC behavior: onSelect(undefined, selectedScope) - keeps current theme
      options.handleThemeSelect(undefined, SettingScope.User);
      return true;
    }

    if (options.isAuthDialogOpen) {
      // Mimic ESC behavior: only close if already authenticated (same as AuthDialog ESC logic)
      if (options.selectedAuthType !== undefined) {
        // Note: We don't await this since we want non-blocking behavior like ESC
        void options.handleAuthSelect(undefined, SettingScope.User);
      }
      // Note: AuthDialog prevents ESC exit if not authenticated, we follow same logic
      return true;
    }

    if (options.isEditorDialogOpen) {
      // Mimic ESC behavior: call onExit() directly
      options.exitEditorDialog();
      return true;
    }

    if (options.isSettingsDialogOpen) {
      // Mimic ESC behavior: onSelect(undefined, selectedScope)
      options.closeSettingsDialog();
      return true;
    }

    if (options.isFolderTrustDialogOpen) {
      // FolderTrustDialog doesn't expose close function, but ESC would prevent exit
      // We follow the same pattern - prevent exit behavior
      return true;
    }

    if (options.showPrivacyNotice) {
      // PrivacyNotice uses onExit callback
      options.setShowPrivacyNotice(false);
      return true;
    }

    if (options.showWelcomeBackDialog) {
      // WelcomeBack has its own close handler
      options.handleWelcomeBackClose();
      return true;
    }

    // Note: quitConfirmationRequest is NOT handled here anymore
    // It's handled specially in handleExit - ctrl+c in quit-confirm should exit immediately

    // No dialog was open
    return false;
  }, [options]);

  return { closeAnyOpenDialog };
}
