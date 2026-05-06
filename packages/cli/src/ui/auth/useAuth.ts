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
  type ModelProvidersConfig,
} from '@qwen-code/qwen-code-core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { useQwenAuth } from '../hooks/useQwenAuth.js';
import { AuthState, MessageType } from '../types.js';
import type { HistoryItem } from '../types.js';
import { t } from '../../i18n/index.js';

import { applyProviderInstallPlan } from '../../auth/install/applyProviderInstallPlan.js';
import {
  buildInstallPlan,
  getDefaultModelIds,
  resolveBaseUrl,
  type ProviderConfig,
  type ProviderSetupInputs,
} from '../../auth/providerConfig.js';
import {
  codingPlanProvider,
  tokenPlanProvider,
  openRouterProvider,
  findProviderById,
} from '../../auth/allProviders.js';
import {
  createOpenRouterOAuthSession,
  OPENROUTER_OAUTH_CALLBACK_URL,
  runOpenRouterOAuthLogin,
  getOpenRouterModelsWithFallback,
  selectRecommendedOpenRouterModels,
  getPreferredOpenRouterModelId,
} from '../../auth/providers/oauth/openrouterOAuth.js';

// Re-export types used by other modules
export interface OpenAICredentials {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

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
    handleAuthSelect: (
      authType: AuthType | undefined,
      credentials?: OpenAICredentials,
    ) => Promise<void>;
    handleProviderSubmit: (
      providerConfig: ProviderConfig,
      inputs: ProviderSetupInputs,
    ) => Promise<void>;
    handleOpenRouterSubmit: () => Promise<void>;
    openAuthDialog: () => void;
    cancelAuthentication: () => void;
  };
};

