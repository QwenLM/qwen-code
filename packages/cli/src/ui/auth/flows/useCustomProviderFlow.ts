/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { t } from '../../../i18n/index.js';
import { generateCustomApiKeyEnvKey } from '../../../auth/providers/custom/index.js';
import { normalizeCustomModelIds, maskApiKey } from '../useAuth.js';
import type { CustomProviderState } from './AuthFlowTypes.js';

const DEFAULT_CUSTOM_BASE_URLS: Partial<Record<AuthType, string>> = {
  [AuthType.USE_OPENAI]: 'https://api.openai.com/v1',
  [AuthType.USE_ANTHROPIC]: 'https://api.anthropic.com/v1',
  [AuthType.USE_GEMINI]: 'https://generativelanguage.googleapis.com',
};

export function useCustomProviderFlow() {
  const [protocolIndex, setProtocolIndex] = useState<number>(0);
  const [protocol, setProtocol] = useState<AuthType>(AuthType.USE_OPENAI);
  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [modelIds, setModelIds] = useState('');
  const [modelIdsError, setModelIdsError] = useState<string | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [modalityEnabled, setModalityEnabled] = useState(false);
  const [focusedConfigIndex, setFocusedConfigIndex] = useState(0);

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

  const reset = () => {
    setProtocolIndex(0);
    setProtocol(AuthType.USE_OPENAI);
    setBaseUrl('');
    setBaseUrlError(null);
    setApiKey('');
    setApiKeyError(null);
    setModelIds('');
    setModelIdsError(null);
    setThinkingEnabled(false);
    setModalityEnabled(false);
    setFocusedConfigIndex(0);
  };

  const selectProtocol = (selectedProtocol: AuthType) => {
    setProtocol(selectedProtocol);
    const defaultUrl = DEFAULT_CUSTOM_BASE_URLS[selectedProtocol] ?? '';
    setBaseUrl(defaultUrl);
    setBaseUrlError(null);
  };

  const changeBaseUrl = (value: string) => {
    setBaseUrl(value);
    if (baseUrlError) {
      setBaseUrlError(null);
    }
  };

  const submitBaseUrl = (): boolean => {
    const trimmedUrl = baseUrl.trim();
    if (!trimmedUrl) {
      setBaseUrlError(t('Base URL cannot be empty.'));
      return false;
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      setBaseUrlError(t('Base URL must start with http:// or https://.'));
      return false;
    }
    setBaseUrlError(null);
    setApiKey('');
    setApiKeyError(null);
    return true;
  };

  const changeApiKey = (value: string) => {
    setApiKey(value);
    if (apiKeyError) {
      setApiKeyError(null);
    }
  };

  const submitApiKey = (): boolean => {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setApiKeyError(t('API key cannot be empty.'));
      return false;
    }
    setApiKeyError(null);
    setModelIds('');
    setModelIdsError(null);
    return true;
  };

  const changeModelIds = (value: string) => {
    setModelIds(value);
    if (modelIdsError) {
      setModelIdsError(null);
    }
  };

  const submitModelIds = (): boolean => {
    const normalized = normalizeCustomModelIds(modelIds);
    if (normalized.length === 0) {
      setModelIdsError(t('Model IDs cannot be empty.'));
      return false;
    }
    setModelIdsError(null);
    return true;
  };

  const submit = (onSubmit: CustomSubmitHandler) => {
    onSubmit(
      protocol as
        | AuthType.USE_OPENAI
        | AuthType.USE_ANTHROPIC
        | AuthType.USE_GEMINI,
      baseUrl.trim(),
      apiKey.trim(),
      modelIds,
      getGenerationConfig(),
    );
  };

  const moveAdvancedFocusUp = () => {
    setFocusedConfigIndex((value) => (value <= 0 ? 1 : value - 1));
  };

  const moveAdvancedFocusDown = () => {
    setFocusedConfigIndex((value) => (value >= 1 ? 0 : value + 1));
  };

  const toggleFocusedAdvancedOption = () => {
    if (focusedConfigIndex === 0) {
      setThinkingEnabled((value) => !value);
    } else {
      setModalityEnabled((value) => !value);
    }
  };

  const getPreviewJson = () => {
    const generatedEnvKey = generateCustomApiKeyEnvKey(
      protocol,
      baseUrl.trim(),
    );
    const normalizedIds = normalizeCustomModelIds(modelIds);
    const maskedKey = maskApiKey(apiKey);
    const hasGenConfig = thinkingEnabled || modalityEnabled;

    let genConfig: Record<string, unknown> | undefined;
    if (hasGenConfig) {
      genConfig = {};
      if (modalityEnabled) {
        genConfig['modalities'] = {
          image: true,
          video: true,
          audio: true,
        };
      }
      if (thinkingEnabled) {
        genConfig['extra_body'] = {
          enable_thinking: true,
        };
      }
    }

    const modelEntries = normalizedIds.map((id) => {
      const entry: Record<string, unknown> = {
        id,
        name: id,
        baseUrl: baseUrl.trim(),
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
          [protocol]: modelEntries,
        },
        security: {
          auth: {
            selectedType: protocol,
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

  const getGenerationConfig = () =>
    thinkingEnabled || modalityEnabled
      ? {
          enableThinking: thinkingEnabled ? true : undefined,
          multimodal: modalityEnabled
            ? { image: true, video: true, audio: true }
            : undefined,
        }
      : undefined;

  const state: CustomProviderState = {
    protocolItems,
    protocolIndex,
    protocol,
    baseUrl,
    baseUrlError,
    apiKey,
    apiKeyError,
    modelIds,
    modelIdsError,
    focusedConfigIndex,
    thinkingEnabled,
    modalityEnabled,
    previewJson: getPreviewJson(),
  };

  return {
    state,
    reset,
    selectProtocol,
    setProtocolIndex,
    changeBaseUrl,
    submitBaseUrl,
    changeApiKey,
    submitApiKey,
    changeModelIds,
    submitModelIds,
    moveAdvancedFocusUp,
    moveAdvancedFocusDown,
    toggleFocusedAdvancedOption,
    submit,
    getGenerationConfig,
  };
}

type CustomSubmitHandler = (
  protocol: AuthType.USE_OPENAI | AuthType.USE_ANTHROPIC | AuthType.USE_GEMINI,
  baseUrl: string,
  apiKey: string,
  modelIdsInput: string,
  generationConfig?: {
    enableThinking?: boolean;
    multimodal?: {
      image?: boolean;
      video?: boolean;
      audio?: boolean;
    };
  },
) => void;
