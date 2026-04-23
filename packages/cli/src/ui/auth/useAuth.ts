/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ContentGeneratorConfig,
  ModelProvidersConfig,
  ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import {
  AuthEvent,
  AuthType,
  getErrorMessage,
  logAuth,
  getCodingPlanConfig,
  isCodingPlanConfig,
  CodingPlanRegion,
  CODING_PLAN_ENV_KEY,
} from '@qwen-code/qwen-code-core';
import { useCallback, useEffect, useState } from 'react';
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
import { backupSettingsFile } from '../../utils/settingsUtils.js';
import {
  ALIBABA_STANDARD_API_KEY_ENDPOINTS,
  DASHSCOPE_STANDARD_API_KEY_ENV_KEY,
  type AlibabaStandardRegion,
} from '../../constants/alibabaStandardApiKey.js';
import {
  getOpenRouterModelsWithFallback,
  mergeOpenRouterConfigs,
  OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_ENV_KEY,
  OPENROUTER_OAUTH_CALLBACK_URL,
  runOpenRouterOAuthLogin,
  selectRecommendedOpenRouterModels,
} from '../../commands/auth/openrouterOAuth.js';

export type { QwenAuthState } from '../hooks/useQwenAuth.js';

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

  const handleAuthSuccess = useCallback(
    async (authType: AuthType, credentials?: OpenAICredentials) => {
      try {
        const authTypeScope = getPersistScopeForModelSelection(settings);

        // Persist authType
        settings.setValue(
          authTypeScope,
          'security.auth.selectedType',
          authType,
        );

        // Persist model from ContentGenerator config (handles fallback cases)
        // This ensures that when syncAfterAuthRefresh falls back to default model,
        // it gets persisted to settings.json
        const contentGeneratorConfig = config.getContentGeneratorConfig();
        if (contentGeneratorConfig?.model) {
          settings.setValue(
            authTypeScope,
            'model.name',
            contentGeneratorConfig.model,
          );
        }

        // Only update credentials if not switching to QWEN_OAUTH,
        // so that OpenAI credentials are preserved when switching to QWEN_OAUTH.
        if (authType !== AuthType.QWEN_OAUTH && credentials) {
          if (credentials?.apiKey != null) {
            settings.setValue(
              authTypeScope,
              'security.auth.apiKey',
              credentials.apiKey,
            );
          }
          if (credentials?.baseUrl != null) {
            settings.setValue(
              authTypeScope,
              'security.auth.baseUrl',
              credentials.baseUrl,
            );
          }
        }
      } catch (error) {
        handleAuthFailure(error);
        return;
      }

      setAuthError(null);
      setAuthState(AuthState.Authenticated);
      setPendingAuthType(undefined);
      setIsAuthDialogOpen(false);
      setIsAuthenticating(false);

      // Trigger UI refresh to update header information
      onAuthChange?.();

      // Add success message to history
      addItem(
        {
          type: MessageType.INFO,
          text: t('Authenticated successfully with {{authType}} credentials.', {
            authType,
          }),
        },
        Date.now(),
      );

      // Log authentication success
      const authEvent = new AuthEvent(authType, 'manual', 'success');
      logAuth(config, authEvent);
    },
    [settings, handleAuthFailure, config, addItem, onAuthChange],
  );

  const performAuth = useCallback(
    async (authType: AuthType, credentials?: OpenAICredentials) => {
      try {
        await config.refreshAuth(authType);
        handleAuthSuccess(authType, credentials);
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
        if (credentials) {
          // Pass settings.model.generationConfig to updateCredentials so it can be merged
          // after clearing provider-sourced config. This ensures settings.json generationConfig
          // fields (e.g., samplingParams, timeout) are preserved.
          const settingsGenerationConfig = settings.merged.model
            ?.generationConfig as Partial<ContentGeneratorConfig> | undefined;
          config.updateCredentials(
            {
              apiKey: credentials.apiKey,
              baseUrl: credentials.baseUrl,
              model: credentials.model,
            },
            settingsGenerationConfig,
          );
          await performAuth(authType, credentials);
        }
        return;
      }

      await performAuth(authType);
    },
    [
      config,
      performAuth,
      isProviderManagedModel,
      onAuthError,
      settings.merged.model?.generationConfig,
    ],
  );

  const openAuthDialog = useCallback(() => {
    setIsAuthDialogOpen(true);
  }, []);

  const cancelAuthentication = useCallback(() => {
    if (isAuthenticating && pendingAuthType === AuthType.QWEN_OAUTH) {
      cancelQwenAuth();
    }

    // Log authentication cancellation
    if (isAuthenticating && pendingAuthType) {
      const authEvent = new AuthEvent(pendingAuthType, 'manual', 'cancelled');
      logAuth(config, authEvent);
    }

    // Do not reset pendingAuthType here, persist the previously selected type.
    setIsAuthenticating(false);
    setIsAuthDialogOpen(true);
    setAuthError(null);
  }, [isAuthenticating, pendingAuthType, cancelQwenAuth, config]);

  /**
   * Handle coding plan submission - generates configs from template and stores api-key
   * @param apiKey - The API key to store
   * @param region - The region to use (default: CHINA)
   */
  const handleCodingPlanSubmit = useCallback(
    async (
      apiKey: string,
      region: CodingPlanRegion = CodingPlanRegion.CHINA,
    ) => {
      try {
        setIsAuthenticating(true);
        setAuthError(null);

        // Get configuration based on region
        const { template, version } = getCodingPlanConfig(region);

        // Get persist scope
        const persistScope = getPersistScopeForModelSelection(settings);

        // Backup settings file before modification
        const settingsFile = settings.forScope(persistScope);
        backupSettingsFile(settingsFile.path);

        // Store api-key in settings.env (unified env key)
        settings.setValue(persistScope, `env.${CODING_PLAN_ENV_KEY}`, apiKey);

        // Sync to process.env immediately so refreshAuth can read the apiKey
        process.env[CODING_PLAN_ENV_KEY] = apiKey;

        // Generate model configs from template
        const newConfigs: ProviderModelConfig[] = template.map(
          (templateConfig) => ({
            ...templateConfig,
            envKey: CODING_PLAN_ENV_KEY,
          }),
        );

        // Get existing configs
        const existingConfigs =
          (
            settings.merged.modelProviders as ModelProvidersConfig | undefined
          )?.[AuthType.USE_OPENAI] || [];

        // Filter out all existing Coding Plan configs (mutually exclusive)
        const nonCodingPlanConfigs = existingConfigs.filter(
          (existing) => !isCodingPlanConfig(existing.baseUrl, existing.envKey),
        );

        // Add new Coding Plan configs at the beginning
        const updatedConfigs = [...newConfigs, ...nonCodingPlanConfigs];

        // Persist to modelProviders
        settings.setValue(
          persistScope,
          `modelProviders.${AuthType.USE_OPENAI}`,
          updatedConfigs,
        );

        // Also persist authType
        settings.setValue(
          persistScope,
          'security.auth.selectedType',
          AuthType.USE_OPENAI,
        );

        // Persist coding plan region
        settings.setValue(persistScope, 'codingPlan.region', region);

        // Persist coding plan version (single field for backward compatibility)
        settings.setValue(persistScope, 'codingPlan.version', version);

        // If there are configs, use the first one as the model
        if (updatedConfigs.length > 0 && updatedConfigs[0]?.id) {
          settings.setValue(persistScope, 'model.name', updatedConfigs[0].id);
        }

        // Hot-reload model providers configuration before refreshAuth
        // This ensures ModelsConfig has the latest configuration from settings.json
        const updatedModelProviders: ModelProvidersConfig = {
          ...(settings.merged.modelProviders as
            | ModelProvidersConfig
            | undefined),
          [AuthType.USE_OPENAI]: updatedConfigs,
        };
        config.reloadModelProvidersConfig(updatedModelProviders);

        // Refresh auth with the new configuration
        await config.refreshAuth(AuthType.USE_OPENAI);

        // Success handling
        setAuthError(null);
        setAuthState(AuthState.Authenticated);
        setIsAuthDialogOpen(false);
        setIsAuthenticating(false);

        // Trigger UI refresh
        onAuthChange?.();

        // Add success message
        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Authenticated successfully with {{region}}. API key and model configs saved to settings.json.',
              { region: t('Alibaba Cloud Coding Plan') },
            ),
          },
          Date.now(),
        );

        // Hint about /model command
        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Tip: Use /model to switch between available Coding Plan models.',
            ),
          },
          Date.now(),
        );

        // Log success
        const authEvent = new AuthEvent(
          AuthType.USE_OPENAI,
          'coding-plan',
          'success',
        );
        logAuth(config, authEvent);
      } catch (error) {
        handleAuthFailure(error);
      }
    },
    [settings, config, handleAuthFailure, addItem, onAuthChange],
  );

  /**
   * Handle Alibaba Cloud standard API key flow.
   * Persists key to env.DASHSCOPE_API_KEY and creates a modelProviders.openai entry.
   */
  const handleAlibabaStandardSubmit = useCallback(
    async (
      apiKey: string,
      region: AlibabaStandardRegion,
      modelIdsInput: string,
    ) => {
      try {
        setIsAuthenticating(true);
        setAuthError(null);

        const trimmedApiKey = apiKey.trim();
        const modelIds = modelIdsInput
          .split(',')
          .map((id) => id.trim())
          .filter(
            (id, index, array) => id.length > 0 && array.indexOf(id) === index,
          );
        if (!trimmedApiKey) {
          throw new Error(t('API key cannot be empty.'));
        }
        if (modelIds.length === 0) {
          throw new Error(t('Model IDs cannot be empty.'));
        }

        const baseUrl = ALIBABA_STANDARD_API_KEY_ENDPOINTS[region];
        const persistScope = getPersistScopeForModelSelection(settings);

        const settingsFile = settings.forScope(persistScope);
        backupSettingsFile(settingsFile.path);

        settings.setValue(
          persistScope,
          `env.${DASHSCOPE_STANDARD_API_KEY_ENV_KEY}`,
          trimmedApiKey,
        );
        process.env[DASHSCOPE_STANDARD_API_KEY_ENV_KEY] = trimmedApiKey;

        const newConfigs: ProviderModelConfig[] = modelIds.map((modelId) => ({
          id: modelId,
          name: `[ModelStudio Standard] ${modelId}`,
          baseUrl,
          envKey: DASHSCOPE_STANDARD_API_KEY_ENV_KEY,
        }));

        const existingConfigs =
          (
            settings.merged.modelProviders as ModelProvidersConfig | undefined
          )?.[AuthType.USE_OPENAI] || [];

        const nonAlibabaStandardConfigs = existingConfigs.filter(
          (existing) =>
            !(
              existing.envKey === DASHSCOPE_STANDARD_API_KEY_ENV_KEY &&
              typeof existing.baseUrl === 'string' &&
              Object.values(ALIBABA_STANDARD_API_KEY_ENDPOINTS).includes(
                existing.baseUrl,
              )
            ),
        );

        const updatedConfigs = [...newConfigs, ...nonAlibabaStandardConfigs];

        settings.setValue(
          persistScope,
          `modelProviders.${AuthType.USE_OPENAI}`,
          updatedConfigs,
        );
        settings.setValue(
          persistScope,
          'security.auth.selectedType',
          AuthType.USE_OPENAI,
        );
        settings.setValue(persistScope, 'model.name', modelIds[0]);

        const updatedModelProviders: ModelProvidersConfig = {
          ...(settings.merged.modelProviders as
            | ModelProvidersConfig
            | undefined),
          [AuthType.USE_OPENAI]: updatedConfigs,
        };
        config.reloadModelProvidersConfig(updatedModelProviders);
        await config.refreshAuth(AuthType.USE_OPENAI);

        setAuthError(null);
        setAuthState(AuthState.Authenticated);
        setPendingAuthType(undefined);
        setIsAuthDialogOpen(false);
        setIsAuthenticating(false);
        onAuthChange?.();

        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Alibaba Cloud ModelStudio Standard API Key successfully entered. Settings updated with env.DASHSCOPE_API_KEY and {{modelCount}} model(s).',
              { modelCount: String(modelIds.length) },
            ),
          },
          Date.now(),
        );

        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'You can use /model to see new ModelStudio Standard models and switch between them.',
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
    [settings, config, handleAuthFailure, addItem, onAuthChange],
  );

  const handleOpenRouterSubmit = useCallback(async () => {
    try {
      setPendingAuthType(AuthType.USE_OPENAI);
      setIsAuthenticating(true);
      setAuthError(null);
      setIsAuthDialogOpen(false);
      setExternalAuthState({
        title: t('OpenRouter Authentication'),
        message: t('Waiting for OpenRouter callback...'),
        detail: OPENROUTER_OAUTH_CALLBACK_URL,
      });

      addItem(
        {
          type: MessageType.INFO,
          text: t(
            'Starting OpenRouter OAuth in your browser. Waiting for callback at {{callbackUrl}}',
            {
              callbackUrl: OPENROUTER_OAUTH_CALLBACK_URL,
            },
          ),
        },
        Date.now(),
      );

      const authStartMs = Date.now();
      const oauthStartMs = Date.now();
      const oauthResult = await runOpenRouterOAuthLogin();
      const oauthElapsed = `${((Date.now() - oauthStartMs) / 1000).toFixed(2)}s`;
      addItem(
        {
          type: MessageType.INFO,
          text: t(
            'Waited for OpenRouter browser authorization in {{elapsed}}.',
            {
              elapsed:
                typeof oauthResult.authorizationCodeWaitMs === 'number'
                  ? `${(oauthResult.authorizationCodeWaitMs / 1000).toFixed(2)}s`
                  : oauthElapsed,
            },
          ),
        },
        Date.now(),
      );
      addItem(
        {
          type: MessageType.INFO,
          text: t(
            'Exchanged OpenRouter auth code for API key in {{elapsed}}.',
            {
              elapsed:
                typeof oauthResult.apiKeyExchangeMs === 'number'
                  ? `${(oauthResult.apiKeyExchangeMs / 1000).toFixed(2)}s`
                  : oauthElapsed,
            },
          ),
        },
        Date.now(),
      );
      addItem(
        {
          type: MessageType.INFO,
          text: t('OpenRouter OAuth callback completed in {{elapsed}}.', {
            elapsed: oauthElapsed,
          }),
        },
        Date.now(),
      );
      setExternalAuthState({
        title: t('OpenRouter Authentication'),
        message: t('OpenRouter authorization complete. Requesting API key...'),
        detail: t(
          'Syncing OpenRouter models and finalizing local configuration.',
        ),
      });
      const selectedKey = oauthResult.apiKey;
      if (!selectedKey) {
        throw new Error(
          t('OpenRouter authentication completed without an API key.'),
        );
      }

      const persistScope = getPersistScopeForModelSelection(settings);
      const settingsFile = settings.forScope(persistScope);
      backupSettingsFile(settingsFile.path);

      settings.setValue(persistScope, `env.${OPENROUTER_ENV_KEY}`, selectedKey);
      process.env[OPENROUTER_ENV_KEY] = selectedKey;

      const existingConfigs =
        (settings.merged.modelProviders as ModelProvidersConfig | undefined)?.[
          AuthType.USE_OPENAI
        ] || [];
      const modelsStartMs = Date.now();
      const openRouterCatalog = await getOpenRouterModelsWithFallback();
      addItem(
        {
          type: MessageType.INFO,
          text: t('Fetched OpenRouter models in {{elapsed}}.', {
            elapsed: `${((Date.now() - modelsStartMs) / 1000).toFixed(2)}s`,
          }),
        },
        Date.now(),
      );
      const openRouterModels =
        selectRecommendedOpenRouterModels(openRouterCatalog);
      const updatedConfigs = mergeOpenRouterConfigs(
        existingConfigs,
        openRouterModels,
      );

      settings.setValue(
        persistScope,
        `modelProviders.${AuthType.USE_OPENAI}`,
        updatedConfigs,
      );
      settings.setValue(
        persistScope,
        'security.auth.selectedType',
        AuthType.USE_OPENAI,
      );
      settings.setValue(persistScope, 'model.name', OPENROUTER_DEFAULT_MODEL);

      const updatedModelProviders: ModelProvidersConfig = {
        ...(settings.merged.modelProviders as ModelProvidersConfig | undefined),
        [AuthType.USE_OPENAI]: updatedConfigs,
      };
      config.reloadModelProvidersConfig(updatedModelProviders);
      setExternalAuthState({
        title: t('OpenRouter Authentication'),
        message: t('OpenRouter authorization complete. Requesting API key...'),
        detail: t(
          'Syncing OpenRouter models and finalizing local configuration.',
        ),
      });
      const refreshStartMs = Date.now();
      await config.refreshAuth(AuthType.USE_OPENAI);
      addItem(
        {
          type: MessageType.INFO,
          text: t('Refreshed OpenRouter auth in {{elapsed}}.', {
            elapsed: `${((Date.now() - refreshStartMs) / 1000).toFixed(2)}s`,
          }),
        },
        Date.now(),
      );
      addItem(
        {
          type: MessageType.INFO,
          text: t('Total OpenRouter setup time: {{elapsed}}.', {
            elapsed: `${((Date.now() - authStartMs) / 1000).toFixed(2)}s`,
          }),
        },
        Date.now(),
      );

      setAuthError(null);
      setExternalAuthState(null);
      setAuthState(AuthState.Authenticated);
      setPendingAuthType(undefined);
      setIsAuthDialogOpen(false);
      setIsAuthenticating(false);
      onAuthChange?.();

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
          text: t(
            'You can use /model to switch between available OpenRouter models.',
          ),
        },
        Date.now(),
      );

      const authEvent = new AuthEvent(AuthType.USE_OPENAI, 'manual', 'success');
      logAuth(config, authEvent);
    } catch (error) {
      handleAuthFailure(error);
    }
  }, [settings, config, handleAuthFailure, addItem, onAuthChange]);

  /**
   /**
    * We previously used a useEffect to trigger authentication automatically when
    * settings.security.auth.selectedType changed. This caused problems: if authentication failed,
    * the UI could get stuck, since settings.json would update before success. Now, we
    * update selectedType in settings only when authentication fully succeeds.
    * Authentication is triggered explicitly—either during initial app startup or when the
    * user switches methods—not reactively through settings changes. This avoids repeated
    * or broken authentication cycles.
    */
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
    handleCodingPlanSubmit,
    handleAlibabaStandardSubmit,
    handleOpenRouterSubmit,
    openAuthDialog,
    cancelAuthentication,
  };
};
