/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthEvent,
  AuthType,
  getErrorMessage,
  logAuth,
  type Config,
  buildInstallPlan,
  applyProviderInstallPlan,
  type ProviderConfig,
  type ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { createLoadedSettingsAdapter } from '../../config/loadedSettingsAdapter.js';
import { useQwenAuth } from '../hooks/useQwenAuth.js';
import { AuthState, MessageType } from '../types.js';
import type { HistoryItemWithoutId } from '../types.js';
import { t } from '../../i18n/index.js';

/**
 * Normalize model IDs: split by comma, trim, deduplicate, remove empty.
 */
export function normalizeModelIds(modelIdsInput: string): string[] {
  return modelIdsInput
    .split(',')
    .map((id) => id.trim())
    .filter((id, index, array) => id.length > 0 && array.indexOf(id) === index);
}

/** @deprecated Use normalizeModelIds instead. */
export const normalizeCustomModelIds = normalizeModelIds;

/**
 * Mask an API key for display: show first 3 and last 4 chars.
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return '(not set)';
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

export type { QwenAuthState } from '../hooks/useQwenAuth.js';

export type AuthUiState = {
  authError: string | null;
  isAuthDialogOpen: boolean;
  isAuthenticating: boolean;
  pendingAuthType: AuthType | undefined;
  externalAuthState: {
    title: string;
    message: string;
    detail?: string;
  } | null;
  qwenAuthState: ReturnType<typeof useQwenAuth>['qwenAuthState'];
};

export type AuthController = {
  state: AuthUiState;
  actions: {
    setAuthState: (state: AuthState) => void;
    onAuthError: (error: string | null) => void;
    /** Close the /auth dialog without changing the active provider. */
    closeAuthDialog: () => void;
    /** Persist a provider's install plan and switch to it. */
    handleProviderSubmit: (
      providerConfig: ProviderConfig,
      inputs: ProviderSetupInputs,
    ) => Promise<void>;
    openAuthDialog: () => void;
    cancelAuthentication: () => void;
  };
};

