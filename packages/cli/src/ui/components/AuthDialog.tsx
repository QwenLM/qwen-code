/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  validateAuthMethod,
  setOpenAIApiKey,
  setOpenAIBaseUrl,
  setOpenAIModel,
} from '../../config/auth.js';
import { OpenAIKeyPrompt } from './OpenAIKeyPrompt.js';

interface AuthDialogProps {
  onSelect: (authMethod: AuthType | undefined, scope: SettingScope) => void;
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
  const items = [{ label: 'OpenAI', value: AuthType.USE_OPENAI }];

  const initialAuthIndex = Math.max(
    0,
    items.findIndex((item) => {
      if (settings.merged.selectedAuthType) {
        return item.value === settings.merged.selectedAuthType;
      }

      const defaultAuthType = parseDefaultAuthType(
        process.env.GEMINI_DEFAULT_AUTH_TYPE,
      );
      if (defaultAuthType) {
        return item.value === defaultAuthType;
      }

      if (process.env.GEMINI_API_KEY) {
        return item.value === AuthType.USE_GEMINI;
      }

      return item.value === AuthType.LOGIN_WITH_GOOGLE;
    }),
  );

  const handleAuthSelect = (authMethod: AuthType) => {
    const error = validateAuthMethod(authMethod);
    if (error) {
      if (authMethod === AuthType.USE_OPENAI && !process.env.OPENAI_API_KEY) {
        setShowOpenAIKeyPrompt(true);
        setErrorMessage(null);
      } else {
        setErrorMessage(error);
      }
    } else {
      setErrorMessage(null);
      onSelect(authMethod, SettingScope.User);
    }
  };

  const handleOpenAIKeySubmit = (
    apiKey: string,
    baseUrl: string,
    model: string,
  ) => {
    setOpenAIApiKey(apiKey);
    setOpenAIBaseUrl(baseUrl);
    setOpenAIModel(model);

    // Save OpenAI configuration to user settings as fallback
    // Priority order: .env > workspace settings.json > ~/.qwen/settings.json
    try {
      const openAIConfig: { [key: string]: string } = {};
      if (apiKey.trim()) openAIConfig.OPENAI_API_KEY = apiKey.trim();
      if (baseUrl.trim()) openAIConfig.OPENAI_BASE_URL = baseUrl.trim();
      if (model.trim()) openAIConfig.OPENAI_MODEL = model.trim();

      // Save to user settings as environment variables for next time
      settings.setValue(SettingScope.User, 'openaiConfig', openAIConfig);
    } catch (error) {
      // Don't block authentication if saving fails
      console.warn('Failed to save OpenAI config to settings:', error);
    }

    setShowOpenAIKeyPrompt(false);
    onSelect(AuthType.USE_OPENAI, SettingScope.User);
  };

  const handleOpenAIKeyCancel = () => {
    setShowOpenAIKeyPrompt(false);
    setErrorMessage('OpenAI API key is required to use OpenAI authentication.');
  };

  useInput((_input, key) => {
    if (showOpenAIKeyPrompt) {
      return;
    }

    if (key.escape) {
      // Prevent exit if there is an error message.
      // This means they user is not authenticated yet.
      if (errorMessage) {
        return;
      }
      if (settings.merged.selectedAuthType === undefined) {
        // Prevent exiting if no auth method is set
        setErrorMessage(
          'You must select an auth method to proceed. Press Ctrl+C twice to exit.',
        );
        return;
      }
      onSelect(undefined, SettingScope.User);
    }
  });

  if (showOpenAIKeyPrompt) {
    // Load default values from settings
    const defaultValues = {
      apiKey:
        process.env.OPENAI_API_KEY ||
        settings.merged.openaiConfig?.OPENAI_API_KEY ||
        '',
      baseUrl:
        process.env.OPENAI_BASE_URL ||
        settings.merged.openaiConfig?.OPENAI_BASE_URL ||
        '',
      model:
        process.env.OPENAI_MODEL ||
        settings.merged.openaiConfig?.OPENAI_MODEL ||
        '',
    };

    return (
      <OpenAIKeyPrompt
        onSubmit={handleOpenAIKeySubmit}
        onCancel={handleOpenAIKeyCancel}
        defaultValues={defaultValues}
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
          isFocused={true}
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
          {'https://github.com/QwenLM/qwen-code/blob/main/README.md'}
        </Text>
      </Box>
    </Box>
  );
}
