/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { Box, Text } from 'ink';
import { validateAuthMethod } from '../../config/auth.js';
import { type LoadedSettings, SettingScope } from '../../config/settings.js';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { OpenAIKeyPrompt } from '../components/OpenAIKeyPrompt.js';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';

interface AuthDialogProps {
  onSelect: (
    authMethod: AuthType | undefined,
    scope: SettingScope,
    credentials?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    },
  ) => void;
  settings: LoadedSettings;
  initialErrorMessage?: string | null;
}

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

export function AuthDialog({
  onSelect,
  settings,
  initialErrorMessage,
}: AuthDialogProps): React.JSX.Element {
  const [errorMessage, setErrorMessage] = useState<string | null>(
    initialErrorMessage || null,
  );
  const [showOpenAIKeyPrompt, setShowOpenAIKeyPrompt] = useState(false);
  const items = [
    {
      key: AuthType.QWEN_OAUTH,
      label: 'Qwen OAuth',
      value: AuthType.QWEN_OAUTH,
    },
    { key: AuthType.USE_OPENAI, label: 'OpenAI', value: AuthType.USE_OPENAI },
  ];

  const initialAuthIndex = Math.max(
    0,
    items.findIndex((item) => {
      if (settings.merged.security?.auth?.selectedType) {
        return item.value === settings.merged.security?.auth?.selectedType;
      }

      const defaultAuthType = parseDefaultAuthType(
        process.env['QWEN_DEFAULT_AUTH_TYPE'],
      );
      if (defaultAuthType) {
        return item.value === defaultAuthType;
      }

      return item.value === AuthType.QWEN_OAUTH;
    }),
  );

  const handleAuthSelect = (authMethod: AuthType) => {
    if (authMethod === AuthType.USE_OPENAI) {
      setShowOpenAIKeyPrompt(true);
      setErrorMessage(null);
    } else {
      const error = validateAuthMethod(authMethod);
      if (error) {
        setErrorMessage(error);
      } else {
        setErrorMessage(null);
        onSelect(authMethod, SettingScope.User);
      }
    }
  };

  const handleOpenAIKeySubmit = (
    apiKey: string,
    baseUrl: string,
    model: string,
  ) => {
    setShowOpenAIKeyPrompt(false);
    onSelect(AuthType.USE_OPENAI, SettingScope.User, {
      apiKey,
      baseUrl,
      model,
    });
  };

  const handleOpenAIKeyCancel = () => {
    setShowOpenAIKeyPrompt(false);
    setErrorMessage('OpenAI API key is required to use OpenAI authentication.');
  };

  useKeypress(
    (key) => {
      if (showOpenAIKeyPrompt) {
        return;
      }

      if (key.name === 'escape') {
        // Prevent exit if there is an error message.
        // This means they user is not authenticated yet.
        if (errorMessage) {
          return;
        }
        if (settings.merged.security?.auth?.selectedType === undefined) {
          // Prevent exiting if no auth method is set
          setErrorMessage(
            'You must select an auth method to proceed. Press Ctrl+C again to exit.',
          );
          return;
        }
        onSelect(undefined, SettingScope.User);
      }
    },
    { isActive: true },
  );
  const getDefaultOpenAIConfig = () => {
    const fromSettings = settings.merged.security?.auth;
    const modelSettings = settings.merged.model;
    return {
      apiKey: fromSettings?.apiKey || process.env['OPENAI_API_KEY'] || '',
      baseUrl: fromSettings?.baseUrl || process.env['OPENAI_BASE_URL'] || '',
      model: modelSettings?.name || process.env['OPENAI_MODEL'] || '',
    };
  };

  if (showOpenAIKeyPrompt) {
    const defaults = getDefaultOpenAIConfig();
    return (
      <OpenAIKeyPrompt
        defaultApiKey={defaults.apiKey}
        defaultBaseUrl={defaults.baseUrl}
        defaultModel={defaults.model}
        onSubmit={handleOpenAIKeySubmit}
        onCancel={handleOpenAIKeyCancel}
      />
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.Gray}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>Get started</Text>
      <Box marginTop={1}>
        <Text>How would you like to authenticate for this project?</Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={initialAuthIndex}
          onSelect={handleAuthSelect}
        />
      </Box>
      {errorMessage && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{errorMessage}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Colors.AccentPurple}>(Use Enter to Set Auth)</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Terms of Services and Privacy Notice for Qwen Code</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.AccentBlue}>
          {'https://github.com/QwenLM/Qwen3-Coder/blob/main/README.md'}
        </Text>
      </Box>
    </Box>
  );
}
