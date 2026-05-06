/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { t } from '../../i18n/index.js';
import {
  codingPlanProvider,
  findProviderByCredentials,
  tokenPlanProvider,
  alibabaStandardProvider,
  deepseekProvider,
  minimaxProvider,
  zaiProvider,
  customProvider,
  ALIBABA_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
} from '../../auth/allProviders.js';
import type { ProviderConfig } from '../../auth/providerConfig.js';
import { useProviderSetupFlow } from './flows/useProviderSetupFlow.js';
import { ProviderSetupSteps } from './flows/ProviderSetupSteps.js';

// ---------------------------------------------------------------------------
// View levels
// ---------------------------------------------------------------------------

type ViewLevel =
  | 'main'
  | 'alibaba-select'
  | 'thirdparty-select'
  | 'oauth-select'
  | 'provider-setup'; // unified setup flow (driven by ProviderConfig)

// ---------------------------------------------------------------------------
// Top-level options
// ---------------------------------------------------------------------------

type MainOption =
  | 'ALIBABA_MODELSTUDIO'
  | 'THIRD_PARTY_PROVIDERS'
  | 'OAUTH'
  | 'CUSTOM_PROVIDER';

const MAIN_ITEMS = [
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

function providerToItem(config: ProviderConfig) {
  return {
    key: config.id,
    title: t(config.label),
    label: t(config.label),
    description: t(config.description),
    value: config.id,
  };
}

// ---------------------------------------------------------------------------
// AuthDialog
// ---------------------------------------------------------------------------

export function AuthDialog(): React.JSX.Element {
  const {
    auth: { pendingAuthType, authError },
  } = useUIState();
  const {
    auth: {
      handleAuthSelect: onAuthSelect,
      handleProviderSubmit,
      handleOpenRouterSubmit,
      onAuthError,
    },
  } = useUIActions();
  const config = useConfig();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  // Navigation stack — viewStack stores parent views for goBack
  const [_viewStack, setViewStack] = useState<ViewLevel[]>([]);

  // Selection indices for each group
  const [mainIndex, setMainIndex] = useState<number>(0);
  const [alibabaIndex, setAlibabaIndex] = useState<number>(0);
  const [thirdPartyIndex, setThirdPartyIndex] = useState<number>(0);
  const [oauthIndex, setOauthIndex] = useState<number>(0);

  // Unified provider setup flow
  const setupFlow = useProviderSetupFlow(handleProviderSubmit);

  // -- Navigation helpers ---------------------------------------------------

  const pushView = (view: ViewLevel) => {
    setViewStack((prev) => [...prev, viewLevel]);
    setViewLevel(view);
  };

  const goBack = () => {
    setErrorMessage(null);
    onAuthError(null);

    if (viewLevel === 'provider-setup') {
      const stayedInSetup = setupFlow.goBack();
      if (stayedInSetup) return;
      // Fall through to pop view stack
    }

    setViewStack((prev) => {
      const next = [...prev];
      const parent = next.pop() ?? 'main';
      setViewLevel(parent);
      return next;
    });
  };

  // -- Provider items -------------------------------------------------------

  const alibabaItems = ALIBABA_PROVIDERS.map(providerToItem);
  const thirdPartyItems = THIRD_PARTY_PROVIDERS.map(providerToItem);

  const oauthItems = [
    {
      key: 'openrouter',
      title: t('OpenRouter'),
      label: t('OpenRouter'),
      description: t(
        'Browser OAuth · Auto-configure API key and OpenRouter models',
      ),
      value: 'openrouter',
    },
    {
      key: 'qwen-oauth-discontinued',
      title: t('Qwen'),
      label: t('Qwen'),
      description: t('Discontinued — switch to Coding Plan or API Key'),
      value: 'qwen-oauth-discontinued',
    },
  ];

  // -- Compute default main index from current auth state -------------------

  const contentGenConfig = config.getContentGeneratorConfig();
  const isCurrentlyCodingPlan = !!findProviderByCredentials(
    contentGenConfig?.baseUrl,
    contentGenConfig?.apiKeyEnvKey,
  )?.metadataKey;

  const getDefaultMainIndex = () => {
    const currentAuth = pendingAuthType ?? config.getAuthType();
    if (!currentAuth) return 0;
    if (currentAuth === AuthType.QWEN_OAUTH) return 2;
    if (currentAuth === AuthType.USE_OPENAI && isCurrentlyCodingPlan) return 0;
    return 1;
  };

  const defaultMainIndex = Math.max(0, getDefaultMainIndex());

  // -- Handlers -------------------------------------------------------------

  const handleMainSelect = (value: MainOption) => {
    setErrorMessage(null);
    onAuthError(null);

    switch (value) {
      case 'ALIBABA_MODELSTUDIO':
        pushView('alibaba-select');
        break;
      case 'THIRD_PARTY_PROVIDERS':
        pushView('thirdparty-select');
        break;
      case 'OAUTH':
        pushView('oauth-select');
        break;
      case 'CUSTOM_PROVIDER':
        setupFlow.start(customProvider);
        pushView('provider-setup');
        break;
      default:
        break;
    }
  };

  const handleProviderSelect = (providerId: string) => {
    setErrorMessage(null);
    onAuthError(null);

    const providerConfig = [
      codingPlanProvider,
      tokenPlanProvider,
      alibabaStandardProvider,
      deepseekProvider,
      minimaxProvider,
      zaiProvider,
    ].find((p) => p.id === providerId);

    if (!providerConfig) return;
    setupFlow.start(providerConfig);
    pushView('provider-setup');
  };

  const handleOAuthSelect = (value: string) => {
    setErrorMessage(null);
    onAuthError(null);

    if (value === 'openrouter') {
      void handleOpenRouterSubmit();
      return;
    }

    // Qwen OAuth discontinued
    setErrorMessage(
      t(
        'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.',
      ),
    );
  };

  // -- Keyboard handling ----------------------------------------------------

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (viewLevel !== 'main') {
          goBack();
          return;
        }
        if (errorMessage) return;
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

  // Handle Enter/Space for advanced config and review steps
  useKeypress(
    (key) => {
      if (viewLevel !== 'provider-setup') return;
      const step = setupFlow.state.step;

      if (step === 'advancedConfig') {
        if (key.name === 'up') {
          setupFlow.moveAdvancedFocusUp();
          return;
        }
        if (key.name === 'down') {
          setupFlow.moveAdvancedFocusDown();
          return;
        }
        if (key.name === 'space') {
          setupFlow.toggleFocusedAdvancedOption();
          return;
        }
        if (key.name === 'return') {
          setupFlow.submitAdvancedConfig();
          return;
        }
      }

      if (step === 'review' && key.name === 'return') {
        setupFlow.submit();
      }
    },
    { isActive: true },
  );

  // -- View title -----------------------------------------------------------

  const getGroupStepLabel = (groupLabel: string): string =>
    groupLabel === 'Alibaba ModelStudio' ? 'Access Method' : 'Provider';

  const getStepLabel = (step: string | null, p: ProviderConfig): string => {
    if (step === 'protocol') return 'Protocol';
    if (step === 'baseUrl') {
      if (p.uiLabels?.baseUrlStepTitle) return p.uiLabels.baseUrlStepTitle;
      return Array.isArray(p.baseUrl) ? 'Endpoint' : 'Base URL';
    }
    if (step === 'apiKey') return 'API Key';
    if (step === 'models') return 'Model IDs';
    if (step === 'advancedConfig') return 'Advanced Config';
    if (step === 'review') return 'Review';
    return '';
  };

  const getViewTitle = (): string => {
    switch (viewLevel) {
      case 'main':
        return t('Select Authentication Method');
      case 'alibaba-select':
        return t('Alibaba ModelStudio · {{stepLabel}}', {
          stepLabel: getGroupStepLabel('Alibaba ModelStudio'),
        });
      case 'thirdparty-select':
        return t('Third-party Providers · {{stepLabel}}', {
          stepLabel: getGroupStepLabel('Third-party Providers'),
        });
      case 'oauth-select':
        return t('Select OAuth Provider');
      case 'provider-setup': {
        const p = setupFlow.state.provider;
        if (!p) return t('Provider Setup');
        const flowTitle = p.uiLabels?.flowTitle ?? p.label;
        const { stepIndex, totalSteps, step } = setupFlow.state;

        return t('{{flowTitle}} · Step {{step}}/{{total}} · {{stepLabel}}', {
          flowTitle,
          step: String(stepIndex),
          total: String(totalSteps),
          stepLabel: getStepLabel(step, p),
        });
      }
      default:
        return t('Select Authentication Method');
    }
  };

  // -- Render ---------------------------------------------------------------

  return (
    <Box
      borderStyle="single"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{getViewTitle()}</Text>

      {viewLevel === 'main' && (
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={MAIN_ITEMS}
            initialIndex={mainIndex || defaultMainIndex}
            onSelect={handleMainSelect}
            onHighlight={(value) => {
              setMainIndex(
                MAIN_ITEMS.findIndex((item) => item.value === value),
              );
            }}
            itemGap={1}
          />
        </Box>
      )}

      {viewLevel === 'alibaba-select' && (
        <>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={alibabaItems}
              initialIndex={alibabaIndex}
              onSelect={handleProviderSelect}
              onHighlight={(value) => {
                setAlibabaIndex(
                  alibabaItems.findIndex((i) => i.value === value),
                );
              }}
              itemGap={1}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={theme?.text?.secondary}>
              {t('Enter to select, ↑↓ to navigate, Esc to go back')}
            </Text>
          </Box>
        </>
      )}

      {viewLevel === 'thirdparty-select' && (
        <>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={thirdPartyItems}
              initialIndex={thirdPartyIndex}
              onSelect={handleProviderSelect}
              onHighlight={(value) => {
                setThirdPartyIndex(
                  thirdPartyItems.findIndex((i) => i.value === value),
                );
              }}
              itemGap={1}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={theme?.text?.secondary}>
              {t('Enter to select, ↑↓ to navigate, Esc to go back')}
            </Text>
          </Box>
        </>
      )}

      {viewLevel === 'oauth-select' && (
        <>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={oauthItems}
              initialIndex={oauthIndex}
              onSelect={handleOAuthSelect}
              onHighlight={(value) => {
                setOauthIndex(oauthItems.findIndex((i) => i.value === value));
              }}
              itemGap={1}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={theme?.text?.secondary}>
              {t('Enter to select, ↑↓ to navigate, Esc to go back')}
            </Text>
          </Box>
        </>
      )}

      {viewLevel === 'provider-setup' && (
        <ProviderSetupSteps
          state={setupFlow.state}
          onProtocolSelect={(protocol) => {
            setupFlow.selectProtocol(protocol);
          }}
          onBaseUrlSelect={setupFlow.selectBaseUrl}
          onBaseUrlHighlight={(url) => {
            const p = setupFlow.state.provider;
            if (p && Array.isArray(p.baseUrl)) {
              const idx = p.baseUrl.findIndex((o) => o.url === url);
              setupFlow.setBaseUrlOptionIndex(idx >= 0 ? idx : 0);
            }
          }}
          onBaseUrlChange={setupFlow.changeBaseUrl}
          onBaseUrlSubmit={setupFlow.submitBaseUrl}
          onApiKeyChange={setupFlow.changeApiKey}
          onApiKeySubmit={setupFlow.submitApiKey}
          onModelIdsChange={setupFlow.changeModelIds}
          onModelIdsSubmit={setupFlow.submitModelIds}
        />
      )}

      {(authError || errorMessage) && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{authError || errorMessage}</Text>
        </Box>
      )}

      {viewLevel === 'main' && (
        <>
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
