/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  CODING_PLAN_ENDPOINTS,
  CODING_PLAN_OPTION,
  isCodingPlanConfig,
  resolveCodingPlanEndpoint,
  getCodingPlanConfig,
} from '../../auth/providers/alibaba/codingPlan.js';
import {
  TOKEN_PLAN_OPTION,
  getTokenPlanConfig,
} from '../../auth/providers/alibaba/tokenPlan.js';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { AlibabaModelStudioFlow } from './flows/AlibabaModelStudioFlow.js';
import { CustomProviderFlow } from './flows/CustomProviderFlow.js';
import { OAuthFlow } from './flows/OAuthFlow.js';
import { ThirdPartyProvidersFlow } from './flows/ThirdPartyProvidersFlow.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import {
  CODING_PLAN_API_KEY_URL,
  CODING_PLAN_INTL_API_KEY_URL,
  type ApiKeyInputPlan,
} from '../components/ApiKeyInput.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { t } from '../../i18n/index.js';
import {
  API_KEY_PROVIDER_OPTIONS,
  API_KEY_PROVIDERS,
  type ApiKeyProviderConfig,
  type ApiKeyProviderEndpointOption,
  type ApiKeyProviderEndpointOptionConfig,
  type ApiKeyProviderId,
} from '../../auth/setupMethods/apiKey/index.js';
import { generateCustomApiKeyEnvKey } from '../../auth/providers/custom/index.js';
import { normalizeCustomModelIds, maskApiKey } from './useAuth.js';
import type {
  ApiKeyOption,
  MainOption,
  OAuthOption,
  SubscribeOption,
  ViewLevel,
} from './flows/AuthFlowTypes.js';

const MODEL_PROVIDERS_DOCUMENTATION_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/';

function parseDefaultAuthType(
  defaultAuthType: string | undefined,
): AuthType | null {
  if (
    defaultAuthType &&
    Object.values(AuthType).includes(defaultAuthType as AuthType)
  ) {
    return defaultAuthType as AuthType;
  }
  return null;
}

function getDefaultEndpointOption(
  provider: ApiKeyProviderConfig,
): ApiKeyProviderEndpointOption | undefined {
  return provider.endpointOptions?.[0]?.id;
}

function getSelectedEndpointOptionConfig(
  provider: ApiKeyProviderConfig,
  endpointOption: ApiKeyProviderEndpointOption | undefined,
): ApiKeyProviderEndpointOptionConfig | undefined {
  return provider.endpointOptions?.find(
    (candidate) => candidate.id === endpointOption,
  );
}

function getProviderEndpoint(
  provider: ApiKeyProviderConfig,
  endpointOption: ApiKeyProviderEndpointOption | undefined,
): string {
  return (
    getSelectedEndpointOptionConfig(provider, endpointOption)?.endpoint ||
    provider.endpoint ||
    ''
  );
}

function getProviderDocumentationUrl(
  provider: ApiKeyProviderConfig,
  endpointOption: ApiKeyProviderEndpointOption | undefined,
): string | undefined {
  return (
    getSelectedEndpointOptionConfig(provider, endpointOption)
      ?.documentationUrl || provider.documentationUrl
  );
}

function getProviderFlowTitle(
  provider: ApiKeyProviderConfig,
  fallback: string,
): string {
  return provider.ui?.flowTitle || fallback;
}

function getEndpointStepTitle(provider: ApiKeyProviderConfig): string {
  return provider.ui?.endpointStepTitle || 'Endpoint';
}

function getApiKeyProviderStepCount(provider: ApiKeyProviderConfig): number {
  return provider.endpointOptions ? 4 : 3;
}

