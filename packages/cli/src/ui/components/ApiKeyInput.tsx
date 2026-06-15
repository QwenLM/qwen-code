/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from './shared/TextInput.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';
import Link from 'ink-link';

export interface ApiKeyInputPlan {
  apiKeyUrl: string;
  helpText: string;
  placeholder: string;
  validate?: (apiKey: string) => string | null;
}

interface ApiKeyInputProps {
  onSubmit: (apiKey: string) => void;
  onCancel: () => void;
  plan: ApiKeyInputPlan;
}

export const CODING_PLAN_API_KEY_URL =
  'https://bailian.console.aliyun.com/?tab=model#/efm/coding_plan';

export const CODING_PLAN_INTL_API_KEY_URL =
  'https://modelstudio.console.alibabacloud.com/?tab=dashboard#/efm/coding_plan';

export const TOKEN_PLAN_API_KEY_URL =
  'https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=3028856';

export function ApiKeyInput({
  onSubmit,
  onCancel,
  plan,
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
        const validationError = plan.validate?.(trimmedKey);
        if (validationError) {
          setError(validationError);
          return;
        }
        onSubmit(trimmedKey);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <TextInput
        value={apiKey}
        onChange={setApiKey}
        placeholder={plan.placeholder}
        ellipsizeOverflow
      />
      {error && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>{plan.helpText}</Text>
      </Box>
      <Box marginTop={0}>
        <Link url={plan.apiKeyUrl} fallback={false}>
          <Text color={theme.text.link} underline>
            {plan.apiKeyUrl}
          </Text>
        </Link>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Enter to submit, Esc to go back')}
        </Text>
      </Box>
    </Box>
  );
}