export const useAuthCommand = (
  settings: LoadedSettings,
  config: Config,
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void,
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
  const [openRouterAbortCtrl, setOpenRouterAbortCtrl] =
    useState<AbortController | null>(null);

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
    (error: unknown) => {
      setIsAuthenticating(false);
      setExternalAuthState(null);
      const msg = t('Failed to authenticate. Message: {{message}}', {
        message: getErrorMessage(error),
      });
      onAuthError(msg);
      if (pendingAuthType) {
        logAuth(config, new AuthEvent(pendingAuthType, 'manual', 'error', msg));
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

  // -- Unified provider submit ----------------------------------------------

  const handleProviderSubmit = useCallback(
    async (providerConfig: ProviderConfig, inputs: ProviderSetupInputs) => {
      try {
        setIsAuthenticating(true);
        setAuthError(null);

        const plan = buildInstallPlan(providerConfig, inputs);
        await applyProviderInstallPlan(plan, { settings, config });

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

        const protocol = inputs.protocol ?? providerConfig.protocol;
        logAuth(config, new AuthEvent(protocol, 'manual', 'success'));
      } catch (error) {
        handleAuthFailure(error);
      }
    },
    [settings, config, completeAuthentication, addItem, handleAuthFailure],
  );

  // -- OpenRouter OAuth (the only genuinely different flow) ------------------

  const handleOpenRouterSubmit = useCallback(async () => {
    try {
      setPendingAuthType(AuthType.USE_OPENAI);
      setIsAuthenticating(true);
      setAuthError(null);
      setIsAuthDialogOpen(false);

      const oauthSession = createOpenRouterOAuthSession(
        OPENROUTER_OAUTH_CALLBACK_URL,
      );
      setExternalAuthState({
        title: t('OpenRouter Authentication'),
        message: t(
          'Open the authorization page if your browser does not launch automatically.',
        ),
        detail: oauthSession.authorizationUrl,
      });

      const abortController = new AbortController();
      setOpenRouterAbortCtrl(abortController);
      const oauthResult = await runOpenRouterOAuthLogin(
        OPENROUTER_OAUTH_CALLBACK_URL,
        { abortSignal: abortController.signal, session: oauthSession },
      );
      setOpenRouterAbortCtrl(null);

      const selectedKey = oauthResult.apiKey;
      if (!selectedKey) {
        throw new Error(
          t('OpenRouter authentication completed without an API key.'),
        );
      }

      setExternalAuthState({
        title: t('OpenRouter Authentication'),
        message: t('Finalizing OpenRouter setup...'),
      });

      // Fetch models and build install plan using unified path
      const allModels = await getOpenRouterModelsWithFallback();
      const recommendedModels = selectRecommendedOpenRouterModels(allModels);
      const preferredModelId = getPreferredOpenRouterModelId(recommendedModels);

      const plan = buildInstallPlan(openRouterProvider, {
        baseUrl: resolveBaseUrl(openRouterProvider),
        apiKey: selectedKey,
        modelIds: preferredModelId ? [preferredModelId] : [],
        prebuiltModels: recommendedModels,
      });

      await applyProviderInstallPlan(plan, {
        settings,
        config,
        refreshAuth: false,
      });

      setExternalAuthState(null);
      completeAuthentication();

      addItem(
        {
          type: MessageType.INFO,
          text: t(
            'Successfully configured OpenRouter. Use /model to switch models.',
          ),
        },
        Date.now(),
      );

      logAuth(config, new AuthEvent(AuthType.USE_OPENAI, 'manual', 'success'));
    } catch (error) {
      setOpenRouterAbortCtrl(null);
      if (error instanceof DOMException && error.name === 'AbortError') {
        setExternalAuthState(null);
        setPendingAuthType(undefined);
        setIsAuthenticating(false);
        setIsAuthDialogOpen(true);
        return;
      }
      handleAuthFailure(error);
    }
  }, [settings, config, completeAuthentication, addItem, handleAuthFailure]);

  // -- Legacy auth select (Qwen OAuth / direct) ----------------------------

  const isProviderManagedModel = useCallback(
    (authType: AuthType, modelId: string | undefined) => {
      if (!modelId) return false;
      const modelProviders = settings.merged.modelProviders as
        | ModelProvidersConfig
        | undefined;
      if (!modelProviders) return false;
      const providerModels = modelProviders[authType];
      return (
        Array.isArray(providerModels) &&
        providerModels.some((m) => m.id === modelId)
      );
    },
    [settings],
  );

  const handleAuthSelect = useCallback(
    async (authType: AuthType | undefined, credentials?: OpenAICredentials) => {
      if (!authType) {
        setIsAuthDialogOpen(false);
        setAuthError(null);
        return;
      }

      if (
        authType === AuthType.USE_OPENAI &&
        credentials?.model &&
        isProviderManagedModel(authType, credentials.model)
      ) {
        onAuthError(
          t(
            'Model "{{modelName}}" is managed via settings.modelProviders. Please complete the fields in settings, or use another model id.',
            { modelName: credentials.model },
          ),
        );
        return;
      }

      setPendingAuthType(authType);
      setAuthError(null);
      setIsAuthDialogOpen(false);
      setIsAuthenticating(true);

      if (authType === AuthType.USE_OPENAI) {
        onAuthError(
          t(
            'Manual OpenAI-compatible setup has moved to provider setup. Choose a provider or use Custom API Key.',
          ),
        );
        setIsAuthenticating(false);
        setPendingAuthType(undefined);
        setIsAuthDialogOpen(true);
        return;
      }

      // Qwen OAuth or other direct auth
      try {
        await config.refreshAuth(authType);

        if (authType === AuthType.QWEN_OAUTH) {
          const scope = getPersistScopeForModelSelection(settings);
          settings.setValue(scope, 'security.auth.selectedType', authType);
        }
        completeAuthentication();
        addItem(
          {
            type: MessageType.INFO,
            text: t('Authenticated successfully with {{authType}}.', {
              authType,
            }),
          },
          Date.now(),
        );
        logAuth(config, new AuthEvent(authType, 'manual', 'success'));
      } catch (e) {
        handleAuthFailure(e);
      }
    },
    [
      config,
      settings,
      completeAuthentication,
      addItem,
      handleAuthFailure,
      isProviderManagedModel,
      onAuthError,
    ],
  );

  // -- Dialog open / close / cancel ----------------------------------------

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const cancelAuthentication = useCallback(() => {
    if (isAuthenticating && pendingAuthType === AuthType.QWEN_OAUTH) {
      cancelQwenAuth();
    }
    if (isAuthenticating && pendingAuthType === AuthType.USE_OPENAI) {
      openRouterAbortCtrl?.abort();
      setOpenRouterAbortCtrl(null);
    }
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
    openRouterAbortCtrl,
  ]);

  // -- Legacy wrappers (delegate to handleProviderSubmit) -------------------

  const handleSubscriptionPlanSubmit = useCallback(
    async (planId: 'coding' | 'token', apiKey: string, baseUrl?: string) => {
      const providerConfig =
        planId === 'token' ? tokenPlanProvider : codingPlanProvider;
      const resolvedBaseUrl = resolveBaseUrl(providerConfig, baseUrl);
      await handleProviderSubmit(providerConfig, {
        baseUrl: resolvedBaseUrl,
        apiKey,
        modelIds: getDefaultModelIds(providerConfig),
      });
    },
    [handleProviderSubmit],
  );

  const handleApiKeyProviderSubmit = useCallback(
    async (
      providerId: string,
      apiKey: string,
      modelIdsInput: string,
      endpointOption?: string,
    ) => {
      const providerConfig = findProviderById(providerId);
      if (!providerConfig) {
        onAuthError(t('Unknown provider: {{id}}', { id: providerId }));
        return;
      }
      const resolvedBaseUrl = resolveBaseUrl(
        providerConfig,
        endpointOption
          ? Array.isArray(providerConfig.baseUrl)
            ? providerConfig.baseUrl.find((o) => o.id === endpointOption)?.url
            : undefined
          : undefined,
      );
      await handleProviderSubmit(providerConfig, {
        baseUrl: resolvedBaseUrl,
        apiKey: apiKey.trim(),
        modelIds: normalizeModelIds(modelIdsInput),
      });
    },
    [handleProviderSubmit, onAuthError],
  );

  const handleCustomApiKeySubmit = useCallback(
    async (
      protocol: AuthType,
      baseUrl: string,
      apiKey: string,
      modelIdsInput: string,
      generationConfig?: ProviderSetupInputs['advancedConfig'],
    ) => {
      const providerConfig = findProviderById('custom-openai-compatible');
      if (!providerConfig) return;
      await handleProviderSubmit(providerConfig, {
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelIds: normalizeModelIds(modelIdsInput),
        advancedConfig: generationConfig,
      });
    },
    [handleProviderSubmit],
  );

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
      handleAuthSelect,
      handleProviderSubmit,
      handleOpenRouterSubmit,
      openAuthDialog,
      cancelAuthentication,
    }),
    [
      setAuthState,
      onAuthError,
      handleAuthSelect,
      handleProviderSubmit,
      handleOpenRouterSubmit,
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
    handleAuthSelect,
    handleProviderSubmit,
    handleOpenRouterSubmit,
    handleSubscriptionPlanSubmit,
    handleCodingPlanSubmit: useCallback(
      (apiKey: string, baseUrl?: string) =>
        handleSubscriptionPlanSubmit('coding', apiKey, baseUrl),
      [handleSubscriptionPlanSubmit],
    ),
    handleTokenPlanSubmit: useCallback(
      (apiKey: string) => handleSubscriptionPlanSubmit('token', apiKey),
      [handleSubscriptionPlanSubmit],
    ),
    handleApiKeyProviderSubmit,
    handleCustomApiKeySubmit,
    openAuthDialog,
    cancelAuthentication,
    state,
    actions,
  };
};
