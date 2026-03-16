/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState, useEffect } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { Box, Text } from 'ink';
import { TextInput } from '../components/shared/TextInput.js';
import Link from 'ink-link';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from '../components/shared/DescriptiveRadioButtonSelect.js';
import { ApiKeyInput } from '../components/ApiKeyInput.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { t } from '../../i18n/index.js';
import {
  CodingPlanRegion,
  isCodingPlanConfig,
} from '../../constants/codingPlan.js';

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

// Main menu option type
type MainOption = AuthType | 'CODING_PLAN' | 'API_KEY' | 'LOGOUT';

// View level for navigation
type ViewLevel =
  | 'main'
  | 'region-select'
  | 'api-key-input'
  | 'custom-info'
  | 'lm-studio-input'
  | 'ollama-input'
  | 'ollama-models';

export function AuthDialog(): React.JSX.Element {
  const { pendingAuthType, authError } = useUIState();
  const {
    handleAuthSelect: onAuthSelect,
    handleCodingPlanSubmit,
    onAuthError,
  } = useUIActions();
  const config = useConfig();
  const savedConfig = config.getContentGeneratorConfig();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewLevel, setViewLevel] = useState<ViewLevel>('main');
  const [regionIndex, setRegionIndex] = useState<number>(0);
  const [region, setRegion] = useState<CodingPlanRegion>(
    CodingPlanRegion.CHINA,
  );
  const [lmStudioBaseUrl, setLmStudioBaseUrl] = useState<string>(
    savedConfig?.baseUrl?.includes('1234')
      ? savedConfig.baseUrl
      : 'http://localhost:1234/v1',
  );
  const [lmStudioApiKey, setLmStudioApiKey] = useState<string>(
    savedConfig?.apiKey || '',
  );
  const [lmStudioStep, setLmStudioStep] = useState<'baseUrl' | 'apiKey'>(
    'baseUrl',
  );
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string>(
    savedConfig?.baseUrl?.includes('11434')
      ? savedConfig.baseUrl
      : 'http://localhost:11434/v1',
  );
  const [ollamaApiKey, setOllamaApiKey] = useState<string>(
    savedConfig?.apiKey || '',
  );
  const [ollamaStep, setOllamaStep] = useState<'baseUrl' | 'apiKey' | 'models'>(
    'baseUrl',
  );
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [loadingOllamaModels, setLoadingOllamaModels] =
    useState<boolean>(false);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>(
    savedConfig?.model || '',
  );

  useEffect(() => {
    const currentAuthType = config.getAuthType();
    const contentGenConfig = config.getContentGeneratorConfig();

    if (currentAuthType === AuthType.USE_LM_STUDIO && contentGenConfig) {
      if (contentGenConfig.baseUrl) {
        setLmStudioBaseUrl(contentGenConfig.baseUrl);
      }
      if (contentGenConfig.apiKey) {
        setLmStudioApiKey(contentGenConfig.apiKey);
      }
    }

    if (currentAuthType === AuthType.USE_OLLAMA && contentGenConfig) {
      if (contentGenConfig.baseUrl) {
        setOllamaBaseUrl(contentGenConfig.baseUrl);
      }
      if (contentGenConfig.apiKey) {
        setOllamaApiKey(contentGenConfig.apiKey);
      }
      if (contentGenConfig.model) {
        setSelectedOllamaModel(contentGenConfig.model);
      }
    }
  }, [config]);

  // Main authentication entries (flat three-option layout)
  const mainItems: Array<{
    key: string;
    title: string;
    label: string;
    description: string | React.ReactNode;
    value: MainOption;
  }> = [
    {
      key: AuthType.QWEN_OAUTH,
      title: t('Qwen OAuth'),
      label: t('Qwen OAuth'),
      description: t(
        'Free \u00B7 Up to 1,000 requests/day \u00B7 Qwen latest models',
      ),
      value: AuthType.QWEN_OAUTH,
    },
    {
      key: 'CODING_PLAN',
      title: t('Alibaba Cloud Coding Plan'),
      label: t('Alibaba Cloud Coding Plan'),
      description: t(
        'Paid \u00B7 Up to 6,000 requests/5 hrs \u00B7 All Alibaba Cloud Coding Plan Models',
      ),
      value: 'CODING_PLAN',
    },
    {
      key: 'API_KEY',
      title: t('API Key'),
      label: t('API Key'),
      description: t('Bring your own API key'),
      value: 'API_KEY',
    },
    {
      key: AuthType.USE_LM_STUDIO,
      title: t('LM Studio'),
      label: t('LM Studio'),
      description: t(
        'Local \u00B7 No API key required \u00B7 Run models on your machine',
      ),
      value: AuthType.USE_LM_STUDIO,
    },
    {
      key: AuthType.USE_OLLAMA,
      title: t('Ollama'),
      label: t('Ollama'),
      description: t(
        'Local \u00B7 No API key required \u00B7 Run models on your machine',
      ),
      value: AuthType.USE_OLLAMA,
    },
    {
      key: 'LOGOUT',
      title: t('Logout'),
      label: t('Logout'),
      description: t('Clear current login and credentials'),
      value: 'LOGOUT',
    },
  ];

  // Region selection entries (shown after selecting Alibaba Cloud Coding Plan)
  const regionItems = [
    {
      key: 'china',
      title: '阿里云百炼 (aliyun.com)',
      label: '阿里云百炼 (aliyun.com)',
      description: (
        <Link
          url="https://help.aliyun.com/zh/model-studio/coding-plan"
          fallback={false}
        >
          <Text color={theme.text.secondary}>
            https://help.aliyun.com/zh/model-studio/coding-plan
          </Text>
        </Link>
      ),
      value: CodingPlanRegion.CHINA,
    },
    {
      key: 'global',
      title: 'Alibaba Cloud (alibabacloud.com)',
      label: 'Alibaba Cloud (alibabacloud.com)',
      description: (
        <Link
          url="https://www.alibabacloud.com/help/en/model-studio/coding-plan"
          fallback={false}
        >
          <Text color={theme.text.secondary}>
            https://www.alibabacloud.com/help/en/model-studio/coding-plan
          </Text>
        </Link>
      ),
      value: CodingPlanRegion.GLOBAL,
    },
  ];

  // Map an AuthType to the corresponding main menu option.
  // QWEN_OAUTH maps directly; any other auth type maps to CODING_PLAN only
  // if the current config actually uses a Coding Plan baseUrl+envKey,
  // otherwise it maps to API_KEY.
  const contentGenConfig = config.getContentGeneratorConfig();
  const isCurrentlyCodingPlan =
    isCodingPlanConfig(
      contentGenConfig?.baseUrl,
      contentGenConfig?.apiKeyEnvKey,
    ) !== false;

  const authTypeToMainOption = (authType: AuthType): MainOption => {
    if (authType === AuthType.QWEN_OAUTH) return AuthType.QWEN_OAUTH;
    if (authType === AuthType.USE_LM_STUDIO) return AuthType.USE_LM_STUDIO;
    if (authType === AuthType.USE_OLLAMA) return AuthType.USE_OLLAMA;
    if (authType === AuthType.USE_OPENAI && isCurrentlyCodingPlan)
      return 'CODING_PLAN';
    return 'API_KEY';
  };

  const initialAuthIndex = Math.max(
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

      // Priority 4: default to QWEN_OAUTH
      return item.value === AuthType.QWEN_OAUTH;
    }),
  );

  const handleMainSelect = async (value: MainOption) => {
    setErrorMessage(null);
    onAuthError(null);

    if (value === 'CODING_PLAN') {
      // Navigate to region selection
      setViewLevel('region-select');
      return;
    }

    if (value === 'API_KEY') {
      // Navigate directly to custom API key info
      setViewLevel('custom-info');
      return;
    }

    if (value === AuthType.USE_LM_STUDIO) {
      setViewLevel('lm-studio-input');
      return;
    }

    if (value === AuthType.USE_OLLAMA) {
      setViewLevel('ollama-input');
      return;
    }

    if (value === 'LOGOUT') {
      await onAuthSelect(undefined);
      return;
    }

    // For Qwen OAuth, proceed directly
    await onAuthSelect(value);
  };

  const handleRegionSelect = async (selectedRegion: CodingPlanRegion) => {
    setErrorMessage(null);
    onAuthError(null);
    setRegion(selectedRegion);
    setViewLevel('api-key-input');
  };

  const handleApiKeyInputSubmit = async (apiKey: string) => {
    setErrorMessage(null);

    if (!apiKey.trim()) {
      setErrorMessage(t('API key cannot be empty.'));
      return;
    }

    // Submit to parent for processing with region info
    await handleCodingPlanSubmit(apiKey, region);
  };

  const handleLmStudioSubmit = async () => {
    setErrorMessage(null);

    if (!lmStudioApiKey.trim()) {
      setErrorMessage(t('API key cannot be empty.'));
      return;
    }

    await onAuthSelect(AuthType.USE_LM_STUDIO, {
      apiKey: lmStudioApiKey,
      baseUrl: lmStudioBaseUrl,
    });
  };

  const handleOllamaSubmit = async () => {
    setErrorMessage(null);
    setLoadingOllamaModels(true);

    try {
      const url = `${ollamaBaseUrl.replace('/v1', '')}/api/tags`;
      const response = await fetch(url, {
        method: 'GET',
        headers: ollamaApiKey
          ? { Authorization: `Bearer ${ollamaApiKey}` }
          : {},
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }

      const data = await response.json();
      const models = (data.models || []).map((m: { name: string }) => m.name);

      if (models.length === 0) {
        setErrorMessage(t('No models found on Ollama server'));
        return;
      }

      setOllamaModels(models);
      setSelectedOllamaModel(models[0]);
      setOllamaStep('models');
    } catch (err) {
      setErrorMessage(
        t('Failed to connect to Ollama: {{error}}', {
          error: err instanceof Error ? err.message : 'Unknown error',
        }),
      );
    } finally {
      setLoadingOllamaModels(false);
    }
  };

  const handleOllamaModelSelect = async (model: string) => {
    await onAuthSelect(AuthType.USE_OLLAMA, {
      apiKey: ollamaApiKey,
      baseUrl: ollamaBaseUrl,
      model: model,
    });
  };

  const handleGoBack = () => {
    setErrorMessage(null);
    onAuthError(null);

    if (
      viewLevel === 'region-select' ||
      viewLevel === 'custom-info' ||
      viewLevel === 'lm-studio-input' ||
      viewLevel === 'ollama-input' ||
      viewLevel === 'ollama-models'
    ) {
      setViewLevel('main');
      setLmStudioStep('baseUrl');
      setOllamaStep('baseUrl');
    } else if (viewLevel === 'api-key-input') {
      setViewLevel('region-select');
    }
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        // Handle Escape based on current view level
        if (viewLevel === 'region-select') {
          handleGoBack();
          return;
        }

        if (viewLevel === 'api-key-input' || viewLevel === 'custom-info') {
          handleGoBack();
          return;
        }

        if (viewLevel === 'lm-studio-input') {
          if (lmStudioStep === 'apiKey') {
            setLmStudioStep('baseUrl');
          } else {
            handleGoBack();
          }
          return;
        }

        if (viewLevel === 'ollama-input') {
          if (ollamaStep === 'models') {
            setOllamaStep('apiKey');
          } else if (ollamaStep === 'apiKey') {
            setOllamaStep('baseUrl');
          } else {
            handleGoBack();
          }
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
        <DescriptiveRadioButtonSelect
          items={mainItems}
          initialIndex={initialAuthIndex}
          onSelect={handleMainSelect}
          itemGap={1}
        />
      </Box>
    </>
  );

  // Render region selection for Alibaba Cloud Coding Plan
  const renderRegionSelectView = () => (
    <>
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('Choose based on where your account is registered')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={regionItems}
          initialIndex={regionIndex}
          onSelect={handleRegionSelect}
          onHighlight={(value) => {
            const index = regionItems.findIndex((item) => item.value === value);
            setRegionIndex(index);
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
  );

  // Render API key input for coding-plan mode
  const renderApiKeyInputView = () => (
    <Box marginTop={1}>
      <ApiKeyInput
        onSubmit={handleApiKeyInputSubmit}
        onCancel={handleGoBack}
        region={region}
      />
    </Box>
  );

  // Render custom mode info
  const renderCustomInfoView = () => (
    <>
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('You can configure your API key and models in settings.json')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>{t('Refer to the documentation for setup instructions')}</Text>
      </Box>
      <Box marginTop={0}>
        <Link url={MODEL_PROVIDERS_DOCUMENTATION_URL} fallback={false}>
          <Text color={theme.text.link}>
            {MODEL_PROVIDERS_DOCUMENTATION_URL}
          </Text>
        </Link>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>{t('Esc to go back')}</Text>
      </Box>
    </>
  );

  // Render LM Studio input - two-step flow
  const renderLmStudioInputView = () => (
    <>
      <Box marginTop={1}>
        <Text bold color={theme.text.primary}>
          {t('LM Studio')}
        </Text>
      </Box>
      <Box marginTop={0}>
        <Text color={theme.text.secondary}>
          {t('Connect to local models via LM Studio')}
        </Text>
      </Box>

      {lmStudioStep === 'baseUrl' && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('Server URL:')}</Text>
          </Box>
          <Box marginTop={0}>
            <TextInput
              value={lmStudioBaseUrl}
              onChange={setLmStudioBaseUrl}
              onSubmit={() => setLmStudioStep('apiKey')}
              placeholder={t('http://localhost:1234/v1')}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('↑↓ to navigate, Enter to continue, Esc to go back')}
            </Text>
          </Box>
        </>
      )}

      {lmStudioStep === 'apiKey' && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Server')}:{' '}
              <Text color={theme.text.primary}>{lmStudioBaseUrl}</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('API Key:')}</Text>
          </Box>
          <Box marginTop={0}>
            <TextInput
              value={lmStudioApiKey}
              onChange={setLmStudioApiKey}
              onSubmit={handleLmStudioSubmit}
              placeholder={t('Enter your API key (optional for local models)')}
            />
          </Box>
          {errorMessage && (
            <Box marginTop={1}>
              <Text color={theme.status.error}>{errorMessage}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('↑↓ to navigate, Enter to submit, Esc to go back')}
            </Text>
          </Box>
        </>
      )}
    </>
  );

  const renderOllamaInputView = () => (
    <>
      <Box marginTop={1}>
        <Text bold color={theme.text.primary}>
          {t('Ollama')}
        </Text>
      </Box>
      <Box marginTop={0}>
        <Text color={theme.text.secondary}>
          {t('Connect to local models via Ollama')}
        </Text>
      </Box>

      {ollamaStep === 'baseUrl' && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('Server URL:')}</Text>
          </Box>
          <Box marginTop={0}>
            <TextInput
              value={ollamaBaseUrl}
              onChange={setOllamaBaseUrl}
              onSubmit={() => setOllamaStep('apiKey')}
              placeholder={t('http://localhost:11434/v1')}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('↑↓ to navigate, Enter to continue, Esc to go back')}
            </Text>
          </Box>
        </>
      )}

      {ollamaStep === 'apiKey' && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Server')}:{' '}
              <Text color={theme.text.primary}>{ollamaBaseUrl}</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('API Key:')}</Text>
          </Box>
          <Box marginTop={0}>
            <TextInput
              value={ollamaApiKey}
              onChange={setOllamaApiKey}
              onSubmit={handleOllamaSubmit}
              placeholder={t('Enter your API key (optional for local models)')}
            />
          </Box>
          {errorMessage && (
            <Box marginTop={1}>
              <Text color={theme.status.error}>{errorMessage}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('↑↓ to navigate, Enter to fetch models, Esc to go back')}
            </Text>
          </Box>
        </>
      )}

      {ollamaStep === 'models' && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Server')}:{' '}
              <Text color={theme.text.primary}>{ollamaBaseUrl}</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>{t('Select Model:')}</Text>
          </Box>
          <Box marginTop={0}>
            {loadingOllamaModels ? (
              <Text color={theme.text.secondary}>{t('Loading models...')}</Text>
            ) : (
              <DescriptiveRadioButtonSelect
                items={ollamaModels.map((m) => ({
                  key: m,
                  title: m,
                  description: '',
                  value: m,
                }))}
                initialIndex={ollamaModels.indexOf(selectedOllamaModel)}
                onSelect={(val) => {
                  setSelectedOllamaModel(val);
                  handleOllamaModelSelect(val);
                }}
                maxItemsToShow={5}
              />
            )}
          </Box>
          {errorMessage && (
            <Box marginTop={1}>
              <Text color={theme.status.error}>{errorMessage}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('↑↓ to navigate, Enter to select, Esc to go back')}
            </Text>
          </Box>
        </>
      )}
    </>
  );

  const getViewTitle = () => {
    switch (viewLevel) {
      case 'main':
        return t('Select Authentication Method');
      case 'region-select':
        return t('Select Region for Coding Plan');
      case 'api-key-input':
        return t('Enter Coding Plan API Key');
      case 'custom-info':
        return t('Custom Configuration');
      case 'lm-studio-input':
        return t('LM Studio');
      case 'ollama-input':
        return t('Ollama');
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
      {viewLevel === 'region-select' && renderRegionSelectView()}
      {viewLevel === 'api-key-input' && renderApiKeyInputView()}
      {viewLevel === 'custom-info' && renderCustomInfoView()}
      {viewLevel === 'lm-studio-input' && renderLmStudioInputView()}
      {viewLevel === 'ollama-input' && renderOllamaInputView()}

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
