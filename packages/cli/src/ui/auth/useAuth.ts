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
// OpenAICredentials type (previously imported from OpenAIKeyPrompt)
export interface OpenAICredentials {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}
import { useQwenAuth } from '../hooks/useQwenAuth.js';
import { AuthState, MessageType } from '../types.js';
import type { HistoryItem } from '../types.js';
import { t } from '../../i18n/index.js';
import {
  API_KEY_PROVIDERS,
  type ApiKeyProviderId,
  type ApiKeyProviderConfig,
  type ApiKeyProviderRegion,
} from '../../auth/setupMethods/apiKey/index.js';
import {
  createOpenRouterOAuthSession,
  OPENROUTER_OAUTH_CALLBACK_URL,
  runOpenRouterOAuthLogin,
} from '../../auth/providers/oauth/openrouterOAuth.js';
import { applyProviderInstallPlan } from '../../auth/install/applyProviderInstallPlan.js';
import {
  createCustomProviderInstallPlan,
  customProvider,
  generateCustomApiKeyEnvKey,
} from '../../auth/providers/custom/index.js';
import {
  createOpenRouterProviderInstallPlan,
  openRouterProvider,
} from '../../auth/providers/oauth/openrouter.js';
import {
  codingPlanProvider,
  createCodingPlanInstallPlan,
  getCodingPlanConfig,
  type CodingPlanConfig,
} from '../../auth/providers/alibaba/codingPlan.js';
import {
  createTokenPlanInstallPlan,
  getTokenPlanConfig,
  tokenPlanProvider,
  type TokenPlanConfig,
} from '../../auth/providers/alibaba/tokenPlan.js';
import {
  createApiKeyLlmProvider,
  createApiKeyProviderInstallPlan,
} from '../../auth/setupMethods/apiKey/index.js';

/**
 * Normalize model IDs: split by comma, trim, deduplicate, remove empty.
 */
export function normalizeCustomModelIds(modelIdsInput: string): string[] {
  return modelIdsInput
    .split(',')
    .map((id) => id.trim())
    .filter((id, index, array) => id.length > 0 && array.indexOf(id) === index);
}

