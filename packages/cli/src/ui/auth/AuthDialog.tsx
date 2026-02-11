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
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import { ApiKeyInput } from '../components/ApiKeyInput.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { t } from '../../i18n/index.js';

const MODEL_PROVIDERS_DOCUMENTATION_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/#modelproviders';

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

// Sub-mode types for API-KEY authentication
type ApiKeySubMode = 'coding-plan' | 'custom';

// View level for navigation
type ViewLevel = 'main' | 'api-key-sub' | 'api-key-input' | 'custom-info';

export function AuthDialog(): React.JSX.Element {
  const { pendingAuthType, authError } = useUIState();
  const { handleAuthSelect: onAuthSelect, handleCodingPlanSubmit } =
    useUIActions();
  const config = useConfig();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  const [apiKeySubModeIndex, setApiKeySubModeIndex] = useState<number>(0);

  // Main authentication entries
  const mainItems = [
    {
      key: AuthType.QWEN_OAUTH,
      label: t('Qwen OAuth'),
      value: AuthType.QWEN_OAUTH,
    },
    {
      key: 'API-KEY',
      label: t('API-KEY'),
      value: 'API-KEY' as const,
    },
  ];

  // API-KEY sub-mode entries
  const apiKeySubItems = [
    {
      key: 'coding-plan',
      label: t('Coding Plan'),
      value: 'coding-plan' as ApiKeySubMode,
    },
    {
      key: 'custom',
      label: t('Custom'),
      value: 'custom' as ApiKeySubMode,
    },
  ];

  const initialAuthIndex = Math.max(
    0,
    mainItems.findIndex((item) => {
      // Priority 1: pendingAuthType
      if (pendingAuthType) {
        return item.value === pendingAuthType;
      }

      // Priority 2: config.getAuthType() - the source of truth
      const currentAuthType = config.getAuthType();
      if (currentAuthType) {
        return item.value === currentAuthType;
      }

      // Priority 3: QWEN_DEFAULT_AUTH_TYPE env var
      const defaultAuthType = parseDefaultAuthType(
        process.env['QWEN_DEFAULT_AUTH_TYPE'],
      );
      if (defaultAuthType) {
        return item.value === defaultAuthType;
      }

      // Priority 4: default to QWEN_OAUTH
      return item.value === AuthType.QWEN_OAUTH;
    }),
  );

  const hasApiKey = Boolean(config.getContentGeneratorConfig()?.apiKey);
  const currentSelectedAuthType =
    selectedIndex !== null
      ? mainItems[selectedIndex]?.value
      : mainItems[initialAuthIndex]?.value;

  const handleMainSelect = async (
    value: (typeof mainItems)[number]['value'],
  ) => {
    setErrorMessage(null);

    if (value === 'API-KEY') {
      // Navigate to API-KEY sub-mode selection
      setViewLevel('api-key-sub');
      return;
    }

    // For Qwen OAuth, proceed directly
    await onAuthSelect(value);
  };

  const handleApiKeySubSelect = async (subMode: ApiKeySubMode) => {
    setErrorMessage(null);

    if (subMode === 'coding-plan') {
      setViewLevel('api-key-input');
    } else {
      setViewLevel('custom-info');
    }
  };

  const handleApiKeyInputSubmit = async (apiKey: string) => {
    setErrorMessage(null);

    if (!apiKey.trim()) {
      setErrorMessage(t('API key cannot be empty.'));
      return;
    }

    // Submit to parent for processing
    await handleCodingPlanSubmit(apiKey);
  };

  const handleGoBack = () => {
    setErrorMessage(null);

    if (viewLevel === 'api-key-sub') {
      setViewLevel('main');
    } else if (viewLevel === 'api-key-input' || viewLevel === 'custom-info') {
      setViewLevel('api-key-sub');
    }
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        // Handle Escape based on current view level
        if (viewLevel === 'api-key-sub') {
          handleGoBack();
          return;
        }

        if (viewLevel === 'api-key-input' || viewLevel === 'custom-info') {
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

  // Render main auth selection
  const renderMainView = () => (
    <>
      <Box marginTop={1}>
        <Text>{t('How would you like to authenticate for this project?')}</Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={mainItems}
          initialIndex={initialAuthIndex}
          onSelect={handleMainSelect}
          onHighlight={(value) => {
            const index = mainItems.findIndex((item) => item.value === value);
            setSelectedIndex(index);
          }}
        />
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text color={Colors.Gray}>
          {currentSelectedAuthType === AuthType.QWEN_OAUTH
            ? t('Login with QwenChat account to use daily free quota.')
            : t('Use coding plan credentials or your own api-keys/providers.')}
        </Text>
      </Box>
    </>
  );

  // Render API-KEY sub-mode selection
  const renderApiKeySubView = () => (
    <>
      <Box marginTop={1}>
        <Text>{t('Select API-KEY configuration mode:')}</Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={apiKeySubItems}
          initialIndex={apiKeySubModeIndex}
          onSelect={handleApiKeySubSelect}
          onHighlight={(value) => {
            const index = apiKeySubItems.findIndex(
              (item) => item.value === value,
            );
            setApiKeySubModeIndex(index);
          }}
        />
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text color={Colors.Gray}>
          {apiKeySubItems[apiKeySubModeIndex]?.value === 'coding-plan'
            ? t("Paste your api key of Bailian Coding Plan and you're all set!")
            : t(
                'More instructions about configuring `modelProviders` manually.',
              )}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme?.text?.secondary}>
          {t('(Press Escape to go back)')}
        </Text>
      </Box>
    </>
  );

  // Render API key input for coding-plan mode
  const renderApiKeyInputView = () => (
    <Box marginTop={1}>
      <ApiKeyInput onSubmit={handleApiKeyInputSubmit} onCancel={handleGoBack} />
    </Box>
  );

  // Render custom mode info
  const renderCustomInfoView = () => (
    <>
      <Box marginTop={1}>
        <Text bold>{t('Custom API-KEY Configuration')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          {t('For advanced users who want to configure models manually.')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>{t('Please configure your models in settings.json:')}</Text>
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text color={Colors.AccentYellow}>
          1. {t('Set API key via environment variable (e.g., OPENAI_API_KEY)')}
        </Text>
      </Box>
      <Box marginTop={0} paddingLeft={2}>
        <Text color={Colors.AccentYellow}>
          2.{' '}
          {t(
            "Add model configuration to modelProviders['openai'] (or other auth types)",
          )}
        </Text>
      </Box>
      <Box marginTop={0} paddingLeft={2}>
        <Text color={Colors.AccentYellow}>
          3.{' '}
          {t(
            'Each provider needs: id, envKey (required), plus optional baseUrl, generationConfig',
          )}
        </Text>
      </Box>
      <Box marginTop={0} paddingLeft={2}>
        <Text color={Colors.AccentYellow}>
          4.{' '}
          {t(
            'Use /model command to select your preferred model from the configured list',
          )}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme?.text?.secondary}>
          {t(
            'Supported auth types: openai, anthropic, gemini, vertex-ai, etc.',
          )}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme?.text?.secondary} underline>
          {t('More instructions please check:')}
        </Text>
      </Box>
      <Box marginTop={0}>
        <Link url={MODEL_PROVIDERS_DOCUMENTATION_URL} fallback={false}>
          <Text color={Colors.AccentGreen} underline>
            {MODEL_PROVIDERS_DOCUMENTATION_URL}
          </Text>
        </Link>
      </Box>
      <Box marginTop={1}>
        <Text color={theme?.text?.secondary}>
          {t('(Press Escape to go back)')}
        </Text>
      </Box>
    </>
  );

  const getViewTitle = () => {
    switch (viewLevel) {
      case 'main':
        return t('Get started');
      case 'api-key-sub':
        return t('API-KEY Configuration');
      case 'api-key-input':
        return t('Coding Plan Setup');
      case 'custom-info':
        return t('Custom Configuration');
      default:
        return t('Get started');
    }
  };

  return (
    <Box
      borderStyle="round"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{getViewTitle()}</Text>

      {viewLevel === 'main' && renderMainView()}
      {viewLevel === 'api-key-sub' && renderApiKeySubView()}
      {viewLevel === 'api-key-input' && renderApiKeyInputView()}
      {viewLevel === 'custom-info' && renderCustomInfoView()}

      {(authError || errorMessage) && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{authError || errorMessage}</Text>
        </Box>
      )}

      {viewLevel === 'main' && (
        <>
          <Box marginTop={1}>
            <Text color={Colors.AccentPurple}>
              {t('(Use Enter to Set Auth)')}
            </Text>
          </Box>
          {hasApiKey && currentSelectedAuthType === AuthType.QWEN_OAUTH && (
            <Box marginTop={1}>
              <Text color={theme?.text?.secondary}>
                {t(
                  'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.',
                )}
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text>
              {t('Terms of Services and Privacy Notice for Qwen Code')}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={Colors.AccentBlue}>
              {'https://github.com/QwenLM/Qwen3-Coder/blob/main/README.md'}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