export const useAuthCommand = (
  settings: LoadedSettings,
  config: Config,
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void,
  onAuthChange?: () => void,
) => {
  const unAuthenticated = config.getAuthType() === undefined;

  const [authState, setAuthState] = useState<AuthState>(
    unAuthenticated ? AuthState.Updating : AuthState.Unauthenticated,
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(unAuthenticated);
  const [pendingAuthType, setPendingAuthType] = useState<AuthType | undefined>(
    undefined,
  );
  const [externalAuthState, setExternalAuthState] = useState<{
    title: string;
    message: string;
    detail?: string;
  } | null>(null);

  const { qwenAuthState, cancelQwenAuth } = useQwenAuth(
    pendingAuthType,
    isAuthenticating,
  );

  // -- Shared helpers -------------------------------------------------------

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

  const handleAuthFailure = useCallback(
    (error: unknown, protocolForTelemetry?: AuthType) => {
      setIsAuthenticating(false);
      setExternalAuthState(null);
      const msg = t('Failed to authenticate. Message: {{message}}', {
        message: getErrorMessage(error),
      });
      onAuthError(msg);
      // Prefer the explicit argument over the closed-over pendingAuthType:
      // setPendingAuthType(protocol) queues an async React update, but a
      // synchronous throw in handleProviderSubmit reaches the catch before
      // the next render, so the closure may still see `undefined` here.
      // Callers from the new unified flow pass `protocol` explicitly to
      // sidestep that staleness; legacy callers fall back to the closure.
      const effectiveProtocol = protocolForTelemetry ?? pendingAuthType;
      if (effectiveProtocol) {
        logAuth(
          config,
          new AuthEvent(effectiveProtocol, 'manual', 'error', msg),
        );
      }
    },
    [onAuthError, pendingAuthType, config],
  );

  const completeAuthentication = useCallback(() => {
    setAuthError(null);
    setAuthState(AuthState.Authenticated);
    setPendingAuthType(undefined);
    setIsAuthDialogOpen(false);
    setIsAuthenticating(false);
    onAuthChange?.();
  }, [onAuthChange]);

  // -- Provider connect -----------------------------------------------------

  const handleProviderSubmit = useCallback(
    async (providerConfig: ProviderConfig, inputs: ProviderSetupInputs) => {
      // Resolve the protocol once and store it as pendingAuthType so that if
      // applyProviderInstallPlan rejects, handleAuthFailure (which gates the
      // AuthEvent telemetry on pendingAuthType being defined) can record the
      // failure under the right AuthType bucket instead of silently dropping
      // it.
      const protocol = inputs.protocol ?? providerConfig.protocol;
      try {
        setPendingAuthType(protocol);
        setIsAuthenticating(true);
        setAuthError(null);

        const plan = buildInstallPlan(providerConfig, inputs);
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(settings),
          reloadModelProviders: (mp) => config.reloadModelProvidersConfig(mp),
          syncAuthState: (authType, modelId, baseUrl) =>
            config
              .getModelsConfig()
              .syncAfterAuthRefresh(authType, modelId, baseUrl),
          refreshAuth: (authType) => config.refreshAuth(authType),
        });

        completeAuthentication();

        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Successfully configured {{provider}}. Use /model to switch models.',
              { provider: providerConfig.label },
            ),
          },
          Date.now(),
        );

        logAuth(config, new AuthEvent(protocol, 'manual', 'success'));
      } catch (error) {
        // Pass protocol explicitly so error telemetry is recorded even when
        // a synchronous throw beats the setPendingAuthType state update.
        handleAuthFailure(error, protocol);
      }
    },
    [settings, config, completeAuthentication, addItem, handleAuthFailure],
  );

  // -- Dialog open / close / cancel ----------------------------------------

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const closeAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(false);
    setAuthError(null);
  }, []);

  const cancelAuthentication = useCallback(() => {
    if (isAuthenticating && pendingAuthType === AuthType.QWEN_OAUTH) {
      cancelQwenAuth();
    }
    if (isAuthenticating && pendingAuthType) {
      logAuth(config, new AuthEvent(pendingAuthType, 'manual', 'cancelled'));
    }
    setIsAuthenticating(false);
    setExternalAuthState(null);
    setIsAuthDialogOpen(true);
    setAuthError(null);
  }, [isAuthenticating, pendingAuthType, cancelQwenAuth, config]);

  // -- Validate QWEN_DEFAULT_AUTH_TYPE env var on mount --------------------

  useEffect(() => {
    const val = process.env['QWEN_DEFAULT_AUTH_TYPE'];
    const valid = [
      AuthType.QWEN_OAUTH,
      AuthType.USE_OPENAI,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
      AuthType.USE_VERTEX_AI,
    ];
    if (val && !(valid as string[]).includes(val)) {
      onAuthError(
        t(
          'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}',
          { value: val, validValues: valid.join(', ') },
        ),
      );
    }
  }, [onAuthError]);

  // -- Public interface ----------------------------------------------------

  const state = useMemo<AuthUiState>(
    () => ({
      authError,
      isAuthDialogOpen,
      isAuthenticating,
      pendingAuthType,
      externalAuthState,
      qwenAuthState,
    }),
    [
      authError,
      isAuthDialogOpen,
      isAuthenticating,
      pendingAuthType,
      externalAuthState,
      qwenAuthState,
    ],
  );

  const actions = useMemo<AuthController['actions']>(
    () => ({
      setAuthState,
      onAuthError,
      closeAuthDialog,
      handleProviderSubmit,
      openAuthDialog,
      cancelAuthentication,
    }),
    [
      setAuthState,
      onAuthError,
      closeAuthDialog,
      handleProviderSubmit,
      openAuthDialog,
      cancelAuthentication,
    ],
  );

  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
    isAuthDialogOpen,
    isAuthenticating,
    pendingAuthType,
    externalAuthState,
    qwenAuthState,
    closeAuthDialog,
    handleProviderSubmit,
    openAuthDialog,
    cancelAuthentication,
    state,
    actions,
  };
};
