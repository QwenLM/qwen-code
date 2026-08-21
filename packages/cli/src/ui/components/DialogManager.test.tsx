/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { waitFor } from '@testing-library/react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { DialogManager } from './DialogManager.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { UIActionsContext } from '../contexts/UIActionsContext.js';
import { UIStateContext } from '../contexts/UIStateContext.js';
import { AuthState } from '../types.js';

function createUiState() {
  return {
    constrainHeight: false,
    terminalHeight: 24,
    staticExtraHeight: 0,
    mainAreaWidth: 80,
    showWelcomeBackDialog: false,
    welcomeBackInfo: null,
    showWorktreeExitDialog: false,
    activeWorktree: null,
    showIdeRestartPrompt: false,
    shouldShowIdePrompt: false,
    shouldShowCommandMigrationNudge: false,
    isFolderTrustDialogOpen: false,
    isMcpApprovalDialogOpen: false,
    currentMcpApproval: undefined,
    shellConfirmationRequest: null,
    loopDetectionConfirmationRequest: null,
    confirmationRequest: null,
    confirmUpdateExtensionRequests: [],
    isExtensionsManagerDialogOpen: false,
    providerUpdateRequest: undefined,
    settingInputRequests: [],
    pluginChoiceRequests: [],
    isThemeDialogOpen: false,
    isEditorDialogOpen: false,
    isModelDialogOpen: false,
    isSettingsDialogOpen: false,
    isStatusLineDialogOpen: false,
    isMemoryDialogOpen: false,
    isHelpDialogOpen: false,
    isApprovalModeDialogOpen: false,
    isEffortDialogOpen: false,
    activeArenaDialog: null,
    auth: {
      authError: null,
      isAuthDialogOpen: true,
      isAuthenticating: true,
      pendingAuthType: AuthType.USE_COPILOT,
      externalAuthState: {
        title: 'GitHub Copilot Login',
        message: 'Enter the device code',
        detail: 'Expires in 900s',
      },
      qwenAuthState: {},
    },
  };
}

describe('DialogManager', () => {
  it('renders Copilot progress over AuthDialog and cancels it with Escape', async () => {
    const cancelAuthentication = vi.fn();
    const setAuthState = vi.fn();
    const uiActions = {
      auth: {
        cancelAuthentication,
        setAuthState,
        closeAuthDialog: vi.fn(),
        handleProviderSubmit: vi.fn(),
        onAuthError: vi.fn(),
      },
    };
    const config = {
      getAuthType: vi.fn(),
      getContentGeneratorConfig: vi.fn(),
    };
    const settings = { merged: { env: {}, modelProviders: {} } };

    const { lastFrame, stdin, unmount } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <UIStateContext.Provider value={createUiState() as never}>
          <UIActionsContext.Provider value={uiActions as never}>
            <ConfigContext.Provider value={config as never}>
              <SettingsContext.Provider value={settings as never}>
                <DialogManager addItem={vi.fn() as never} terminalWidth={80} />
              </SettingsContext.Provider>
            </ConfigContext.Provider>
          </UIActionsContext.Provider>
        </UIStateContext.Provider>
      </KeypressProvider>,
    );

    try {
      await waitFor(() => {
        expect(lastFrame()).toContain('GitHub Copilot Login');
        expect(lastFrame()).toContain('Enter the device code');
        expect(lastFrame()).toContain('Esc to cancel');
        expect(lastFrame()).not.toContain('Connect a Provider');
      });

      stdin.write('\u001b');

      await waitFor(() => {
        expect(cancelAuthentication).toHaveBeenCalledOnce();
        expect(setAuthState).toHaveBeenCalledWith(AuthState.Updating);
      });
    } finally {
      unmount();
    }
  });
});
