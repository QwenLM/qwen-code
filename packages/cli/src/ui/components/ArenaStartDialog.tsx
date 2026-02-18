/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { AuthType } from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { MultiSelect } from './shared/MultiSelect.js';
import { t } from '../../i18n/index.js';

interface ArenaStartDialogProps {
  onClose: () => void;
  onConfirm: (selectedModels: string[]) => void;
}

const MODEL_PROVIDERS_DOCUMENTATION_URL =
  'https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/#modelproviders';

export function ArenaStartDialog({
  onClose,
  onConfirm,
}: ArenaStartDialogProps): React.JSX.Element {
  const config = useConfig();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modelItems = useMemo(() => {
    const allModels = config.getAllConfiguredModels();
    const selectableModels = allModels.filter((model) => !model.isRuntimeModel);

    return selectableModels.map((model) => {
      const token = `${model.authType}:${model.id}`;
      const isQwenOauth = model.authType === AuthType.QWEN_OAUTH;
      return {
        key: token,
        value: token,
        label: `[${model.authType}] ${model.label}`,
        disabled: isQwenOauth,
      };
    });
  }, [config]);
  const hasDisabledQwenOauth = modelItems.some((item) => item.disabled);
  const selectableModelCount = modelItems.filter(
    (item) => !item.disabled,
  ).length;
  const shouldShowMoreModelsHint = selectableModelCount < 3;

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
      }
    },
    { isActive: true },
  );

  const handleConfirm = (values: string[]) => {
    if (values.length < 2) {
      setErrorMessage(
        t('Please select at least 2 models to start an Arena session.'),
      );
      return;
    }

    setErrorMessage(null);
    onConfirm(values);
  };

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{t('Select Models')}</Text>

      {modelItems.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.status.warning}>
            {t('No models available. Please configure models first.')}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <MultiSelect
            items={modelItems}
            initialIndex={0}
            onConfirm={handleConfirm}
            showNumbers
            showScrollArrows
            maxItemsToShow={10}
          />
        </Box>
      )}

      {errorMessage && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{errorMessage}</Text>
        </Box>
      )}

      {hasDisabledQwenOauth && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t(
              'qwen-oauth models are disabled because they are not supported in Arena.',
            )}
          </Text>
        </Box>
      )}

      {shouldShowMoreModelsHint && (
        <>
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Configure more models with the modelProviders guide:')}
            </Text>
          </Box>
          <Box marginTop={0}>
            <Link url={MODEL_PROVIDERS_DOCUMENTATION_URL} fallback={false}>
              <Text color={theme.text.secondary} underline>
                {MODEL_PROVIDERS_DOCUMENTATION_URL}
              </Text>
            </Link>
          </Box>
        </>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('Space to toggle, Enter to confirm, Esc to cancel')}
        </Text>
      </Box>
    </Box>
  );
}
