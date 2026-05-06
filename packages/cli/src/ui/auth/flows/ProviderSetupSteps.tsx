/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { DescriptiveRadioButtonSelect } from '../../components/shared/DescriptiveRadioButtonSelect.js';
import { TextInput } from '../../components/shared/TextInput.js';
import {
  ApiKeyInput,
  type ApiKeyInputPlan,
} from '../../components/ApiKeyInput.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import type { ProviderSetupState } from './useProviderSetupFlow.js';
import { AuthType } from '@qwen-code/qwen-code-core';
import type {
  ProviderConfig,
  BaseUrlOption,
} from '../../../auth/providerConfig.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NAV_HINT_SELECT = () => (
  <Box marginTop={1}>
    <Text color={theme?.text?.secondary}>
      {t('Enter to select, ↑↓ to navigate, Esc to go back')}
    </Text>
  </Box>
);

const NAV_HINT_INPUT = () => (
  <Box marginTop={1}>
    <Text color={theme.text.secondary}>
      {t('Enter to submit, Esc to go back')}
    </Text>
  </Box>
);

function resolveApiKeyHelpUrl(
  config: ProviderConfig,
  baseUrl: string,
): string | undefined {
  if (!config.apiKeyHelpUrl) return undefined;
  return typeof config.apiKeyHelpUrl === 'function'
    ? config.apiKeyHelpUrl(baseUrl)
    : config.apiKeyHelpUrl;
}

function resolveDocumentationUrl(
  config: ProviderConfig,
  baseUrl: string,
): string | undefined {
  if (!config.documentationUrl) return undefined;
  return typeof config.documentationUrl === 'function'
    ? config.documentationUrl(baseUrl)
    : config.documentationUrl;
}

// ---------------------------------------------------------------------------
// Step: Select BaseURL from options
// ---------------------------------------------------------------------------

function BaseUrlSelectStep({
  config,
  state,
  onSelect,
  onHighlight,
}: {
  config: ProviderConfig;
  state: ProviderSetupState;
  onSelect: (url: string) => void;
  onHighlight: (url: string) => void;
}): React.JSX.Element {
  const options = config.baseUrl as BaseUrlOption[];
  const items = options.map((opt) => ({
    key: opt.id,
    title: t(opt.label),
    label: t(opt.label),
    description: <Text color={theme.text.secondary}>{opt.url}</Text>,
    value: opt.url,
  }));

  return (
    <>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={items}
          initialIndex={state.baseUrlOptionIndex}
          onSelect={onSelect}
          onHighlight={onHighlight}
          itemGap={1}
        />
      </Box>
      <NAV_HINT_SELECT />
    </>
  );
}

// ---------------------------------------------------------------------------
// Step: Free-form BaseURL input (custom provider)
// ---------------------------------------------------------------------------

