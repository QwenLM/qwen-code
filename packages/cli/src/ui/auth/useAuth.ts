/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import type { LoadedSettings, SettingScope } from '../../config/settings.js';
import type { AuthType, Config } from '@qwen-code/qwen-code-core';
import {
  clearCachedCredentialFile,
  getErrorMessage,
} from '@qwen-code/qwen-code-core';
import { AuthState } from '../types.js';
import { validateAuthMethod } from '../../config/auth.js';

export function validateAuthMethodWithSettings(
  authType: AuthType,
  settings: LoadedSettings,
): string | null {
  const enforcedType = settings.merged.security?.auth?.enforcedType;
  if (enforcedType && enforcedType !== authType) {
    return `Authentication is enforced to be ${enforcedType}, but you are currently using ${authType}.`;
  }
  if (settings.merged.security?.auth?.useExternal) {
    return null;
  }
  return validateAuthMethod(authType);
}

export const useAuthCommand = (settings: LoadedSettings, config: Config) => {
  const unAuthenticated =
    settings.merged.security?.auth?.selectedType === undefined;

  const [authState, setAuthState] = useState<AuthState>(
    unAuthenticated ? AuthState.Updating : AuthState.Unauthenticated,
  );

  const [authError, setAuthError] = useState<string | null>(null);

  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(unAuthenticated);

  const onAuthError = useCallback(
    (error: string | null) => {
      setAuthError(error);
      if (error) {
        setAuthState(AuthState.Updating);
        setIsAuthDialogOpen(true);
      }
    },
    [setAuthError, setAuthState],
  );

  // Authentication flow
  useEffect(() => {
    const authFlow = async () => {
      const authType = settings.merged.security?.auth?.selectedType;
      if (isAuthDialogOpen || !authType) {
        return;
      }

      const validationError = validateAuthMethodWithSettings(
        authType,
        settings,
      );
      if (validationError) {
        onAuthError(validationError);
        return;
      }

      try {
        setIsAuthenticating(true);
        await config.refreshAuth(authType);
        console.log(`Authenticated via "${authType}".`);
        setAuthError(null);
        setAuthState(AuthState.Authenticated);
      } catch (e) {
        onAuthError(`Failed to login. Message: ${getErrorMessage(e)}`);
      } finally {
        setIsAuthenticating(false);
      }
    };

    void authFlow();
  }, [isAuthDialogOpen, settings, config, onAuthError]);

  // Handle auth selection from dialog
  const handleAuthSelect = useCallback(
    async (
      authType: AuthType | undefined,
      scope: SettingScope,
      credentials?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      },
    ) => {
      if (authType) {
        await clearCachedCredentialFile();

        // Save OpenAI credentials if provided
        if (credentials) {
          // Update Config's internal generationConfig before calling refreshAuth
          // This ensures refreshAuth has access to the new credentials
          config.updateCredentials({
            apiKey: credentials.apiKey,
            baseUrl: credentials.baseUrl,
            model: credentials.model,
          });

          // Also set environment variables for compatibility with other parts of the code
          if (credentials.apiKey) {
            settings.setValue(
              scope,
              'security.auth.apiKey',
              credentials.apiKey,
            );
          }
          if (credentials.baseUrl) {
            settings.setValue(
              scope,
              'security.auth.baseUrl',
              credentials.baseUrl,
            );
          }
          if (credentials.model) {
            settings.setValue(scope, 'model.name', credentials.model);
          }
        }

        settings.setValue(scope, 'security.auth.selectedType', authType);
      }

      setIsAuthDialogOpen(false);
      setAuthError(null);
    },
    [settings, config],
  );

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const cancelAuthentication = useCallback(() => {
    setIsAuthenticating(false);
  }, []);

  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
    isAuthDialogOpen,
    isAuthenticating,
    handleAuthSelect,
    openAuthDialog,
    cancelAuthentication,
  };
};
