/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';

interface OpenAIKeyPromptProps {
  onSubmit: (apiKey: string, baseUrl: string, model: string) => void;
  onCancel: () => void;
  defaultValues?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}

export function OpenAIKeyPrompt({
  onSubmit,
  onCancel,
  defaultValues,
}: OpenAIKeyPromptProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState(defaultValues?.apiKey || '');
  const [baseUrl, setBaseUrl] = useState(defaultValues?.baseUrl || '');
  const [model, setModel] = useState(defaultValues?.model || '');
  const [currentField, setCurrentField] = useState<
    'apiKey' | 'baseUrl' | 'model'
  >('apiKey');

  useInput((input, key) => {
    // Ignore control sequences like [I or [O from focus switching
    if (input && (input === '[I' || input === '[O')) {
      return;
    }

    // 处理字符输入
    if (input && input.length > 0) {
      // Filter paste-related control sequences
      let cleanInput = (input || '')
        // Filter ESC-based control sequences (like \u001b[200~, \u001b[201~, etc.)
        .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '') // eslint-disable-line no-control-regex
        // Filter paste start marker [200~
        .replace(/\[200~/g, '')
        // Filter paste end marker [201~
        .replace(/\[201~/g, '')
        // Filter standalone [ and ~ characters (possible paste marker remnants)
        .replace(/^\[|~$/g, '');

      // Filter all invisible characters (ASCII < 32, except newlines)
      cleanInput = cleanInput
        .split('')
        .filter((ch) => ch.charCodeAt(0) >= 32)
        .join('');

      if (cleanInput.length > 0) {
        if (currentField === 'apiKey') {
          setApiKey((prev) => prev + cleanInput);
        } else if (currentField === 'baseUrl') {
          setBaseUrl((prev) => prev + cleanInput);
        } else if (currentField === 'model') {
          setModel((prev) => prev + cleanInput);
        }
        return;
      }
    }

    // Check if Enter key was pressed (by checking for newline characters)
    if (input.includes('\n') || input.includes('\r')) {
      if (currentField === 'apiKey') {
        // Allow empty API key to jump to next field, user can return to modify later
        setCurrentField('baseUrl');
        return;
      } else if (currentField === 'baseUrl') {
        setCurrentField('model');
        return;
      } else if (currentField === 'model') {
        // Only check if API key is empty when submitting
        if (apiKey.trim()) {
          onSubmit(apiKey.trim(), baseUrl.trim(), model.trim());
        } else {
          // If API key is empty, return to API key field
          setCurrentField('apiKey');
        }
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    // Handle Tab key for field navigation
    if (key.tab) {
      if (currentField === 'apiKey') {
        setCurrentField('baseUrl');
      } else if (currentField === 'baseUrl') {
        setCurrentField('model');
      } else if (currentField === 'model') {
        setCurrentField('apiKey');
      }
      return;
    }

    // Handle arrow keys for field navigation
    if (key.upArrow) {
      if (currentField === 'baseUrl') {
        setCurrentField('apiKey');
      } else if (currentField === 'model') {
        setCurrentField('baseUrl');
      }
      return;
    }

    if (key.downArrow) {
      if (currentField === 'apiKey') {
        setCurrentField('baseUrl');
      } else if (currentField === 'baseUrl') {
        setCurrentField('model');
      }
      return;
    }

    // Handle backspace - check both key.backspace and delete key
    if (key.backspace || key.delete) {
      if (currentField === 'apiKey') {
        setApiKey((prev) => prev.slice(0, -1));
      } else if (currentField === 'baseUrl') {
        setBaseUrl((prev) => prev.slice(0, -1));
      } else if (currentField === 'model') {
        setModel((prev) => prev.slice(0, -1));
      }
      return;
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentBlue}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={Colors.AccentBlue}>
        API Configuration Required
      </Text>
      <Box marginTop={1}>
        <Text>Please enter your API configuration.</Text>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={12}>
          <Text
            color={currentField === 'apiKey' ? Colors.AccentBlue : Colors.Gray}
          >
            API Key:
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            {currentField === 'apiKey' ? '> ' : '  '}
            {apiKey || ' '}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={12}>
          <Text
            color={currentField === 'baseUrl' ? Colors.AccentBlue : Colors.Gray}
          >
            Base URL:
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            {currentField === 'baseUrl' ? '> ' : '  '}
            {baseUrl}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={12}>
          <Text
            color={currentField === 'model' ? Colors.AccentBlue : Colors.Gray}
          >
            Model:
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            {currentField === 'model' ? '> ' : '  '}
            {model}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