function BaseUrlInputStep({
  state,
  onChange,
  onSubmit,
  documentationUrl,
}: {
  state: ProviderSetupState;
  onChange: (v: string) => void;
  onSubmit: () => void;
  documentationUrl?: string;
}): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('Enter the API endpoint for this protocol.')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <TextInput
          key="base-url-input"
          value={state.baseUrl}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="https://api.openai.com/v1"
        />
      </Box>
      {state.baseUrlError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{state.baseUrlError}</Text>
        </Box>
      )}
      {documentationUrl && (
        <Box marginTop={1}>
          <Link url={documentationUrl} fallback={false}>
            <Text color={theme.text.link}>{t('Documentation')}</Text>
          </Link>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: API Key input
// ---------------------------------------------------------------------------

function ApiKeyStep({
  config,
  state,
  onChange,
  onSubmit,
  onBack,
}: {
  config: ProviderConfig;
  state: ProviderSetupState;
  onChange: (v: string) => void;
  onSubmit: (key?: string) => void;
  onBack: () => void;
}): React.JSX.Element {
  const helpUrl = resolveApiKeyHelpUrl(config, state.baseUrl);

  if (helpUrl) {
    const plan: ApiKeyInputPlan = {
      apiKeyUrl: helpUrl,
      helpText: t('Get your API key'),
      placeholder: config.apiKeyPlaceholder ?? 'sk-...',
      validate: config.validateApiKey
        ? (key: string) => config.validateApiKey!(key, state.baseUrl)
        : undefined,
    };
    return (
      <Box marginTop={1}>
        <ApiKeyInput
          onSubmit={(key: string) => {
            onChange(key);
            onSubmit(key);
          }}
          onCancel={onBack}
          plan={plan}
        />
      </Box>
    );
  }

  const docUrl = resolveDocumentationUrl(config, state.baseUrl);

  return (
    <Box marginTop={1} flexDirection="column">
      {docUrl && (
        <Box marginTop={1}>
          <Link url={docUrl} fallback={false}>
            <Text color={theme.text.link}>
              {t('Documentation')}: {docUrl}
            </Text>
          </Link>
        </Box>
      )}
      <Box marginTop={1}>
        <TextInput
          key="api-key-input"
          value={state.apiKey}
          onChange={onChange}
          onSubmit={() => onSubmit(state.apiKey)}
          placeholder={config.apiKeyPlaceholder ?? 'sk-...'}
        />
      </Box>
      {state.apiKeyError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{state.apiKeyError}</Text>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: Model IDs input
// ---------------------------------------------------------------------------

function ModelIdsStep({
  config,
  state,
  onChange,
  onSubmit,
}: {
  config: ProviderConfig;
  state: ProviderSetupState;
  onChange: (v: string) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const defaultIds = config.models?.map((m) => m.id).join(', ') ?? '';

  return (
    <Box marginTop={1} flexDirection="column">
      {defaultIds && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Enter model IDs separated by commas. Examples: {{modelIds}}', {
              modelIds: defaultIds,
            })}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <TextInput
          key="model-ids-input"
          value={state.modelIds}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={defaultIds || 'model-id-1, model-id-2'}
        />
      </Box>
      {state.modelIdsError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{state.modelIdsError}</Text>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: Advanced config
// ---------------------------------------------------------------------------

function AdvancedConfigStep({
  state,
}: {
  state: ProviderSetupState;
}): React.JSX.Element {
  const checkmark = (v: boolean) => (v ? '◉' : '○');
  const cursor = (index: number) =>
    state.focusedConfigIndex === index ? '›' : ' ';

  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('Optional: configure advanced generation settings.')}
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text
          color={
            state.focusedConfigIndex === 0 ? theme.status.success : undefined
          }
        >
          {cursor(0)} {checkmark(state.thinkingEnabled)} {t('Enable thinking')}
        </Text>
      </Box>
      <Box marginTop={0} marginLeft={4}>
        <Text color={theme.text.secondary}>
          {t(
            'Allows the model to perform extended reasoning before responding.',
          )}
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text
          color={
            state.focusedConfigIndex === 1 ? theme.status.success : undefined
          }
        >
          {cursor(1)} {checkmark(state.modalityEnabled)} {t('Enable modality')}
        </Text>
      </Box>
      <Box marginTop={0} marginLeft={4}>
        <Text color={theme.text.secondary}>
          {t('Enables image, video, and audio input/output capabilities.')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t(
            '↑↓ to navigate, Space to toggle, Enter to continue, Esc to go back',
          )}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: Review JSON
// ---------------------------------------------------------------------------

function ReviewStep({
  state,
}: {
  state: ProviderSetupState;
}): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('The following JSON will be saved to settings.json:')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>{state.previewJson}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Enter to save, Esc to go back')}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main: render the current step
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Protocol label mapping
// ---------------------------------------------------------------------------

const PROTOCOL_ITEMS = [
  {
    key: AuthType.USE_OPENAI,
    title: 'OpenAI-compatible',
    label: 'OpenAI-compatible',
    description: 'Standard OpenAI API format (most common)',
    value: AuthType.USE_OPENAI,
  },
  {
    key: AuthType.USE_ANTHROPIC,
    title: 'Anthropic-compatible',
    label: 'Anthropic-compatible',
    description: 'Anthropic Messages API format',
    value: AuthType.USE_ANTHROPIC,
  },
  {
    key: AuthType.USE_GEMINI,
    title: 'Gemini-compatible',
    label: 'Gemini-compatible',
    description: 'Google Gemini API format',
    value: AuthType.USE_GEMINI,
  },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ProviderSetupStepsProps {
  state: ProviderSetupState;
  onProtocolSelect: (protocol: AuthType) => void;
  onProtocolHighlight?: (protocol: AuthType) => void;
  onBaseUrlSelect: (url: string) => void;
  onBaseUrlHighlight: (url: string) => void;
  onBaseUrlChange: (v: string) => void;
  onBaseUrlSubmit: () => void;
  onApiKeyChange: (v: string) => void;
  onApiKeySubmit: (key?: string) => void;
  onApiKeyBack: () => void;
  onModelIdsChange: (v: string) => void;
  onModelIdsSubmit: () => void;
}

export function ProviderSetupSteps({
  state,
  onProtocolSelect,
  onProtocolHighlight,
  onBaseUrlSelect,
  onBaseUrlHighlight,
  onBaseUrlChange,
  onBaseUrlSubmit,
  onApiKeyChange,
  onApiKeySubmit,
  onApiKeyBack,
  onModelIdsChange,
  onModelIdsSubmit,
}: ProviderSetupStepsProps): React.JSX.Element | null {
  const { provider, step } = state;
  if (!provider || !step) return null;

  switch (step) {
    case 'protocol': {
      const protocolOpts = provider.protocolOptions ?? [provider.protocol];
      const items = PROTOCOL_ITEMS.filter((p) =>
        protocolOpts.includes(p.value as AuthType),
      );
      return (
        <>
          <Box marginTop={1}>
            <DescriptiveRadioButtonSelect
              items={items}
              initialIndex={0}
              onSelect={onProtocolSelect}
              onHighlight={onProtocolHighlight}
              itemGap={1}
            />
          </Box>
          <NAV_HINT_SELECT />
        </>
      );
    }

    case 'baseUrl':
      if (Array.isArray(provider.baseUrl)) {
        return (
          <BaseUrlSelectStep
            config={provider}
            state={state}
            onSelect={onBaseUrlSelect}
            onHighlight={onBaseUrlHighlight}
          />
        );
      }
      return (
        <BaseUrlInputStep
          state={state}
          onChange={onBaseUrlChange}
          onSubmit={onBaseUrlSubmit}
          documentationUrl={resolveDocumentationUrl(provider, state.baseUrl)}
        />
      );

    case 'apiKey':
      return (
        <ApiKeyStep
          config={provider}
          state={state}
          onChange={onApiKeyChange}
          onSubmit={onApiKeySubmit}
          onBack={onApiKeyBack}
        />
      );

    case 'models':
      return (
        <ModelIdsStep
          config={provider}
          state={state}
          onChange={onModelIdsChange}
          onSubmit={onModelIdsSubmit}
        />
      );

    case 'advancedConfig':
      return <AdvancedConfigStep state={state} />;

    case 'review':
      return <ReviewStep state={state} />;
    default:
      return null;
  }
}