/**
 * Mask an API key for display: show first 3 and last 4 chars.
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return '(not set)';
  if (trimmed.length <= 6) return '***';
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}...${tail}`;
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
    handleSubscriptionPlanSubmit: (
      planId: 'coding' | 'token',
      apiKey: string,
      baseUrl?: string,
    ) => Promise<void>;
    handleApiKeyProviderSubmit: (
      providerId: ApiKeyProviderId,
      apiKey: string,
      modelIdsInput: string,
      region?: ApiKeyProviderRegion,
    ) => Promise<void>;
    handleOpenRouterSubmit: () => Promise<void>;
    handleCustomApiKeySubmit: (
      protocol:
        | AuthType.USE_OPENAI
        | AuthType.USE_ANTHROPIC
        | AuthType.USE_GEMINI,
      baseUrl: string,
      apiKey: string,
      modelIdsInput: string,
      generationConfig?: {
        enableThinking?: boolean;
        multimodal?: {
          image?: boolean;
          video?: boolean;
          audio?: boolean;
        };
        maxTokens?: number;
      },
    ) => Promise<void>;
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
  const [openRouterAuthAbortController, setOpenRouterAuthAbortController] =
    useState<AbortController | null>(null);

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

  const handleAuthFailure = useCallback(
    (error: unknown) => {
      setIsAuthenticating(false);
      setExternalAuthState(null);
      const errorMessage = t('Failed to authenticate. Message: {{message}}', {
        message: getErrorMessage(error),
      });
      onAuthError(errorMessage);

      // Log authentication failure
      if (pendingAuthType) {
        const authEvent = new AuthEvent(
          pendingAuthType,
          'manual',
          'error',
          errorMessage,
        );
        logAuth(config, authEvent);
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

  const handleAuthSuccess = useCallback(
    async (authType: AuthType) => {
      if (authType === AuthType.QWEN_OAUTH) {
        try {
          const authTypeScope = getPersistScopeForModelSelection(settings);
          settings.setValue(
            authTypeScope,
            'security.auth.selectedType',
            authType,
          );
        } catch (error) {
          handleAuthFailure(error);
          return;
        }
      }

      completeAuthentication();

      // Add success message to history
      addItem(
        {
          type: MessageType.INFO,
          text: t('Authenticated successfully with {{authType}}.', {
            authType,
          }),
        },
        Date.now(),
      );

      // Log authentication success
      const authEvent = new AuthEvent(authType, 'manual', 'success');
      logAuth(config, authEvent);
    },
    [settings, handleAuthFailure, completeAuthentication, addItem, config],
  );

  const performAuth = useCallback(
    async (authType: AuthType) => {
      try {
        await config.refreshAuth(authType);
        handleAuthSuccess(authType);
      } catch (e) {
        handleAuthFailure(e);
      }
    },
    [config, handleAuthSuccess, handleAuthFailure],
  );

  const isProviderManagedModel = useCallback(
    (authType: AuthType, modelId: string | undefined) => {
      if (!modelId) {
        return false;
      }

      const modelProviders = settings.merged.modelProviders as
        | ModelProvidersConfig
        | undefined;
      if (!modelProviders) {
        return false;
      }
      const providerModels = modelProviders[authType];
      if (!Array.isArray(providerModels)) {
        return false;
      }
      return providerModels.some(
        (providerModel) => providerModel.id === modelId,
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

      await performAuth(authType);
    },
    [performAuth, isProviderManagedModel, onAuthError],
  );

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const cancelAuthentication = useCallback(() => {
    if (isAuthenticating && pendingAuthType === AuthType.QWEN_OAUTH) {
      cancelQwenAuth();
    }

    if (isAuthenticating && pendingAuthType === AuthType.USE_OPENAI) {
      openRouterAuthAbortController?.abort();
      setOpenRouterAuthAbortController(null);
    }

    // Log authentication cancellation
    if (isAuthenticating && pendingAuthType) {
      const authEvent = new AuthEvent(pendingAuthType, 'manual', 'cancelled');
      logAuth(config, authEvent);
    }

    // Do not reset pendingAuthType here, persist the previously selected type.
    setIsAuthenticating(false);
    setExternalAuthState(null);
    setIsAuthDialogOpen(true);
    setAuthError(null);
  }, [
    isAuthenticating,
    pendingAuthType,
    cancelQwenAuth,
    config,
    openRouterAuthAbortController,
  ]);

  const handleSubscriptionPlanSubmit = useCallback(
    async (planId: 'coding' | 'token', apiKey: string, baseUrl?: string) => {
      try {
        setIsAuthenticating(true);
        setAuthError(null);

        const plan: CodingPlanConfig | TokenPlanConfig =
          planId === 'token'
            ? getTokenPlanConfig()
            : getCodingPlanConfig(baseUrl);
        const provider =
          planId === 'token' ? tokenPlanProvider : codingPlanProvider;
        const installPlan =
          planId === 'token'
            ? createTokenPlanInstallPlan({ apiKey })
            : createCodingPlanInstallPlan({ apiKey, baseUrl });
        await applyProviderInstallPlan(installPlan, {
          settings,
          config,
          provider,
        });

        completeAuthentication();

        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.',
              { region: t(plan.displayName) },
            ),
          },
          Date.now(),
        );
        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Tip: Use /model to switch between available {{plan}} models.',
              { plan: t(plan.displayName) },
            ),
          },
          Date.now(),
        );

        const authEvent = new AuthEvent(
          AuthType.USE_OPENAI,
          plan.authEventType,
          'success',
        );
        logAuth(config, authEvent);
      } catch (error) {
        handleAuthFailure(error);
      }
    },
    [settings, config, completeAuthentication, addItem, handleAuthFailure],
  );

  const handleCodingPlanSubmit = useCallback(
    (apiKey: string, baseUrl?: string) =>
      handleSubscriptionPlanSubmit('coding', apiKey, baseUrl),
    [handleSubscriptionPlanSubmit],
  );

  const handleTokenPlanSubmit = useCallback(
    (apiKey: string) => handleSubscriptionPlanSubmit('token', apiKey),
    [handleSubscriptionPlanSubmit],
  );

  const submitApiKeyProvider = useCallback(
    async (
      provider: ApiKeyProviderConfig,
      apiKey: string,
      modelIdsInput: string,
      region?: ApiKeyProviderRegion,
    ) => {
      try {
        setIsAuthenticating(true);
        setAuthError(null);

        const trimmedApiKey = apiKey.trim();
        const modelIds = normalizeCustomModelIds(modelIdsInput);
        if (!trimmedApiKey) {
          throw new Error(t('API key cannot be empty.'));
        }
        if (modelIds.length === 0) {
          throw new Error(t('Model IDs cannot be empty.'));
        }

        const installPlan = createApiKeyProviderInstallPlan({
          provider,
          apiKey: trimmedApiKey,
          modelIds,
          region,
        });
        await applyProviderInstallPlan(installPlan, {
          settings,
          config,
          provider: createApiKeyLlmProvider(provider),
        });

        completeAuthentication();

        addItem(
          {
            type: MessageType.INFO,
            text: t(
              '{{providerName}} successfully entered. Settings updated with env.{{envKey}} and {{modelCount}} model(s).',
              {
                providerName: provider.title,
                envKey: provider.envKey,
                modelCount: String(modelIds.length),
              },
            ),
          },
          Date.now(),
        );

        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'You can use /model to see new {{providerName}} models and switch between them.',
              { providerName: provider.modelNamePrefix },
            ),
          },
          Date.now(),
        );

        const authEvent = new AuthEvent(
          AuthType.USE_OPENAI,
          'manual',
          'success',
        );
        logAuth(config, authEvent);
      } catch (error) {
        handleAuthFailure(error);
      }
    },
    [settings, config, completeAuthentication, addItem, handleAuthFailure],
  );

  const handleApiKeyProviderSubmit = useCallback(
    async (
      providerId: ApiKeyProviderId,
      apiKey: string,
      modelIdsInput: string,
      region?: ApiKeyProviderRegion,
    ) =>
      submitApiKeyProvider(
        API_KEY_PROVIDERS[providerId],
        apiKey,
        modelIdsInput,
        region,
      ),
    [submitApiKeyProvider],
  );

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
      setOpenRouterAuthAbortController(abortController);
      const oauthResult = await runOpenRouterOAuthLogin(
        OPENROUTER_OAUTH_CALLBACK_URL,
        {
          abortSignal: abortController.signal,
          session: oauthSession,
        },
      );
      setOpenRouterAuthAbortController(null);
      setExternalAuthState({
        title: t('OpenRouter Authentication'),
        message: t('Finalizing OpenRouter setup...'),
        detail: t(
          'Syncing OpenRouter models and updating your local configuration.',
        ),
      });
      const selectedKey = oauthResult.apiKey;
      if (!selectedKey) {
        throw new Error(
          t('OpenRouter authentication completed without an API key.'),
        );
      }

      const installPlan = await createOpenRouterProviderInstallPlan({
        apiKey: selectedKey,
      });
      await applyProviderInstallPlan(installPlan, {
        settings,
        config,
        provider: openRouterProvider,
        refreshAuth: false,
      });

      setExternalAuthState(null);
      completeAuthentication();

      addItem(
        {
          type: MessageType.INFO,
          text: t('Successfully configured OpenRouter.'),
        },
        Date.now(),
      );

      addItem(
        {
          type: MessageType.INFO,
          text: t('Use /model to switch models.'),
        },
        Date.now(),
      );

      addItem(
        {
          type: MessageType.INFO,
          text: t(
            'Want more OpenRouter models? Use /manage-models to browse and enable them.',
          ),
        },
        Date.now(),
      );

      const authEvent = new AuthEvent(AuthType.USE_OPENAI, 'manual', 'success');
      logAuth(config, authEvent);
    } catch (error) {
      setOpenRouterAuthAbortController(null);
      if (error instanceof DOMException && error.name === 'AbortError') {
        setExternalAuthState(null);
        setPendingAuthType(undefined);
        setIsAuthenticating(false);
        setIsAuthDialogOpen(true);
        return;
      }
      handleAuthFailure(error);
    }
  }, [
    settings,
    config,
    completeAuthentication,
    addItem,
    handleAuthFailure,
    setOpenRouterAuthAbortController,
  ]);

  /**
   * Handle custom API key setup wizard submission.
   * Persists key to env[generatedEnvKey] and creates modelProviders entries.
   */
  const handleCustomApiKeySubmit = useCallback(
    async (
      protocol:
        | AuthType.USE_OPENAI
        | AuthType.USE_ANTHROPIC
        | AuthType.USE_GEMINI,
      baseUrl: string,
      apiKey: string,
      modelIdsInput: string,
      generationConfig?: {
        enableThinking?: boolean;
        multimodal?: {
          image?: boolean;
          video?: boolean;
          audio?: boolean;
        };
        maxTokens?: number;
      },
    ) => {
      try {
        setIsAuthenticating(true);
        setAuthError(null);

        const trimmedApiKey = apiKey.trim();
        const trimmedBaseUrl = baseUrl.trim();
        const modelIds = normalizeCustomModelIds(modelIdsInput);

        if (!trimmedApiKey) {
          throw new Error(t('API key cannot be empty.'));
        }
        if (!trimmedBaseUrl) {
          throw new Error(t('Base URL cannot be empty.'));
        }
        if (!/^https?:\/\//i.test(trimmedBaseUrl)) {
          throw new Error(t('Base URL must start with http:// or https://.'));
        }
        if (modelIds.length === 0) {
          throw new Error(t('Model IDs cannot be empty.'));
        }

        const generatedEnvKey = generateCustomApiKeyEnvKey(
          protocol,
          trimmedBaseUrl,
        );
        const installPlan = createCustomProviderInstallPlan({
          protocol,
          baseUrl: trimmedBaseUrl,
          apiKey: trimmedApiKey,
          modelIds,
          envKey: generatedEnvKey,
          generationConfig,
        });

        await applyProviderInstallPlan(installPlan, {
          settings,
          config,
          provider: customProvider,
        });

        completeAuthentication();

        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Custom API Key authenticated successfully. Settings updated with generated env key and model provider config.',
            ),
          },
          Date.now(),
        );

        addItem(
          {
            type: MessageType.INFO,
            text: t('Tip: Use /model to switch between configured models.'),
          },
          Date.now(),
        );

        const authEvent = new AuthEvent(protocol, 'manual', 'success');
        logAuth(config, authEvent);
      } catch (error) {
        handleAuthFailure(error);
      }
    },
    [settings, config, completeAuthentication, addItem, handleAuthFailure],
  );

  // Authentication only runs from explicit user or startup actions; selectedType
  // is persisted after success to avoid retry loops when a method fails.
  useEffect(() => {
    const defaultAuthType = process.env['QWEN_DEFAULT_AUTH_TYPE'];
    if (
      defaultAuthType &&
      ![
        AuthType.QWEN_OAUTH,
        AuthType.USE_OPENAI,
        AuthType.USE_ANTHROPIC,
        AuthType.USE_GEMINI,
        AuthType.USE_VERTEX_AI,
      ].includes(defaultAuthType as AuthType)
    ) {
      onAuthError(
        t(
          'Invalid QWEN_DEFAULT_AUTH_TYPE value: "{{value}}". Valid values are: {{validValues}}',
          {
            value: defaultAuthType,
            validValues: [
              AuthType.QWEN_OAUTH,
              AuthType.USE_OPENAI,
              AuthType.USE_ANTHROPIC,
              AuthType.USE_GEMINI,
              AuthType.USE_VERTEX_AI,
            ].join(', '),
          },
        ),
      );
    }
  }, [onAuthError]);

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
      handleSubscriptionPlanSubmit,
      handleApiKeyProviderSubmit,
      handleOpenRouterSubmit,
      handleCustomApiKeySubmit,
      openAuthDialog,
      cancelAuthentication,
    }),
    [
      setAuthState,
      onAuthError,
      handleAuthSelect,
      handleSubscriptionPlanSubmit,
      handleApiKeyProviderSubmit,
      handleOpenRouterSubmit,
      handleCustomApiKeySubmit,
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
    handleSubscriptionPlanSubmit,
    handleCodingPlanSubmit,
    handleTokenPlanSubmit,
    handleApiKeyProviderSubmit,
    handleOpenRouterSubmit,
    handleCustomApiKeySubmit,
    openAuthDialog,
    cancelAuthentication,
    state,
    actions,
  };
};
