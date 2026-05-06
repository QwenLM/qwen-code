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
import { API_KEY_PROVIDERS } from '../../auth/setupMethods/apiKey/index.js';
import type {
  ApiKeyOption,
  MainOption,
  OAuthOption,
  SubscribeOption,
} from './flows/AuthFlowTypes.js';
import { useAuthDialogNavigation } from './flows/useAuthDialogNavigation.js';
import {
  getApiKeyProviderStepCount,
  getEndpointStepTitle,
  getProviderFlowTitle,
  usePresetApiKeyFlow,
} from './flows/usePresetApiKeyFlow.js';
import { useCustomProviderFlow } from './flows/useCustomProviderFlow.js';

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
  const navigation = useAuthDialogNavigation('main');
  const viewLevel = navigation.currentView;
  const [baseUrlIndex, setBaseUrlIndex] = useState<number>(0);
  const [baseUrl, setBaseUrl] = useState<string>(
    CODING_PLAN_ENDPOINTS[0].baseUrl,
  );
  const [activeSubscriptionPlan, setActiveSubscriptionPlan] = useState<
    'coding' | 'token'
  >('coding');
  const [alibabaModelStudioIndex, setAlibabaModelStudioIndex] =
    useState<number>(0);
  const [mainAuthIndex, setMainAuthIndex] = useState<number | null>(null);
  const [oauthProviderIndex, setOAuthProviderIndex] = useState<number>(0);
  const presetApiKeyFlow = usePresetApiKeyFlow({
    onSubmit: handleApiKeyProviderSubmit,
  });
  const customProviderFlow = useCustomProviderFlow();

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

  const handleMainSelect = async (value: MainOption) => {
    setErrorMessage(null);
    onAuthError(null);

    if (value === 'ALIBABA_MODELSTUDIO') {
      navigation.pushView('alibaba-modelstudio-select');
      return;
    }

    if (value === 'THIRD_PARTY_PROVIDERS') {
      navigation.pushView('api-key-type-select');
      return;
    }

    if (value === 'OAUTH') {
      navigation.pushView('oauth-provider-select');
      return;
    }

    customProviderFlow.reset();
    navigation.pushView('custom-protocol-select');
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
      navigation.pushView('base-url-select');
      return;
    }

    navigation.pushView('api-key-input');
  };

  const handleApiKeyTypeSelect = async (value: ApiKeyOption) => {
    setErrorMessage(null);
    onAuthError(null);

    const selectedProvider = presetApiKeyFlow.selectProvider(value);
    if (selectedProvider) {
      navigation.pushView(
        selectedProvider.endpointOptions
          ? 'preset-api-key-endpoint-select'
          : 'preset-api-key-input',
      );
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
    navigation.pushView('api-key-input');
  };

  const handlePresetEndpointOptionSelect = async (
    selectedEndpointOption: string,
  ) => {
    setErrorMessage(null);
    onAuthError(null);
    presetApiKeyFlow.selectEndpointOption(selectedEndpointOption);
    navigation.pushView('preset-api-key-input');
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
    if (presetApiKeyFlow.submitApiKey()) {
      navigation.pushView('preset-model-id-input');
    }
  };

  const handlePresetModelSubmit = () => {
    const result = presetApiKeyFlow.submitModel();
    if (result === 'api-key-error') {
      navigation.replaceView('preset-api-key-input');
    }
  };

  const handleCustomProtocolSelect = (protocol: AuthType) => {
    setErrorMessage(null);
    onAuthError(null);
    customProviderFlow.selectProtocol(protocol);
    navigation.pushView('custom-base-url-input');
  };

  const handleCustomBaseUrlSubmit = () => {
    if (customProviderFlow.submitBaseUrl()) {
      navigation.pushView('custom-api-key-input');
    }
  };

  const handleCustomApiKeySubmitLocal = () => {
    if (customProviderFlow.submitApiKey()) {
      navigation.pushView('custom-model-id-input');
    }
  };

  const handleCustomModelIdSubmit = () => {
    if (customProviderFlow.submitModelIds()) {
      navigation.pushView('custom-advanced-config');
    }
  };

  const handleAdvancedConfigSubmit = () => {
    navigation.pushView('custom-review-json');
  };

  const handleCustomReviewSubmit = () => {
    customProviderFlow.submit((...args) => {
      void handleCustomApiKeySubmit(...args);
    });
  };

  const handleGoBack = () => {
    setErrorMessage(null);
    onAuthError(null);
    navigation.goBack();
  };

  const handleSubscriptionApiKeyCancel = () => {
    if (viewLevel === 'api-key-input' && activeSubscriptionPlan === 'token') {
      setActiveSubscriptionPlan('coding');
      navigation.replaceView('alibaba-modelstudio-select');
      return;
    }

    handleGoBack();
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (viewLevel !== 'main') {
          handleGoBack();
          return;
        }

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
        customProviderFlow.moveAdvancedFocusUp();
        return;
      }

      if (name === 'down') {
        customProviderFlow.moveAdvancedFocusDown();
        return;
      }

      if (name === 'space') {
        customProviderFlow.toggleFocusedAdvancedOption();
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
          presetApiKeyFlow.provider,
          'Third-party Providers',
        );
        const stepTitle = getEndpointStepTitle(presetApiKeyFlow.provider);
        return t('{{flowTitle}} \u00B7 Step 2/4 \u00B7 {{stepTitle}}', {
          flowTitle,
          stepTitle,
        });
      }
      case 'preset-api-key-input': {
        const flowTitle = getProviderFlowTitle(
          presetApiKeyFlow.provider,
          'Third-party Providers',
        );
        const stepCount = getApiKeyProviderStepCount(presetApiKeyFlow.provider);
        const stepNumber = presetApiKeyFlow.provider.endpointOptions ? 3 : 2;
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
          presetApiKeyFlow.provider,
          'Third-party Providers',
        );
        const stepCount = getApiKeyProviderStepCount(presetApiKeyFlow.provider);
        const stepNumber = presetApiKeyFlow.provider.endpointOptions ? 4 : 3;
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
        onBack={handleSubscriptionApiKeyCancel}
      />
      <ThirdPartyProvidersFlow
        viewLevel={viewLevel}
        items={presetApiKeyFlow.providerItems}
        initialIndex={presetApiKeyFlow.providerIndex}
        preset={presetApiKeyFlow.state}
        onSelect={handleApiKeyTypeSelect}
        onHighlight={(value) => {
          const index = presetApiKeyFlow.providerItems.findIndex(
            (item) => item.value === value,
          );
          presetApiKeyFlow.setProviderIndex(index);
        }}
        onEndpointOptionSelect={handlePresetEndpointOptionSelect}
        onEndpointOptionHighlight={(value) => {
          const index = presetApiKeyFlow.state.endpointOptionItems.findIndex(
            (item) => item.value === value,
          );
          presetApiKeyFlow.setEndpointOptionIndex(index);
        }}
        onApiKeyChange={presetApiKeyFlow.changeApiKey}
        onApiKeySubmit={handlePresetApiKeySubmit}
        onModelIdChange={presetApiKeyFlow.changeModelId}
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
        state={customProviderFlow.state}
        documentationUrl={MODEL_PROVIDERS_DOCUMENTATION_URL}
        onProtocolSelect={handleCustomProtocolSelect}
        onProtocolHighlight={(value) => {
          const index = customProviderFlow.state.protocolItems.findIndex(
            (item) => item.value === value,
          );
          customProviderFlow.setProtocolIndex(index);
        }}
        onBaseUrlChange={customProviderFlow.changeBaseUrl}
        onBaseUrlSubmit={handleCustomBaseUrlSubmit}
        onApiKeyChange={customProviderFlow.changeApiKey}
        onApiKeySubmit={handleCustomApiKeySubmitLocal}
        onModelIdsChange={customProviderFlow.changeModelIds}
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
