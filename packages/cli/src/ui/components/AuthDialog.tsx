/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { Box, Text } from 'ink';
import {
  setOpenAIApiKey,
  setOpenAIBaseUrl,
  setOpenAIModel,
  validateAuthMethod,
} from '../../config/auth.js';
import { type LoadedSettings, SettingScope } from '../../config/settings.js';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { OpenAIKeyPrompt } from './OpenAIKeyPrompt.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';

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
  // Track which prompt variant to render to avoid showing both sets of fields at once
  const [promptVariant, setPromptVariant] = useState<'openai' | 'azure'>(
    'openai',
  );

  const items = [
    { label: 'Qwen OAuth', value: AuthType.QWEN_OAUTH },
    { label: 'OpenAI', value: AuthType.USE_OPENAI },
    { label: 'Azure OpenAI', value: AuthType.AZURE_OPENAI },
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

      if (process.env['GEMINI_API_KEY']) {
        return item.value === AuthType.USE_GEMINI;
      }

      return item.value === AuthType.LOGIN_WITH_GOOGLE;
    }),
  );

  const handleAuthSelect = (authMethod: AuthType) => {
    const error = validateAuthMethod(authMethod);
    if (error) {
      // Decide which prompt variant is needed based on missing configuration
      if (authMethod === AuthType.USE_OPENAI) {
        // For OpenAI, check if we have a standard OpenAI API key
        const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
        // Also check if user might be trying to use Azure config with OpenAI auth type
        const hasAzureConfig = !!(
          process.env.AZURE_OPENAI_ENDPOINT &&
          process.env.AZURE_OPENAI_DEPLOYMENT &&
          (process.env.AZURE_OPENAI_API_KEY ||
            process.env.AZURE_OPENAI_BEARER_TOKEN)
        );

        if (!hasOpenAIKey && !hasAzureConfig) {
          setPromptVariant('openai');
          setShowOpenAIKeyPrompt(true);
          setErrorMessage(null);
          return;
        }
      } else if (authMethod === AuthType.AZURE_OPENAI) {
        // For Azure OpenAI, specifically check for Azure configuration
        const missingAzure =
          !(
            process.env.AZURE_OPENAI_API_KEY ||
            process.env.AZURE_OPENAI_BEARER_TOKEN
          ) ||
          !process.env.AZURE_OPENAI_ENDPOINT ||
          !process.env.AZURE_OPENAI_DEPLOYMENT;

        if (missingAzure) {
          setPromptVariant('azure');
          setShowOpenAIKeyPrompt(true);
          setErrorMessage(null);
          return;
        }
      }
      // If we get here, show the validation error
      setErrorMessage(error);
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
    // Don't set OpenAI environment variables if we're in Azure mode
    if (promptVariant === 'openai') {
      setOpenAIApiKey(apiKey);
      setOpenAIBaseUrl(baseUrl);
      setOpenAIModel(model);
    }
    // Azure environment variables are already set in the prompt component
    setShowOpenAIKeyPrompt(false);

    // Decide which auth type is appropriate based on the prompt variant
    // This ensures we don't accidentally detect Azure config when user intended OpenAI
    const selectedAuthType =
      promptVariant === 'azure' ? AuthType.AZURE_OPENAI : AuthType.USE_OPENAI;

    onSelect(selectedAuthType, SettingScope.User);
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

  if (showOpenAIKeyPrompt) {
    return (
      <OpenAIKeyPrompt
        onSubmit={handleOpenAIKeySubmit}
        onCancel={handleOpenAIKeyCancel}
        variant={promptVariant}
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
