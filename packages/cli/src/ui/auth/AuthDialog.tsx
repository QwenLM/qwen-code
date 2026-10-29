/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import wrapAnsi from 'wrap-ansi';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { t } from '../../i18n/index.js';
import { getRawModelProviders } from '../../config/loadedSettingsAdapter.js';
import {
  findProviderById,
  findProviderByCredentials,
  QWENCLOUD_PROVIDERS,
  ALIBABA_PROVIDERS,
  THIRD_PARTY_PROVIDERS,
} from '@qwen-code/qwen-code-core/providers/all-providers.js';
import { customProvider } from '@qwen-code/qwen-code-core/providers/presets/custom-provider.js';
import { findExistingProviderModels } from '@qwen-code/qwen-code-core/providers/provider-config.js';
import type { ProviderConfig } from '@qwen-code/qwen-code-core/providers/types.js';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewLevel =
  | 'main'
  | 'qwencloud-select'
  | 'alibaba-select'
  | 'thirdparty-select'
  | 'provider-setup';

type MainOption =
  | 'QWENCLOUD'
  | 'ALIBABA_MODELSTUDIO'
  | 'THIRD_PARTY_PROVIDERS'
  | 'CUSTOM_PROVIDER';

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

const MAIN_ITEMS = [
  {
    key: 'QWENCLOUD',
    title: t('QwenCloud'),
    label: t('QwenCloud'),
    description: t(
      'Official recommended setup: Token Plan or Standard API Key',
    ),
    value: 'QWENCLOUD' as MainOption,
  },
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
  if (step === 'wireApi') return t('API');
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

const VIEW_TITLES: Record<string, () => string> = {
  main: () => t('Connect a Provider'),
  'qwencloud-select': () => t('QwenCloud · Access Method'),
  'alibaba-select': () => t('Alibaba ModelStudio · Access Method'),
  'thirdparty-select': () => t('Third-party Providers · Provider'),
};

// ---------------------------------------------------------------------------
// AuthDialog
// ---------------------------------------------------------------------------

const TERMS_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/support/tos-privacy/';

function ProviderMenu<T>({
  title,
  items,
  initialIndex,
  onSelect,
  onHighlight,
  availableTerminalHeight,
  width,
  error,
  showTerms = false,
}: {
  title: string;
  items: Array<{ key: string; title: string; description: string; value: T }>;
  initialIndex: number;
  onSelect: (value: T) => void;
  onHighlight: (value: T) => void;
  availableTerminalHeight?: number;
  width: number;
  error: string | null;
  showTerms?: boolean;
}): React.JSX.Element {
  const height = Math.max(1, availableTerminalHeight ?? Infinity);
  const framed = height >= 5 && width >= 8;
  const contentWidth = Math.max(1, width - (framed ? 4 : 0));
  const itemWidth = Math.max(1, contentWidth - 2);
  const rows = (text: string, columns = contentWidth) =>
    wrapAnsi(text, columns, { hard: true, trim: false }).split('\n').length;
  const itemHeights = items.map(
    (item) => rows(item.title, itemWidth) + rows(item.description, itemWidth),
  );
  const hint = t('Enter to select, ↑↓ to navigate, Esc to go back');
  const termsLabel = `${t('Terms of Services and Privacy Notice')}:`;
  const footerRows = showTerms
    ? 3 + rows(termsLabel) + rows(TERMS_URL)
    : 1 + rows(hint);
  const fullHeight =
    6 +
    itemHeights.reduce((sum, value) => sum + value, 0) +
    Math.max(0, items.length - 1) +
    footerRows +
    (error ? 1 + rows(error) : 0);
  const compact = !framed || fullHeight > height;
  const showTitle = height >= (framed ? 4 : 2);
  const chromeRows = (framed ? 2 : 0) + (showTitle ? 1 : 0);
  // Keep a menu row, and show at least the start of errors that cannot fit.
  const wrappedErrorRows = error ? rows(error) : 0;
  const truncateError = height <= chromeRows + wrappedErrorRows;
  const errorRows = error ? (truncateError ? 1 : wrappedErrorRows) : 0;
  const showError = !!error && height > chromeRows + errorRows;
  const errorBudget = showError ? errorRows : 0;
  const compactFooterRows = showTerms ? rows(TERMS_URL) : 1;
  const showFooter =
    !compact || height >= chromeRows + errorBudget + compactFooterRows + 1;
  const gap = compact ? 0 : 1;
  const listHeight = compact
    ? height - chromeRows - errorBudget - (showFooter ? compactFooterRows : 0)
    : height - 6 - footerRows - (error ? 1 + rows(error) : 0);
  const maxItemHeight = Math.max(1, ...itemHeights);
  // Only truncate when even one complete option cannot fit in the viewport.
  const truncateItem = listHeight < maxItemHeight;
  const itemHeight = truncateItem ? Math.min(2, listHeight) : maxItemHeight;
  const maxItemsToShow = compact
    ? Math.max(1, Math.floor((listHeight + gap) / (itemHeight + gap)))
    : items.length;

  return (
    <Box
      borderStyle={framed ? 'single' : undefined}
      borderColor={theme.border.default}
      flexDirection="column"
      flexShrink={0}
      paddingX={framed ? 1 : 0}
      paddingY={compact ? 0 : 1}
      width="100%"
    >
      {showTitle && (
        <Text bold wrap="truncate">
          {title}
        </Text>
      )}
      <Box marginTop={compact ? 0 : 1} flexShrink={0}>
        <DescriptiveRadioButtonSelect
          items={items.map((item) => ({
            ...item,
            // Truncate the string, not a nested <Text>: the list wraps every
            // title in its own <Text>, and Ink applies the OUTER node's
            // textWrap, so a nested wrap="truncate" never takes effect.
            title: truncateItem
              ? wrapAnsi(item.title, itemWidth, { hard: true }).split('\n')[0]
              : item.title,
            description: truncateItem ? (
              listHeight >= 2 ? (
                <Text color={theme.text.secondary} wrap="truncate">
                  {item.description}
                </Text>
              ) : (
                ''
              )
            ) : (
              item.description
            ),
          }))}
          initialIndex={initialIndex}
          onSelect={onSelect}
          onHighlight={onHighlight}
          itemGap={gap}
          maxItemsToShow={maxItemsToShow}
        />
      </Box>
      {showError && (
        <Box marginTop={compact ? 0 : 1} flexShrink={0}>
          <Text
            color={theme.status.error}
            wrap={truncateError ? 'truncate' : 'wrap'}
          >
            {truncateError ? error?.split('\n')[0] : error}
          </Text>
        </Box>
      )}
      {showFooter &&
        (showTerms ? (
          <Box flexDirection="column" flexShrink={0}>
            {!compact && (
              <>
                <Box marginY={1} flexShrink={0}>
                  <Text color={theme.border.default}>
                    {'─'.repeat(contentWidth)}
                  </Text>
                </Box>
                <Text>{termsLabel}</Text>
              </>
            )}
            <Link url={TERMS_URL} fallback={false}>
              <Text color={theme.text.secondary} underline>
                {TERMS_URL}
              </Text>
            </Link>
          </Box>
        ) : (
          <Box marginTop={compact ? 0 : 1} flexShrink={0}>
            <Text
              color={theme.text.secondary}
              wrap={compact ? 'truncate' : 'wrap'}
            >
              {hint}
            </Text>
          </Box>
        ))}
    </Box>
  );
}

export function AuthDialog({
  availableTerminalHeight,
}: {
  availableTerminalHeight?: number;
}): React.JSX.Element {
  const {
    auth: { authError },
    mainAreaWidth,
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

  const setupFlow = useProviderSetupFlow(
    handleProviderSubmit,
    settings.merged.modelProviders,
    settings.merged.providerProtocol,
    {
      authType: settings.merged.security?.auth?.selectedType,
      id: settings.merged.model?.name,
      baseUrl: settings.merged.model?.baseUrl,
    },
    getRawModelProviders(settings),
  );

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

  const qwencloudItems = useMemo(
    () => QWENCLOUD_PROVIDERS.map(providerToItem),
    [],
  );
  const alibabaItems = useMemo(() => ALIBABA_PROVIDERS.map(providerToItem), []);
  const thirdPartyItems = useMemo(
    () => THIRD_PARTY_PROVIDERS.map(providerToItem),
    [],
  );

  const existingEnv = (settings.merged.env ?? {}) as Record<string, string>;

  // The saved route and ids the wizard reopens with. Both must come from the
  // same lookup: seeding the ids of a Responses install while the API step
  // defaults to Chat Completions would restamp them onto the other wire.
  const findSavedModels = (providerConfig: ProviderConfig) =>
    findExistingProviderModels(
      providerConfig,
      settings.merged.modelProviders,
      settings.merged.providerProtocol,
      {
        authType: settings.merged.security?.auth?.selectedType,
        id: settings.merged.model?.name,
        baseUrl: settings.merged.model?.baseUrl,
      },
    );

  const getExistingModelIds = (providerConfig: ProviderConfig): string[] => {
    const saved = findSavedModels(providerConfig);
    if (!saved) return [];
    return saved.models.map((m) => m.id);
  };

  const handleProviderSelect = (providerId: string) => {
    clearErrors();
    const providerConfig = findProviderById(providerId);
    if (!providerConfig) return;
    setupFlow.start(
      providerConfig,
      findSavedModels(providerConfig)?.protocol,
      existingEnv,
      getExistingModelIds(providerConfig),
    );
    pushView('provider-setup');
  };

  const subMenus: Record<
    string,
    {
      items: Array<ReturnType<typeof providerToItem>>;
      onSelect: (v: string) => void;
    }
  > = {
    'qwencloud-select': {
      items: qwencloudItems,
      onSelect: handleProviderSelect,
    },
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
    if (matchedProvider?.uiGroup === 'third-party') return 2;
    if (matchedProvider?.uiGroup === 'custom') return 3;
    if (matchedProvider?.uiGroup === 'alibaba') return 1;
    return 0;
  }, [matchedProvider]);

  // -- Handlers -------------------------------------------------------------

  const handleMainSelect = (value: MainOption) => {
    clearErrors();
    switch (value) {
      case 'QWENCLOUD':
        pushView('qwencloud-select');
        break;
      case 'ALIBABA_MODELSTUDIO':
        pushView('alibaba-select');
        break;
      case 'THIRD_PARTY_PROVIDERS':
        pushView('thirdparty-select');
        break;
      case 'CUSTOM_PROVIDER':
        setupFlow.start(
          customProvider,
          findSavedModels(customProvider)?.protocol,
          existingEnv,
          getExistingModelIds(customProvider),
        );
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
      return (VIEW_TITLES[viewLevel] ?? VIEW_TITLES['main'])();
    }
    const p = setupFlow.state.provider;
    if (!p) return t('Provider Setup');
    const flowTitle = t(p.uiLabels?.flowTitle ?? p.label);
    const { stepIndex, totalSteps, step } = setupFlow.state;
    return t('{{flowTitle}} · Step {{step}}/{{total}} · {{stepLabel}}', {
      flowTitle,
      step: String(stepIndex),
      total: String(totalSteps),
      stepLabel: getStepLabel(step, p),
    });
  }, [viewLevel, setupFlow.state]);

  // -- Render ---------------------------------------------------------------

  if (viewLevel === 'main') {
    return (
      <ProviderMenu
        title={viewTitle}
        items={MAIN_ITEMS}
        initialIndex={mainIndex ?? defaultMainIndex}
        onSelect={handleMainSelect}
        onHighlight={(value) => {
          setMainIndex(MAIN_ITEMS.findIndex((item) => item.value === value));
        }}
        availableTerminalHeight={availableTerminalHeight}
        width={mainAreaWidth ?? 80}
        error={authError || errorMessage}
        showTerms
      />
    );
  }

  if (activeSubMenu) {
    return (
      <ProviderMenu
        title={viewTitle}
        items={activeSubMenu.items}
        initialIndex={subMenuIndex[viewLevel] ?? 0}
        onSelect={activeSubMenu.onSelect}
        onHighlight={(value) => {
          setSubMenuIndex((prev) => ({
            ...prev,
            [viewLevel]: activeSubMenu.items.findIndex(
              (item) => item.value === value,
            ),
          }));
        }}
        availableTerminalHeight={availableTerminalHeight}
        width={mainAreaWidth ?? 80}
        error={authError || errorMessage}
      />
    );
  }

  return (
    <Box
      borderStyle="single"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{viewTitle}</Text>

      {viewLevel === 'provider-setup' && (
        <ProviderSetupSteps flow={setupFlow} />
      )}

      {(authError || errorMessage) && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{authError || errorMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
