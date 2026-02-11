/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from './shared/TextInput.js';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';

interface ApiKeyInputProps {
  onSubmit: (apiKey: string) => void;
  onCancel: () => void;
}

export function ApiKeyInput({
  onSubmit,
  onCancel,
}: ApiKeyInputProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onCancel();
      } else if (key.name === 'return') {
        const trimmedKey = apiKey.trim();
        if (!trimmedKey) {
          setError(t('API key cannot be empty.'));
          return;
        }
        onSubmit(trimmedKey);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>{t('Please enter your API key:')}</Text>
      </Box>
      <TextInput value={apiKey} onChange={setApiKey} placeholder="sk-sp-..." />
      {error && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          {t('(Press Enter to submit, Escape to cancel)')}
        </Text>
      </Box>
    </Box>
  );
}
