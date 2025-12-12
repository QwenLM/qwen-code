/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { Box, Text } from 'ink';
import { SettingScope } from '../../config/settings.js';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { t } from '../../i18n/index.js';

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

export function AuthDialog(): React.JSX.Element {
  const { pendingAuthType, authError } = useUIState();
  const { handleAuthSelect: onAuthSelect } = useUIActions();
  const settings = useSettings();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const items = [
    {
      key: AuthType.QWEN_OAUTH,
      label: t('Qwen OAuth'),
      value: AuthType.QWEN_OAUTH,
    },
    {
      key: AuthType.USE_OPENAI,
      label: t('OpenAI'),
      value: AuthType.USE_OPENAI,
    },
  ];

  const initialAuthIndex = Math.max(
    0,
    items.findIndex((item) => {
      // Priority 1: pendingAuthType
      if (pendingAuthType) {
        return item.value === pendingAuthType;
      }

      // Priority 2: settings.merged.security?.auth?.selectedType
      if (settings.merged.security?.auth?.selectedType) {
        return item.value === settings.merged.security?.auth?.selectedType;
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

  const hasApiKey = Boolean(settings.merged.security?.auth?.apiKey);
  const currentSelectedAuthType =
    selectedIndex !== null
      ? items[selectedIndex]?.value
      : items[initialAuthIndex]?.value;

  const handleAuthSelect = async (authMethod: AuthType) => {
    setErrorMessage(null);
    await onAuthSelect(authMethod, SettingScope.User);
  };

  const handleHighlight = (authMethod: AuthType) => {
    const index = items.findIndex((item) => item.value === authMethod);
    setSelectedIndex(index);
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        // Prevent exit if there is an error message.
        // This means they user is not authenticated yet.
        if (errorMessage) {
          return;
        }
        if (settings.merged.security?.auth?.selectedType === undefined) {
          // Prevent exiting if no auth method is set
          setErrorMessage(
            t(
              'You must select an auth method to proceed. Press Ctrl+C again to exit.',
            ),
          );
          return;
        }
        onAuthSelect(undefined, SettingScope.User);
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.Gray}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{t('Get started')}</Text>
      <Box marginTop={1}>
        <Text>{t('How would you like to authenticate for this project?')}</Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={initialAuthIndex}
          onSelect={handleAuthSelect}
          onHighlight={handleHighlight}
        />
      </Box>
      {(authError || errorMessage) && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{authError || errorMessage}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Colors.AccentPurple}>{t('(Use Enter to Set Auth)')}</Text>
      </Box>
      {hasApiKey && currentSelectedAuthType === AuthType.QWEN_OAUTH && (
        <Box marginTop={1}>
          <Text color={Colors.Gray}>
            {t(
              'Note: Your existing API key in settings.json will not be cleared when using Qwen OAuth. You can switch back to OpenAI authentication later if needed.',
            )}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>{t('Terms of Services and Privacy Notice for Qwen Code')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.AccentBlue}>
          {'https://github.com/QwenLM/Qwen3-Coder/blob/main/README.md'}
        </Text>
      </Box>
    </Box>
  );
}
