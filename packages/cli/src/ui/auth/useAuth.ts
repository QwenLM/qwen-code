/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import type { LoadedSettings, SettingScope } from '../../config/settings.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  AuthType,
  clearCachedCredentialFile,
  getErrorMessage,
} from '@qwen-code/qwen-code-core';
import { AuthState } from '../types.js';
import { validateAuthMethod } from '../../config/auth.js';
import { useQwenAuth } from '../hooks/useQwenAuth.js';

export type { QwenAuthState } from '../hooks/useQwenAuth.js';

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
  const [pendingAuthType, setPendingAuthType] = useState<AuthType | undefined>(
    undefined,
  );

  const { qwenAuthState, cancelQwenAuth } = useQwenAuth(
    pendingAuthType,
    isAuthenticating,
  );

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

  const handleAuthSuccess = useCallback(
    (
      authType: AuthType,
      scope: SettingScope,
      credentials?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      },
    ) => {
      if (credentials?.apiKey) {
        settings.setValue(scope, 'security.auth.apiKey', credentials.apiKey);
      }
      if (credentials?.baseUrl) {
        settings.setValue(scope, 'security.auth.baseUrl', credentials.baseUrl);
      }
      if (credentials?.model) {
        settings.setValue(scope, 'model.name', credentials.model);
      }
      settings.setValue(scope, 'security.auth.selectedType', authType);

      setAuthError(null);
      setAuthState(AuthState.Authenticated);
      setPendingAuthType(undefined);
      setIsAuthDialogOpen(false);
    },
    [settings],
  );

  const handleAuthFailure = useCallback(
    (error: unknown) => {
      onAuthError(`Failed to login. Message: ${getErrorMessage(error)}`);
    },
    [onAuthError],
  );

  const performAuth = useCallback(
    async (
      authType: AuthType,
      scope: SettingScope,
      credentials?: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
      },
    ) => {
      try {
        setIsAuthenticating(true);
        await config.refreshAuth(authType);
        handleAuthSuccess(authType, scope, credentials);
      } catch (e) {
        handleAuthFailure(e);
      } finally {
        setIsAuthenticating(false);
      }
    },
    [config, handleAuthSuccess, handleAuthFailure],
  );

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
      if (!authType) {
        setIsAuthDialogOpen(false);
        setAuthError(null);
        return;
      }

      await clearCachedCredentialFile();

      setPendingAuthType(authType);
      setAuthError(null);

      if (authType === AuthType.USE_OPENAI) {
        if (credentials) {
          config.updateCredentials({
            apiKey: credentials.apiKey,
            baseUrl: credentials.baseUrl,
            model: credentials.model,
          });
        }

        await performAuth(authType, scope, credentials);
        return;
      }

      await performAuth(authType, scope);
    },
    [config, performAuth],
  );

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const cancelAuthentication = useCallback(() => {
    // If authenticating with Qwen OAuth, cancel Qwen auth
    if (
      isAuthenticating &&
      (pendingAuthType === AuthType.QWEN_OAUTH ||
        settings.merged.security?.auth?.selectedType === AuthType.QWEN_OAUTH)
    ) {
      cancelQwenAuth();
    }

    setIsAuthenticating(false);
  }, [
    isAuthenticating,
    pendingAuthType,
    settings.merged.security?.auth?.selectedType,
    cancelQwenAuth,
  ]);

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
