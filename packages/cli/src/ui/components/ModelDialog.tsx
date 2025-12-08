/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useContext, useMemo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { AuthType } from '@qwen-code/qwen-code-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import {
  type AvailableModel,
  getAvailableModelsForAuthType,
  MAINLINE_CODER,
} from '../models/availableModels.js';
import { t } from '../../i18n/index.js';

interface ModelDialogProps {
  onClose: () => void;
}

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);

  // Get auth type from config, default to QWEN_OAUTH if not available
  const authType = config?.getAuthType() ?? AuthType.QWEN_OAUTH;

  // Get available models based on auth type
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    getAvailableModelsForAuthType(authType)
      .then((models) => {
        if (mounted) {
          setAvailableModels(models);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch models:', err);
        if (mounted) {
          setAvailableModels([]);
          setIsLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [authType]);

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
    (model: string) => {
      if (config) {
        config.setModel(model);
      }
      onClose();
    },
    [config, onClose],
  );

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
        {isLoading && (
          <Box marginBottom={1}>
            <Text> {t('Loading available models...')}</Text>
          </Box>
        )}
        {!isLoading && MODEL_OPTIONS.length === 0 && (
          <Text color="yellow">
            {t('No models found. Ensure Ollama is running.')}
          </Text>
        )}
        {!isLoading && MODEL_OPTIONS.length > 0 && (
          <DescriptiveRadioButtonSelect
            items={MODEL_OPTIONS}
            onSelect={handleSelect}
            initialIndex={initialIndex}
            showNumbers={true}
          />
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>{t('(Press Esc to close)')}</Text>
      </Box>
    </Box>
  );
}