export function AuthDialog(): React.JSX.Element {
  const {
    auth: { pendingAuthType, authError },
  } = useUIState();
  const {
    auth: {
      handleAuthSelect: onAuthSelect,
      handleSubscriptionPlanSubmit,
      handleApiKeyProviderSubmit,
      handleOpenRouterSubmit,
      handleCustomApiKeySubmit,
      onAuthError,
    },
  } = useUIActions();
  const config = useConfig();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  const [baseUrlIndex, setBaseUrlIndex] = useState<number>(0);
  const [baseUrl, setBaseUrl] = useState<string>(
    CODING_PLAN_ENDPOINTS[0].baseUrl,
  );
  const [activeSubscriptionPlan, setActiveSubscriptionPlan] = useState<
    'coding' | 'token'
  >('coding');
  const [presetEndpointOptionIndex, setPresetEndpointOptionIndex] =
    useState<number>(0);
  const [apiKeyTypeIndex, setApiKeyTypeIndex] = useState<number>(0);
  const [alibabaModelStudioIndex, setAlibabaModelStudioIndex] =
    useState<number>(0);
  const [mainAuthIndex, setMainAuthIndex] = useState<number | null>(null);
  const [oauthProviderIndex, setOAuthProviderIndex] = useState<number>(0);
  const [presetApiKeyProvider, setPresetApiKeyProvider] =
    useState<ApiKeyProviderConfig>(API_KEY_PROVIDERS.alibabaStandard);
  const [presetEndpointOption, setPresetEndpointOption] = useState<
    ApiKeyProviderEndpointOption | undefined
  >(getDefaultEndpointOption(API_KEY_PROVIDERS.alibabaStandard));
  const [presetApiKey, setPresetApiKey] = useState('');
  const [presetApiKeyError, setPresetApiKeyError] = useState<string | null>(
    null,
  );
  const [presetModelId, setPresetModelId] = useState('');
  const [presetModelIdError, setPresetModelIdError] = useState<string | null>(
    null,
  );

  // Custom API Key wizard state
  const [customProtocolIndex, setCustomProtocolIndex] = useState<number>(0);
  const [customProtocol, setCustomProtocol] = useState<AuthType>(
    AuthType.USE_OPENAI,
  );
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customBaseUrlError, setCustomBaseUrlError] = useState<string | null>(
    null,
  );
  const [customApiKey, setCustomApiKey] = useState('');
  const [customApiKeyError, setCustomApiKeyError] = useState<string | null>(
    null,
  );
  const [customModelIds, setCustomModelIds] = useState('');
  const [customModelIdsError, setCustomModelIdsError] = useState<string | null>(
    null,
  );

  // Advanced generation config state
  const [advancedThinkingEnabled, setAdvancedThinkingEnabled] = useState(false);
  const [advancedModalityEnabled, setAdvancedModalityEnabled] = useState(false);
  const [focusedConfigIndex, setFocusedConfigIndex] = useState(0);
  // 0 = thinking, 1 = modality

  // Main authentication entries mirror the four user-facing flows from the design doc.
  const mainItems = [
    {
      key: 'ALIBABA_MODELSTUDIO',
      title: t('Alibaba ModelStudio'),
      label: t('Alibaba ModelStudio'),
      description: t(
        'Official recommended setup: Coding Plan, Token Plan, or Standard API Key',
      ),
      value: 'ALIBABA_MODELSTUDIO' as MainOption,
    },
    {
      key: 'THIRD_PARTY_PROVIDERS',
      title: t('Third-party Providers'),
      label: t('Third-party Providers'),
      description: t('Choose a built-in provider and connect with an API key'),
      value: 'THIRD_PARTY_PROVIDERS' as MainOption,
    },
    {
      key: 'OAUTH',
      title: t('OAuth'),
      label: t('OAuth'),
      description: t(
        'Open a browser, sign in, and let the CLI finish provider setup',
      ),
      value: 'OAUTH' as MainOption,
    },
    {
      key: 'CUSTOM_PROVIDER',
      title: t('Custom Provider'),
      label: t('Custom Provider'),
      description: t(
        'Manually connect a local server, proxy, or unsupported provider',
      ),
      value: 'CUSTOM_PROVIDER' as MainOption,
    },
  ];

  const subscriptionPlanOptions = [CODING_PLAN_OPTION, TOKEN_PLAN_OPTION];
  const subscriptionPlanItems = subscriptionPlanOptions.map((plan) => ({
    key: plan.option,
    title: t(plan.title),
    label: t(plan.title),
    description: t(plan.description),
    value: plan.option as SubscribeOption,
  }));

  const baseUrlItems = CODING_PLAN_ENDPOINTS.map((endpoint) => ({
    key: endpoint.baseUrl,
    title: t(endpoint.title),
    label: t(endpoint.title),
    description: (
      <Link url={endpoint.documentationUrl} fallback={false}>
        <Text color={theme.text.secondary}>{endpoint.baseUrl}</Text>
      </Link>
    ),
    value: endpoint.baseUrl,
  }));

  const presetEndpointOptionItems =
    presetApiKeyProvider.endpointOptions?.map((endpointOptionConfig) => ({
      key: endpointOptionConfig.id,
      title: t(endpointOptionConfig.title),
      label: t(endpointOptionConfig.title),
      description: (
        <Text color={theme.text.secondary}>
          Endpoint: {endpointOptionConfig.endpoint}
        </Text>
      ),
      value: endpointOptionConfig.id,
    })) || [];

  const protocolItems = [
    {
      key: AuthType.USE_OPENAI,
      title: t('OpenAI-compatible'),
      label: t('OpenAI-compatible'),
      description: t(
        'OpenAI Chat Completions API (OpenRouter, vLLM, Ollama, LM Studio, Fireworks, etc.)',
      ),
      value: AuthType.USE_OPENAI as AuthType,
    },
    {
      key: AuthType.USE_ANTHROPIC,
      title: t('Anthropic-compatible'),
      label: t('Anthropic-compatible'),
      description: t('Anthropic Messages API'),
      value: AuthType.USE_ANTHROPIC as AuthType,
    },
    {
      key: AuthType.USE_GEMINI,
      title: t('Gemini-compatible'),
      label: t('Gemini-compatible'),
      description: t('Google Gemini API'),
      value: AuthType.USE_GEMINI as AuthType,
    },
  ];

  const DEFAULT_CUSTOM_BASE_URLS: Partial<Record<AuthType, string>> = {
    [AuthType.USE_OPENAI]: 'https://api.openai.com/v1',
    [AuthType.USE_ANTHROPIC]: 'https://api.anthropic.com/v1',
    [AuthType.USE_GEMINI]: 'https://generativelanguage.googleapis.com',
  };

  const alibabaModelStudioItems = [
    ...subscriptionPlanItems,
    {
      key: API_KEY_PROVIDERS.alibabaStandard.option,
      title: t(API_KEY_PROVIDERS.alibabaStandard.title),
      label: t(API_KEY_PROVIDERS.alibabaStandard.title),
      description: t(API_KEY_PROVIDERS.alibabaStandard.description),
      value: API_KEY_PROVIDERS.alibabaStandard.option as
        | SubscribeOption
        | ApiKeyOption,
    },
  ];

  const apiKeyTypeItems = API_KEY_PROVIDER_OPTIONS.filter(
    (provider) => provider.category === 'third-party',
  ).map((provider) => ({
    key: provider.option,
    title: t(provider.title),
    label: t(provider.title),
    description: t(provider.description),
    value: provider.option as ApiKeyOption,
  }));

  const oauthProviderItems = [
    {
      key: 'OPENROUTER_OAUTH',
      title: t('OpenRouter'),
      label: t('OpenRouter'),
      description: t(
        'Browser OAuth · Auto-configure API key and OpenRouter models',
      ),
      value: 'OPENROUTER_OAUTH' as OAuthOption,
    },
    {
      key: 'QWEN_OAUTH_DISCONTINUED',
      title: t('Qwen'),
      label: t('Qwen'),
      description: t('Discontinued — switch to Coding Plan or API Key'),
      value: 'QWEN_OAUTH_DISCONTINUED' as OAuthOption,
    },
  ];

  // Map a saved auth type to the closest user-facing flow.
  const contentGenConfig = config.getContentGeneratorConfig();
  const isCurrentlyCodingPlan =
    isCodingPlanConfig(
      contentGenConfig?.baseUrl,
      contentGenConfig?.apiKeyEnvKey,
    ) !== false;
  const authTypeToMainOption = (authType: AuthType): MainOption => {
    if (authType === AuthType.QWEN_OAUTH) return 'OAUTH';
    if (authType === AuthType.USE_OPENAI && isCurrentlyCodingPlan) {
      return 'ALIBABA_MODELSTUDIO';
    }
    return 'THIRD_PARTY_PROVIDERS';
  };

  const defaultAuthIndex = Math.max(
    0,
    mainItems.findIndex((item) => {
      // Priority 1: pendingAuthType
      if (pendingAuthType) {
        return item.value === authTypeToMainOption(pendingAuthType);
      }

      // Priority 2: config.getAuthType() - the source of truth
      const currentAuthType = config.getAuthType();
      if (currentAuthType) {
        return item.value === authTypeToMainOption(currentAuthType);
      }

      // Priority 3: QWEN_DEFAULT_AUTH_TYPE env var
      const defaultAuthType = parseDefaultAuthType(
        process.env['QWEN_DEFAULT_AUTH_TYPE'],
      );
      if (defaultAuthType) {
        return item.value === authTypeToMainOption(defaultAuthType);
      }

      // Priority 4: default to the official recommended flow.
      return item.value === 'ALIBABA_MODELSTUDIO';
    }),
  );
  const initialAuthIndex = mainAuthIndex ?? defaultAuthIndex;
  const activeMainOption = mainItems[initialAuthIndex]?.value;

  const handleMainSelect = async (value: MainOption) => {
    setErrorMessage(null);
    onAuthError(null);

    if (value === 'ALIBABA_MODELSTUDIO') {
      setViewLevel('alibaba-modelstudio-select');
      return;
    }

    if (value === 'THIRD_PARTY_PROVIDERS') {
      setViewLevel('api-key-type-select');
      return;
    }

    if (value === 'OAUTH') {
      setViewLevel('oauth-provider-select');
      return;
    }

    setCustomProtocolIndex(0);
    setCustomProtocol(AuthType.USE_OPENAI);
    setCustomBaseUrl('');
    setCustomBaseUrlError(null);
    setCustomApiKey('');
    setCustomApiKeyError(null);
    setCustomModelIds('');
    setCustomModelIdsError(null);
    setAdvancedThinkingEnabled(false);
    setAdvancedModalityEnabled(false);
    setFocusedConfigIndex(0);
    setViewLevel('custom-protocol-select');
  };

  const handleAlibabaModelStudioSelect = async (
    value: SubscribeOption | ApiKeyOption,
  ) => {
    const selectedPlan = subscriptionPlanOptions.find(
      (plan) => plan.option === value,
    );
    if (selectedPlan) {
      await handleSubscriptionPlanSelect(value as SubscribeOption);
      return;
    }

    await handleApiKeyTypeSelect(value as ApiKeyOption);
  };

  const handleSubscriptionPlanSelect = async (value: SubscribeOption) => {
    setErrorMessage(null);
    onAuthError(null);

    const selectedPlan = subscriptionPlanOptions.find(
      (plan) => plan.option === value,
    );
    if (!selectedPlan) {
      return;
    }

    setActiveSubscriptionPlan(selectedPlan.id);
    if (selectedPlan.id === 'coding') {
      setBaseUrl(CODING_PLAN_ENDPOINTS[0].baseUrl);
      setBaseUrlIndex(0);
      setViewLevel('base-url-select');
      return;
    }

    setViewLevel('api-key-input');
  };

  const handleApiKeyTypeSelect = async (value: ApiKeyOption) => {
    setErrorMessage(null);
    onAuthError(null);

    const selectedProvider = API_KEY_PROVIDER_OPTIONS.find(
      (provider) => provider.option === value,
    ) as ApiKeyProviderConfig | undefined;
    if (selectedProvider) {
      setPresetApiKeyProvider(selectedProvider);
      setPresetEndpointOption(getDefaultEndpointOption(selectedProvider));
      setPresetEndpointOptionIndex(0);
      setPresetApiKey('');
      setPresetApiKeyError(null);
      setPresetModelId(selectedProvider.defaultModelIds);
      setPresetModelIdError(null);
      setViewLevel(
        selectedProvider.endpointOptions
          ? 'preset-api-key-endpoint-select'
          : 'preset-api-key-input',
      );
      return;
    }
  };

  const handleOAuthProviderSelect = async (value: OAuthOption) => {
    setErrorMessage(null);
    onAuthError(null);

    if (value === 'OPENROUTER_OAUTH') {
      await handleOpenRouterSubmit();
      return;
    }

    // Qwen OAuth free tier discontinued — show warning instead of proceeding
    if (value === 'QWEN_OAUTH_DISCONTINUED') {
      setErrorMessage(
        t(
          'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.',
        ),
      );
      return;
    }

    await onAuthSelect(AuthType.USE_OPENAI);
  };

  const handleBaseUrlSelect = async (selectedBaseUrl: string) => {
    setErrorMessage(null);
    onAuthError(null);
    setBaseUrl(selectedBaseUrl);
    setViewLevel('api-key-input');
  };

  const handlePresetEndpointOptionSelect = async (
    selectedEndpointOption: ApiKeyProviderEndpointOption,
  ) => {
    setErrorMessage(null);
    onAuthError(null);
    setPresetApiKeyError(null);
    setPresetModelIdError(null);
    setPresetEndpointOption(selectedEndpointOption);
    setViewLevel('preset-api-key-input');
  };

  const handleApiKeyInputSubmit = async (apiKey: string) => {
    setErrorMessage(null);

    if (!apiKey.trim()) {
      setErrorMessage(t('API key cannot be empty.'));
      return;
    }

    await handleSubscriptionPlanSubmit(
      activeSubscriptionPlan,
      apiKey,
      activeSubscriptionPlan === 'coding' ? baseUrl : undefined,
    );
  };

  const handlePresetApiKeySubmit = () => {
    const trimmedKey = presetApiKey.trim();
    if (!trimmedKey) {
      setPresetApiKeyError(t('API key cannot be empty.'));
      return;
    }

    setPresetApiKeyError(null);
    if (!presetModelId.trim()) {
      setPresetModelId(presetApiKeyProvider.defaultModelIds);
    }
    setViewLevel('preset-model-id-input');
  };

  const handlePresetModelSubmit = () => {
    const trimmedApiKey = presetApiKey.trim();
    const trimmedModelIds = presetModelId.trim();
    if (!trimmedApiKey) {
      setPresetApiKeyError(t('API key cannot be empty.'));
      setViewLevel('preset-api-key-input');
      return;
    }
    if (!trimmedModelIds) {
      setPresetModelIdError(t('Model IDs cannot be empty.'));
      return;
    }

    setPresetModelIdError(null);
    void handleApiKeyProviderSubmit(
      presetApiKeyProvider.id as ApiKeyProviderId,
      trimmedApiKey,
      trimmedModelIds,
      presetEndpointOption || getDefaultEndpointOption(presetApiKeyProvider),
    );
  };

  const handleCustomProtocolSelect = (protocol: AuthType) => {
    setErrorMessage(null);
    onAuthError(null);
    setCustomProtocol(protocol);
    const defaultUrl = DEFAULT_CUSTOM_BASE_URLS[protocol] ?? '';
    setCustomBaseUrl(defaultUrl);
    setCustomBaseUrlError(null);
    setViewLevel('custom-base-url-input');
  };

  const handleCustomBaseUrlSubmit = () => {
    const trimmedUrl = customBaseUrl.trim();
    if (!trimmedUrl) {
      setCustomBaseUrlError(t('Base URL cannot be empty.'));
      return;
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setCustomBaseUrlError(t('Base URL must start with http:// or https://.'));
      return;
    }
    setCustomBaseUrlError(null);
    setCustomApiKey('');
    setCustomApiKeyError(null);
    setViewLevel('custom-api-key-input');
  };

  const handleCustomApiKeySubmitLocal = () => {
    const trimmedKey = customApiKey.trim();
    if (!trimmedKey) {
      setCustomApiKeyError(t('API key cannot be empty.'));
      return;
    }
    setCustomApiKeyError(null);
    setCustomModelIds('');
    setCustomModelIdsError(null);
    setViewLevel('custom-model-id-input');
  };

  const handleCustomModelIdSubmit = () => {
    const normalized = normalizeCustomModelIds(customModelIds);
    if (normalized.length === 0) {
      setCustomModelIdsError(t('Model IDs cannot be empty.'));
      return;
    }
    setCustomModelIdsError(null);
    setViewLevel('custom-advanced-config');
  };

  const handleAdvancedConfigSubmit = () => {
    setViewLevel('custom-review-json');
  };

  const handleCustomReviewSubmit = () => {
    const trimmedBaseUrl = customBaseUrl.trim();
    const trimmedApiKey = customApiKey.trim();
    const trimmedModelIds = customModelIds;

    // Build generationConfig only if any advanced option is set
    const hasThinking = advancedThinkingEnabled;
    const hasModality = advancedModalityEnabled;

    const generationConfig =
      hasThinking || hasModality
        ? {
            enableThinking: hasThinking ? true : undefined,
            multimodal: hasModality
              ? { image: true, video: true, audio: true }
              : undefined,
          }
        : undefined;

    void handleCustomApiKeySubmit(
      customProtocol as
        | AuthType.USE_OPENAI
        | AuthType.USE_ANTHROPIC
        | AuthType.USE_GEMINI,
      trimmedBaseUrl,
      trimmedApiKey,
      trimmedModelIds,
      generationConfig,
    );
  };

  const handleGoBack = () => {
    setErrorMessage(null);
    onAuthError(null);

    if (viewLevel === 'alibaba-modelstudio-select') {
      setViewLevel('main');
    } else if (viewLevel === 'base-url-select') {
      setViewLevel('alibaba-modelstudio-select');
    } else if (viewLevel === 'api-key-input') {
      setViewLevel(
        activeSubscriptionPlan === 'coding'
          ? 'base-url-select'
          : 'alibaba-modelstudio-select',
      );
    } else if (viewLevel === 'api-key-type-select') {
      setViewLevel('main');
    } else if (viewLevel === 'custom-protocol-select') {
      setViewLevel('main');
    } else if (viewLevel === 'custom-base-url-input') {
      setViewLevel('custom-protocol-select');
    } else if (viewLevel === 'custom-api-key-input') {
      setViewLevel('custom-base-url-input');
    } else if (viewLevel === 'custom-model-id-input') {
      setViewLevel('custom-api-key-input');
    } else if (viewLevel === 'custom-advanced-config') {
      setViewLevel('custom-model-id-input');
    } else if (viewLevel === 'custom-review-json') {
      setViewLevel('custom-advanced-config');
    } else if (viewLevel === 'preset-api-key-endpoint-select') {
      setViewLevel(
        activeMainOption === 'ALIBABA_MODELSTUDIO'
          ? 'alibaba-modelstudio-select'
          : 'api-key-type-select',
      );
    } else if (viewLevel === 'preset-api-key-input') {
      setViewLevel(
        presetApiKeyProvider.endpointOptions
          ? 'preset-api-key-endpoint-select'
          : activeMainOption === 'ALIBABA_MODELSTUDIO'
            ? 'alibaba-modelstudio-select'
            : 'api-key-type-select',
      );
    } else if (viewLevel === 'preset-model-id-input') {
      setViewLevel('preset-api-key-input');
    } else if (viewLevel === 'oauth-provider-select') {
      setViewLevel('main');
    }
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        // Handle Escape based on current view level
        if (viewLevel === 'alibaba-modelstudio-select') {
          handleGoBack();
          return;
        }

        if (viewLevel === 'base-url-select') {
          handleGoBack();
          return;
        }

        if (viewLevel === 'api-key-input') {
          handleGoBack();
          return;
        }
        if (
          viewLevel === 'custom-protocol-select' ||
          viewLevel === 'custom-base-url-input' ||
          viewLevel === 'custom-api-key-input' ||
          viewLevel === 'custom-model-id-input' ||
          viewLevel === 'custom-advanced-config' ||
          viewLevel === 'custom-review-json'
        ) {
          handleGoBack();
          return;
        }
        if (
          viewLevel === 'api-key-type-select' ||
          viewLevel === 'preset-api-key-endpoint-select' ||
          viewLevel === 'preset-api-key-input' ||
          viewLevel === 'preset-model-id-input' ||
          viewLevel === 'oauth-provider-select'
        ) {
          handleGoBack();
          return;
        }

        // For main view, use existing logic
        if (errorMessage) {
          return;
        }
        if (config.getAuthType() === undefined) {
          setErrorMessage(
            t(
              'You must select an auth method to proceed. Press Ctrl+C again to exit.',
            ),
          );
          return;
        }
        onAuthSelect(undefined);
      }
    },
    { isActive: true },
  );

  // Handle Enter key for review view to save
  useKeypress(
    (key) => {
      if (key.name === 'return' && viewLevel === 'custom-review-json') {
        handleCustomReviewSubmit();
      }
    },
    { isActive: true },
  );

  // Advanced config keypress: ↑↓ to navigate, Space to toggle, Enter to submit
  useKeypress(
    (key) => {
      if (viewLevel !== 'custom-advanced-config') return;

      const { name } = key;

      if (name === 'up') {
        setFocusedConfigIndex((v) => (v <= 0 ? 1 : v - 1));
        return;
      }

      if (name === 'down') {
        setFocusedConfigIndex((v) => (v >= 1 ? 0 : v + 1));
        return;
      }

      if (name === 'space') {
        if (focusedConfigIndex === 0) {
          setAdvancedThinkingEnabled((v) => !v);
        } else {
          setAdvancedModalityEnabled((v) => !v);
        }
        return;
      }

      if (name === 'return') {
        handleAdvancedConfigSubmit();
        return;
      }
    },
    { isActive: true },
  );

  // Render main auth selection
  const renderMainView = () => (
    <>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={mainItems}
          initialIndex={initialAuthIndex}
          onSelect={handleMainSelect}
          onHighlight={(value) => {
            const index = mainItems.findIndex((item) => item.value === value);
            setMainAuthIndex(index);
          }}
          itemGap={1}
        />
      </Box>
    </>
  );

  const getSubscriptionApiKeyInputPlan = (): ApiKeyInputPlan => {
    const plan =
      activeSubscriptionPlan === 'token'
        ? getTokenPlanConfig()
        : getCodingPlanConfig(baseUrl);
    const resolvedEndpoint = resolveCodingPlanEndpoint(baseUrl);
    const apiKeyUrl =
      plan.apiKeyUrl ||
      (activeSubscriptionPlan === 'coding' &&
      resolvedEndpoint.baseUrl === CODING_PLAN_ENDPOINTS[1].baseUrl
        ? CODING_PLAN_INTL_API_KEY_URL
        : CODING_PLAN_API_KEY_URL);

    return {
      apiKeyUrl,
      helpText: t('You can get your {{plan}} API key here', {
        plan: t(plan.displayName),
      }),
      placeholder: activeSubscriptionPlan === 'coding' ? 'sk-sp-...' : 'sk-...',
      validate: (apiKey) =>
        activeSubscriptionPlan === 'coding' &&
        resolvedEndpoint.baseUrl === CODING_PLAN_ENDPOINTS[0].baseUrl &&
        !apiKey.startsWith('sk-sp-')
          ? t(
              'Invalid API key. Coding Plan API keys start with "sk-sp-". Please check.',
            )
          : null,
    };
  };

  const getCustomProviderPreviewJson = () => {
    const generatedEnvKey = generateCustomApiKeyEnvKey(
      customProtocol,
      customBaseUrl.trim(),
    );
    const normalizedIds = normalizeCustomModelIds(customModelIds);
    const maskedKey = maskApiKey(customApiKey);
    const hasThinking = advancedThinkingEnabled;
    const hasModality = advancedModalityEnabled;
    const hasGenConfig = hasThinking || hasModality;

    let genConfig: Record<string, unknown> | undefined;
    if (hasGenConfig) {
      genConfig = {};
      if (hasModality) {
        genConfig['modalities'] = {
          image: true,
          video: true,
          audio: true,
        };
      }
      if (hasThinking) {
        genConfig['extra_body'] = {
          enable_thinking: true,
        };
      }
    }

    const modelEntries = normalizedIds.map((id) => {
      const entry: Record<string, unknown> = {
        id,
        name: id,
        baseUrl: customBaseUrl.trim(),
        envKey: generatedEnvKey,
      };
      if (genConfig) {
        entry['generationConfig'] = genConfig;
      }
      return entry;
    });

    return JSON.stringify(
      {
        env: { [generatedEnvKey]: maskedKey },
        modelProviders: {
          [customProtocol]: modelEntries,
        },
        security: {
          auth: {
            selectedType: customProtocol,
          },
        },
        model: {
          name: normalizedIds[0],
        },
      },
      null,
      2,
    );
  };

  const getViewTitle = () => {
    switch (viewLevel) {
      case 'main':
        return t('Select Authentication Method');
      case 'alibaba-modelstudio-select':
        return t('Alibaba ModelStudio \u00B7 Step 1/3 \u00B7 Access Method');
      case 'base-url-select':
        return t('Alibaba ModelStudio \u00B7 Step 2/3 \u00B7 Region');
      case 'api-key-input':
        return activeSubscriptionPlan === 'token'
          ? t('Alibaba ModelStudio \u00B7 Step 2/2 \u00B7 API Key')
          : t('Alibaba ModelStudio \u00B7 Step 3/3 \u00B7 API Key');
      case 'api-key-type-select':
        return t('Third-party Providers \u00B7 Step 1/3 \u00B7 Provider');
      case 'preset-api-key-endpoint-select': {
        const flowTitle = getProviderFlowTitle(
          presetApiKeyProvider,
          'Third-party Providers',
        );
        const stepTitle = getEndpointStepTitle(presetApiKeyProvider);
        return t('{{flowTitle}} \u00B7 Step 2/4 \u00B7 {{stepTitle}}', {
          flowTitle,
          stepTitle,
        });
      }
      case 'preset-api-key-input': {
        const flowTitle = getProviderFlowTitle(
          presetApiKeyProvider,
          'Third-party Providers',
        );
        const stepCount = getApiKeyProviderStepCount(presetApiKeyProvider);
        const stepNumber = presetApiKeyProvider.endpointOptions ? 3 : 2;
        return t(
          '{{flowTitle}} \u00B7 Step {{stepNumber}}/{{stepCount}} \u00B7 API Key',
          {
            flowTitle,
            stepNumber: String(stepNumber),
            stepCount: String(stepCount),
          },
        );
      }
      case 'preset-model-id-input': {
        const flowTitle = getProviderFlowTitle(
          presetApiKeyProvider,
          'Third-party Providers',
        );
        const stepCount = getApiKeyProviderStepCount(presetApiKeyProvider);
        const stepNumber = presetApiKeyProvider.endpointOptions ? 4 : 3;
        return t(
          '{{flowTitle}} \u00B7 Step {{stepNumber}}/{{stepCount}} \u00B7 Models',
          {
            flowTitle,
            stepNumber: String(stepNumber),
            stepCount: String(stepCount),
          },
        );
      }
      case 'custom-protocol-select':
        return t('Custom Provider \u00B7 Step 1/6 \u00B7 Protocol');
      case 'custom-base-url-input':
        return t('Custom Provider \u00B7 Step 2/6 \u00B7 Base URL');
      case 'custom-api-key-input':
        return t('Custom Provider \u00B7 Step 3/6 \u00B7 API Key');
      case 'custom-model-id-input':
        return t('Custom Provider \u00B7 Step 4/6 \u00B7 Model IDs');
      case 'custom-advanced-config':
        return t('Custom Provider \u00B7 Step 5/6 \u00B7 Advanced Config');
      case 'custom-review-json':
        return t('Custom Provider \u00B7 Step 6/6 \u00B7 Review');
      case 'oauth-provider-select':
        return t('Select OAuth Provider');
      default:
        return t('Select Authentication Method');
    }
  };

  return (
    <Box
      borderStyle="single"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{getViewTitle()}</Text>

      {viewLevel === 'main' && renderMainView()}
      <AlibabaModelStudioFlow
        viewLevel={viewLevel}
        items={alibabaModelStudioItems}
        initialIndex={alibabaModelStudioIndex}
        baseUrlItems={baseUrlItems}
        baseUrlIndex={baseUrlIndex}
        subscriptionApiKeyPlan={getSubscriptionApiKeyInputPlan()}
        onSelect={handleAlibabaModelStudioSelect}
        onHighlight={(value) => {
          const index = alibabaModelStudioItems.findIndex(
            (item) => item.value === value,
          );
          setAlibabaModelStudioIndex(index);
        }}
        onBaseUrlSelect={handleBaseUrlSelect}
        onBaseUrlHighlight={(value) => {
          const index = baseUrlItems.findIndex((item) => item.value === value);
          setBaseUrlIndex(index);
        }}
        onApiKeySubmit={handleApiKeyInputSubmit}
        onBack={handleGoBack}
      />
      <ThirdPartyProvidersFlow
        viewLevel={viewLevel}
        items={apiKeyTypeItems}
        initialIndex={apiKeyTypeIndex}
        preset={{
          providerTitle: presetApiKeyProvider.title,
          providerDefaultModelIds: presetApiKeyProvider.defaultModelIds,
          endpointOption: presetEndpointOption,
          endpointOptionItems: presetEndpointOptionItems,
          endpointOptionIndex: presetEndpointOptionIndex,
          apiKey: presetApiKey,
          apiKeyError: presetApiKeyError,
          modelId: presetModelId,
          modelIdError: presetModelIdError,
          endpoint: getProviderEndpoint(
            presetApiKeyProvider,
            presetEndpointOption,
          ),
          documentationUrl: getProviderDocumentationUrl(
            presetApiKeyProvider,
            presetEndpointOption,
          ),
        }}
        onSelect={handleApiKeyTypeSelect}
        onHighlight={(value) => {
          const index = apiKeyTypeItems.findIndex(
            (item) => item.value === value,
          );
          setApiKeyTypeIndex(index);
        }}
        onEndpointOptionSelect={handlePresetEndpointOptionSelect}
        onEndpointOptionHighlight={(value) => {
          const index = presetEndpointOptionItems.findIndex(
            (item) => item.value === value,
          );
          setPresetEndpointOptionIndex(index);
        }}
        onApiKeyChange={(value) => {
          setPresetApiKey(value);
          if (presetApiKeyError) {
            setPresetApiKeyError(null);
          }
        }}
        onApiKeySubmit={handlePresetApiKeySubmit}
        onModelIdChange={(value) => {
          setPresetModelId(value);
          if (presetModelIdError) {
            setPresetModelIdError(null);
          }
        }}
        onModelSubmit={handlePresetModelSubmit}
      />
      {viewLevel === 'oauth-provider-select' && (
        <OAuthFlow
          items={oauthProviderItems}
          initialIndex={oauthProviderIndex}
          onSelect={handleOAuthProviderSelect}
          onHighlight={(value) => {
            const index = oauthProviderItems.findIndex(
              (item) => item.value === value,
            );
            setOAuthProviderIndex(index);
          }}
        />
      )}
      <CustomProviderFlow
        viewLevel={viewLevel}
        state={{
          protocolItems,
          protocolIndex: customProtocolIndex,
          protocol: customProtocol,
          baseUrl: customBaseUrl,
          baseUrlError: customBaseUrlError,
          apiKey: customApiKey,
          apiKeyError: customApiKeyError,
          modelIds: customModelIds,
          modelIdsError: customModelIdsError,
          focusedConfigIndex,
          thinkingEnabled: advancedThinkingEnabled,
          modalityEnabled: advancedModalityEnabled,
          previewJson: getCustomProviderPreviewJson(),
        }}
        documentationUrl={MODEL_PROVIDERS_DOCUMENTATION_URL}
        onProtocolSelect={handleCustomProtocolSelect}
        onProtocolHighlight={(value) => {
          const index = protocolItems.findIndex((item) => item.value === value);
          setCustomProtocolIndex(index);
        }}
        onBaseUrlChange={(value) => {
          setCustomBaseUrl(value);
          if (customBaseUrlError) {
            setCustomBaseUrlError(null);
          }
        }}
        onBaseUrlSubmit={handleCustomBaseUrlSubmit}
        onApiKeyChange={(value) => {
          setCustomApiKey(value);
          if (customApiKeyError) {
            setCustomApiKeyError(null);
          }
        }}
        onApiKeySubmit={handleCustomApiKeySubmitLocal}
        onModelIdsChange={(value) => {
          setCustomModelIds(value);
          if (customModelIdsError) {
            setCustomModelIdsError(null);
          }
        }}
        onModelIdsSubmit={handleCustomModelIdSubmit}
      />

      {(authError || errorMessage) && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{authError || errorMessage}</Text>
        </Box>
      )}

      {viewLevel === 'main' && (
        <>
          {/* <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Enter to select, \u2191\u2193 to navigate, Esc to close')}
            </Text>
          </Box> */}
          <Box marginY={1}>
            <Text color={theme.border.default}>{'\u2500'.repeat(80)}</Text>
          </Box>
          <Box>
            <Text color={theme.text.primary}>
              {t('Terms of Services and Privacy Notice')}:
            </Text>
          </Box>
          <Box>
            <Link
              url="https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/"
              fallback={false}
            >
              <Text color={theme.text.secondary} underline>
                https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/
              </Text>
            </Link>
          </Box>
        </>
      )}
    </Box>
  );
}
