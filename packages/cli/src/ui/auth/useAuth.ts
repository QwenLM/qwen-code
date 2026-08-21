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
  discoverGithubToken,
  CopilotTokenNotFoundError,
  runCopilotDeviceFlow,
  persistGithubToken,
} from '@qwen-code/qwen-code-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import type { UiProviderTransaction } from '../hooks/use-ui-provider-transaction.js';
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
    openAuthDialog: (authType?: AuthType) => void;
    cancelAuthentication: () => void;
  };
};

export const useAuthCommand = (
  settings: LoadedSettings,
  config: Config,
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void,
  onAuthChange: (() => void) | undefined,
  uiProviderTransaction: UiProviderTransaction,
) => {
  const {
    run: runUiProviderTransaction,
    cancelActive: cancelUiProviderTransaction,
  } = uiProviderTransaction;
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

  // The dialog also auto-opens at startup when unauthenticated; only a
  // command-opened dialog has an /auth invocation record to pair with.
  const openedViaCommandRef = useRef(false);

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
    (
      error: unknown,
      protocolForTelemetry: AuthType,
      canPublish: () => boolean,
    ) => {
      if (!canPublish()) return;

      setIsAuthenticating(false);
      setExternalAuthState(null);
      const msg = t('Failed to authenticate. Message: {{message}}', {
        message: getErrorMessage(error),
      });
      onAuthError(msg);
      logAuth(
        config,
        new AuthEvent(protocolForTelemetry, 'manual', 'error', msg),
      );
    },
    [onAuthError, config],
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
      const protocol = inputs.protocol ?? providerConfig.protocol;

      await runUiProviderTransaction(
        async ({ signal, canPublish, ownsRollback }) => {
          const canContinue = () => !signal.aborted && canPublish();
          if (!canContinue()) return;

          setPendingAuthType(protocol);
          setIsAuthenticating(true);
          setAuthError(null);

          try {
            // Copilot device flow: if the user has no pre-existing ghu_/gho_
            // token (from gh CLI, VS Code Copilot, etc.), run RFC 8628 device
            // flow so they can authorize via browser. The resulting token is
            // persisted to ~/.config/github-copilot/hosts.json, which
            // discoverGithubToken searches at request time.
            if (protocol === AuthType.USE_COPILOT) {
              try {
                await discoverGithubToken();
                if (!canContinue()) return;
              } catch (error) {
                if (!(error instanceof CopilotTokenNotFoundError)) throw error;
                if (!canContinue()) return;
                const { token } = await runCopilotDeviceFlow({
                  signal,
                  notify: (event) => {
                    if (!canContinue()) return;
                    if (event.type === 'device_code') {
                      setExternalAuthState({
                        title: t('GitHub Copilot Login'),
                        message: t(
                          'Go to {{verificationUri}} and enter code: {{userCode}}',
                          {
                            verificationUri: event.verificationUri,
                            userCode: event.userCode,
                          },
                        ),
                        detail: t('Expires in {{expiresInSeconds}}s', {
                          expiresInSeconds: String(event.expiresInSeconds),
                        }),
                      });
                    } else if (event.type === 'progress') {
                      setExternalAuthState((previous) =>
                        previous
                          ? { ...previous, detail: event.message }
                          : previous,
                      );
                    } else if (event.type === 'error') {
                      setExternalAuthState((previous) =>
                        previous
                          ? { ...previous, detail: event.message }
                          : previous,
                      );
                    }
                  },
                });
                if (!canContinue()) return;
                await persistGithubToken(token, { signal });
                if (!canContinue()) return;
                setExternalAuthState(null);
              }
            }

            if (!canContinue()) return;
            const previousRuntime = {
              authType: config.getAuthType(),
              modelId:
                config.getActiveRuntimeModelSnapshot()?.id ?? config.getModel(),
              baseUrl: config.getCurrentModelRegistryBaseUrl(),
            };
            const plan = buildInstallPlan(providerConfig, inputs);
            await applyProviderInstallPlan(plan, {
              settings: createLoadedSettingsAdapter(settings),
              signal,
              isCurrentTransaction: ownsRollback,
              reloadModelProviders: (mp) =>
                config.reloadModelProvidersConfig(mp),
              syncAuthState: (authType, modelId, baseUrl) =>
                config
                  .getModelsConfig()
                  .syncAfterAuthRefresh(authType, modelId, baseUrl),
              refreshAuth: (authType) =>
                config.refreshAuth(authType, undefined, canPublish),
              rollbackRuntime: () => {
                if (previousRuntime.authType === undefined) {
                  config.resetAuth(previousRuntime.modelId);
                  return;
                }
                return config.switchModel(
                  previousRuntime.authType,
                  previousRuntime.modelId,
                  { baseUrl: previousRuntime.baseUrl ?? undefined },
                );
              },
            });
            if (!canContinue()) return;

            completeAuthentication();

            const feedbackItem: HistoryItemWithoutId & Record<string, unknown> =
              {
                type: MessageType.INFO,
                text: t(
                  'Successfully configured {{provider}}. Use /model to switch models.',
                  { provider: providerConfig.label },
                ),
              };
            addItem(feedbackItem, Date.now());
            if (openedViaCommandRef.current) {
              openedViaCommandRef.current = false;
              config.getChatRecordingService?.()?.recordSlashCommand({
                phase: 'result',
                rawCommand: '/auth',
                outputHistoryItems: [feedbackItem],
              });
            }

            logAuth(config, new AuthEvent(protocol, 'manual', 'success'));
          } catch (error) {
            handleAuthFailure(error, protocol, canPublish);
          }
        },
      );
    },
    [
      settings,
      config,
      completeAuthentication,
      addItem,
      handleAuthFailure,
      runUiProviderTransaction,
    ],
  );

  // -- Dialog open / close / cancel ----------------------------------------

  const openAuthDialog = useCallback((authType?: AuthType) => {
    openedViaCommandRef.current = true;
    setPendingAuthType(authType);
    setIsAuthDialogOpen(true);
  }, []);

  const closeAuthDialog = useCallback(() => {
    openedViaCommandRef.current = false;
    setIsAuthDialogOpen(false);
    setAuthError(null);
  }, []);

  const cancelAuthentication = useCallback(() => {
    if (isAuthenticating && pendingAuthType === AuthType.QWEN_OAUTH) {
      cancelQwenAuth();
    }
    cancelUiProviderTransaction();
    if (isAuthenticating && pendingAuthType) {
      logAuth(config, new AuthEvent(pendingAuthType, 'manual', 'cancelled'));
    }
    setIsAuthenticating(false);
    setExternalAuthState(null);
    setIsAuthDialogOpen(true);
    setAuthError(null);
  }, [
    isAuthenticating,
    pendingAuthType,
    cancelQwenAuth,
    config,
    cancelUiProviderTransaction,
  ]);

  // -- Validate QWEN_DEFAULT_AUTH_TYPE env var on mount --------------------

  useEffect(
    () => () => {
      cancelUiProviderTransaction();
    },
    [cancelUiProviderTransaction],
  );

  useEffect(() => {
    const val = process.env['QWEN_DEFAULT_AUTH_TYPE'];
    const valid = [
      AuthType.QWEN_OAUTH,
      AuthType.USE_OPENAI,
      AuthType.USE_OPENAI_RESPONSES,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_COPILOT,
      AuthType.USE_GEMINI,
      AuthType.USE_VERTEX_AI,
    ];
    if (val && !valid.includes(val as AuthType)) {
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
