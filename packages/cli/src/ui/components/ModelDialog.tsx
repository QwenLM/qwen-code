/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useContext, useMemo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import {
  AuthType,
  ModelSlashCommandEvent,
  logModelSlashCommand,
} from '@qwen-code/qwen-code-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { useSettings } from '../hooks/useSettings.js';
import {
  getAvailableModelsForAuthType,
  MAINLINE_CODER,
  type AvailableModel,
} from '../models/availableModels.js';
import { ModelsService } from '../../services/ModelsService.js';
import { t } from '../../i18n/index.js';
import { SettingScope } from '../../config/settings.js';

interface ModelDialogProps {
  onClose: () => void;
}

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const settings = useSettings();
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get auth type from config, default to QWEN_OAUTH if not available
  const authType = config?.getAuthType() ?? AuthType.QWEN_OAUTH;

  // Fetch models on component mount or when auth type changes
  useEffect(() => {
    const fetchModels = async () => {
      setIsLoading(true);
      setError(null);

      try {
        if (authType === AuthType.USE_OPENAI) {
          // For OpenAI-compatible APIs, fetch models dynamically from the API
          const contentGeneratorConfig = config?.getContentGeneratorConfig();

          if (
            !contentGeneratorConfig?.baseUrl ||
            !contentGeneratorConfig?.apiKey
          ) {
            setError(
              t(
                'OpenAI-compatible API configuration incomplete. Please set OPENAI_BASE_URL and OPENAI_API_KEY.',
              ),
            );
            setIsLoading(false);
            return;
          }

          const modelsService = new ModelsService();
          const dynamicModels = await modelsService.fetchAvailableModels(
            contentGeneratorConfig.baseUrl,
            contentGeneratorConfig.apiKey,
          );

          setAvailableModels(dynamicModels);
        } else {
          // For other auth types, use static model lists
          const staticModels = getAvailableModelsForAuthType(authType);
          setAvailableModels(staticModels);
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : t('Failed to fetch models');
        setError(errorMessage);
        setAvailableModels([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchModels();
  }, [authType, config]);

  const MODEL_OPTIONS = useMemo(
    () =>
      availableModels.map((model) => ({
        value: model.id,
        title: model.label,
        description: model.description || '',
        key: model.id,
      })),
    [availableModels],
  );

  // Determine the Preferred Model (read once when the dialog opens).
  const preferredModel = config?.getModel() || MAINLINE_CODER;

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
      }
    },
    { isActive: true },
  );

  // Calculate the initial index based on the preferred model.
  const initialIndex = useMemo(
    () => MODEL_OPTIONS.findIndex((option) => option.value === preferredModel),
    [MODEL_OPTIONS, preferredModel],
  );

  // Handle selection internally (Autonomous Dialog).
  const handleSelect = useCallback(
    async (model: string) => {
      if (config) {
        config.setModel(model);
        const event = new ModelSlashCommandEvent(model);
        logModelSlashCommand(config, event);

        // Persist the selected model to settings so it's remembered across sessions
        if (settings) {
          try {
            // Save to user settings scope (not workspace, so it's global)
            await settings.setValue(SettingScope.User, 'model.name', model);
          } catch (err) {
            // Log error but don't block the dialog close
            console.error('Failed to save model selection to settings:', err);
          }
        }
      }
      onClose();
    },
    [config, settings, onClose],
  );

  // Show loading state
  if (isLoading) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text bold>{t('Select Model')}</Text>
        <Box marginTop={1}>
          <Text>{t('Loading available models...')}</Text>
        </Box>
      </Box>
    );
  }

  // Show error state
  if (error) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.status.error}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text bold color={theme.status.error}>
          {t('Error Loading Models')}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>{t('(Press Esc to close)')}</Text>
        </Box>
      </Box>
    );
  }

  // Show empty state
  if (availableModels.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text bold>{t('Select Model')}</Text>
        <Box marginTop={1}>
          <Text>{t('No models available')}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>{t('(Press Esc to close)')}</Text>
        </Box>
      </Box>
    );
  }

  // Show model selection
  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{t('Select Model')}</Text>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={MODEL_OPTIONS}
          onSelect={handleSelect}
          initialIndex={initialIndex >= 0 ? initialIndex : 0}
          showNumbers={true}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>{t('(Press Esc to close)')}</Text>
      </Box>
    </Box>
  );
}
