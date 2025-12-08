/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config , AuthType } from '@qwen-code/qwen-code-core';
import { useCallback, useEffect } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { AuthState } from '../types.js';
import type { HistoryItem } from '../types.js';

// Simplified for offline/local-only mode
export const useAuthCommand = (
  settings: LoadedSettings,
  config: Config,
  _addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void,
) => {
  // Always authenticated
  const authState = AuthState.Authenticated;
  const isAuthDialogOpen = false;
  const isAuthenticating = false;
  const pendingAuthType: AuthType | undefined = undefined;
  const authError = null;

  // Stubbed Qwen auth state since we aren't using it
  const qwenAuthState = {
    deviceAuth: null,
    authStatus: 'idle' as const,
    authMessage: null,
  };

  // No-op handlers
  const onAuthError = useCallback(
    (error: string | null) => {
      // Log but don't show dialog in this enforced mode
      if (config.getDebugMode()) {
        console.debug('Auth error (suppressed):', error);
      }
    },
    [config],
  );

  const handleAuthSelect = useCallback(async () => {
    // No-op
  }, []);

  const openAuthDialog = useCallback(() => {
    // No-op
  }, []);

  const cancelAuthentication = useCallback(() => {
    // No-op
  }, []);

  const setAuthState = useCallback((_state: AuthState) => {
    // No-op
  }, []);

  // Ensure settings reflect Ollama usage if not already
  useEffect(() => {
    // If not set or different, force update settings (optional, but good for consistency)
    // However, config defaults handle the logic.
    // We intentionally avoid modifying settings file automatically to prevent thrashing
  }, []);

  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
    isAuthDialogOpen,
    isAuthenticating,
    pendingAuthType,
    qwenAuthState,
    handleAuthSelect,
    openAuthDialog,
    cancelAuthentication,
  };
};
