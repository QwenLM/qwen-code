/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { t } from '../../i18n/index.js';
import {
  findProviderById,
  findProviderByCredentials,
  customProvider,
  ALIBABA_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
} from '../../auth/allProviders.js';
import {
  resolveMetadataKey,
  type ProviderConfig,
} from '../../auth/providerConfig.js';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewLevel =
  | 'main'
  | 'alibaba-select'
  | 'thirdparty-select'
  | 'oauth-select'
  | 'provider-setup';

type MainOption =
  | 'ALIBABA_MODELSTUDIO'
  | 'THIRD_PARTY_PROVIDERS'
  | 'OAUTH'
  | 'CUSTOM_PROVIDER';

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

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

const OAUTH_ITEMS = [
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
// Step label for provider-setup title bar
// ---------------------------------------------------------------------------

function getStepLabel(step: string | null, p: ProviderConfig): string {
  if (step === 'protocol') return t('Protocol');
  if (step === 'baseUrl') {
    if (p.uiLabels?.baseUrlStepTitle) return t(p.uiLabels.baseUrlStepTitle);
    return Array.isArray(p.baseUrl) ? t('Endpoint') : t('Base URL');
  }
  if (step === 'apiKey') return t('API Key');
  if (step === 'models') return t('Model IDs');
  if (step === 'advancedConfig') return t('Advanced Config');
  if (step === 'review') return t('Review');
  return '';
}

// ---------------------------------------------------------------------------
// View titles
// ---------------------------------------------------------------------------

const VIEW_TITLES: Record<string, string> = {
  main: t('Select Authentication Method'),
  'alibaba-select': t('Alibaba ModelStudio · Access Method'),
  'thirdparty-select': t('Third-party Providers · Provider'),
  'oauth-select': t('Select OAuth Provider'),
};

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
  const settings = useSettings();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  const [_viewStack, setViewStack] = useState<ViewLevel[]>([]);

  const [mainIndex, setMainIndex] = useState<number | null>(null);
  const [subMenuIndex, setSubMenuIndex] = useState<Record<string, number>>({});

  const setupFlow = useProviderSetupFlow(handleProviderSubmit);

  // -- Navigation -----------------------------------------------------------

  const clearErrors = () => {
    setErrorMessage(null);
    onAuthError(null);
  };

  const pushView = (view: ViewLevel) => {
    setViewStack((prev) => [...prev, viewLevel]);
    setViewLevel(view);
  };

  const goBack = () => {
    clearErrors();

    if (viewLevel === 'provider-setup') {
      if (setupFlow.goBack()) return;
    }

    setViewStack((prev) => {
      const next = [...prev];
      const parent = next.pop() ?? 'main';
      setViewLevel(parent);
      return next;
    });
  };

  // -- Sub-menu definitions (data-driven) -----------------------------------

  const alibabaItems = useMemo(() => ALIBABA_PROVIDERS.map(providerToItem), []);
  const thirdPartyItems = useMemo(
    () => THIRD_PARTY_PROVIDERS.map(providerToItem),
    [],
  );

  const existingEnv = (settings.merged.env ?? {}) as Record<string, string>;

  const handleProviderSelect = (providerId: string) => {
    clearErrors();
    const providerConfig = findProviderById(providerId);
    if (!providerConfig) return;
    setupFlow.start(providerConfig, undefined, existingEnv);
    pushView('provider-setup');
  };

  const handleOAuthSelect = (value: string) => {
    clearErrors();
    if (value === 'openrouter') {
      void handleOpenRouterSubmit();
      return;
    }
    setErrorMessage(
      t(
        'Qwen OAuth free tier was discontinued on 2026-04-15. Please select Coding Plan or API Key instead.',
      ),
    );
  };

  const subMenus: Record<
    string,
    { items: typeof OAUTH_ITEMS; onSelect: (v: string) => void }
  > = {
    'alibaba-select': {
      items: alibabaItems,
      onSelect: handleProviderSelect,
    },
    'thirdparty-select': {
      items: thirdPartyItems,
      onSelect: handleProviderSelect,
    },
    'oauth-select': { items: OAUTH_ITEMS, onSelect: handleOAuthSelect },
  };

  const activeSubMenu = subMenus[viewLevel];

  // -- Default main index from current auth state ---------------------------

  const contentGenConfig = config.getContentGeneratorConfig();
  const matchedProvider = findProviderByCredentials(
    contentGenConfig?.baseUrl,
    contentGenConfig?.apiKeyEnvKey,
  );
  const isCurrentlyCodingPlan = !!(
    matchedProvider && resolveMetadataKey(matchedProvider)
  );

  const defaultMainIndex = useMemo(() => {
    const currentAuth = pendingAuthType ?? config.getAuthType();
    if (!currentAuth) return 0;
    if (currentAuth === AuthType.QWEN_OAUTH) return 2;
    if (currentAuth === AuthType.USE_OPENAI && isCurrentlyCodingPlan) return 0;
    return 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAuthType, isCurrentlyCodingPlan]);

  // -- Handlers -------------------------------------------------------------

  const handleMainSelect = (value: MainOption) => {
    clearErrors();
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
        setupFlow.start(customProvider, undefined, existingEnv);
        pushView('provider-setup');
        break;
      default:
        break;
    }
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

  // -- View title -----------------------------------------------------------

  const viewTitle = useMemo(() => {
    if (viewLevel !== 'provider-setup') {
      return VIEW_TITLES[viewLevel] ?? VIEW_TITLES['main'];
    }
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
  }, [viewLevel, setupFlow.state]);

  // -- Render ---------------------------------------------------------------

  return (
    <Box
      borderStyle="single"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{viewTitle}</Text>

      {viewLevel === 'main' && (
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={MAIN_ITEMS}
            initialIndex={mainIndex != null ? mainIndex : defaultMainIndex}
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

      {activeSubMenu && (
        <>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={activeSubMenu.items}
              initialIndex={subMenuIndex[viewLevel] ?? 0}
              onSelect={activeSubMenu.onSelect}
              onHighlight={(value) => {
                setSubMenuIndex((prev) => ({
                  ...prev,
                  [viewLevel]: activeSubMenu.items.findIndex(
                    (i) => i.value === value,
                  ),
                }));
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
        <ProviderSetupSteps flow={setupFlow} />
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
