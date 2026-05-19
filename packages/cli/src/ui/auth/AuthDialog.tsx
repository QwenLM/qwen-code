/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo } from 'react';
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
  type ProviderConfig,
} from '@qwen-code/qwen-code-core';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewLevel =
  | 'main'
  | 'alibaba-select'
  | 'thirdparty-select'
  | 'provider-setup';

type MainOption =
  | 'ALIBABA_MODELSTUDIO'
  | 'THIRD_PARTY_PROVIDERS'
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
  main: t('Connect a Provider'),
  'alibaba-select': t('Alibaba ModelStudio · Access Method'),
  'thirdparty-select': t('Third-party Providers · Provider'),
};

// ---------------------------------------------------------------------------
// AuthDialog
// ---------------------------------------------------------------------------

export function AuthDialog(): React.JSX.Element {
  const {
    auth: { authError },
  } = useUIState();
  const {
    auth: { closeAuthDialog, handleProviderSubmit, onAuthError },
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

  const subMenus: Record<
    string,
    {
      items: Array<ReturnType<typeof providerToItem>>;
      onSelect: (v: string) => void;
    }
  > = {
    'alibaba-select': {
      items: alibabaItems,
      onSelect: handleProviderSelect,
    },
    'thirdparty-select': {
      items: thirdPartyItems,
      onSelect: handleProviderSelect,
    },
  };

  const activeSubMenu = subMenus[viewLevel];

  // -- Default main index from current auth state ---------------------------

  const contentGenConfig = config.getContentGeneratorConfig();
  const matchedProvider = findProviderByCredentials(
    contentGenConfig?.baseUrl,
    contentGenConfig?.apiKeyEnvKey,
  );

  // Land on the tab that matches the active provider's uiGroup so a DeepSeek
  // / MiniMax / OpenRouter user opens Third-party Providers, not Alibaba.
  // (resolveMetadataKey returns config.id for *any* provider with a static
  // models[], so it can't be used to detect "Alibaba" specifically.)
  const defaultMainIndex = useMemo(() => {
    if (matchedProvider?.uiGroup === 'third-party') return 1;
    if (matchedProvider?.uiGroup === 'custom') return 2;
    return 0;
  }, [matchedProvider]);

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
              'You must connect a provider to proceed. Press Ctrl+C again to exit.',
            ),
          );
          return;
        }
        closeAuthDialog();
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
            <Text color={theme.border.default}>{'─'.repeat(80)}</Text>
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
