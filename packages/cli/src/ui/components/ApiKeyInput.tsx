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
import { CodingPlanRegion } from '../../constants/codingPlan.js';
import Link from 'ink-link';

interface ApiKeyInputProps {
  onSubmit: (apiKey: string) => void;
  onCancel: () => void;
  region?: CodingPlanRegion;
}

const CODING_PLAN_API_KEY_URL =
  'https://bailian.console.aliyun.com/?tab=model#/efm/coding_plan';

const CODING_PLAN_INTL_API_KEY_URL =
  'https://modelstudio.console.alibabacloud.com/?tab=dashboard#/efm/coding_plan';

export function ApiKeyInput({
  onSubmit,
  onCancel,
  region = CodingPlanRegion.CHINA,
}: ApiKeyInputProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const apiKeyUrl =
    region === CodingPlanRegion.GLOBAL
      ? CODING_PLAN_INTL_API_KEY_URL
      : CODING_PLAN_API_KEY_URL;

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
      <TextInput value={apiKey} onChange={setApiKey} placeholder="sk-sp-..." />
      {error && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>{t('You can get your Coding Plan API key here')}</Text>
      </Box>
      <Box marginTop={0}>
        <Link url={apiKeyUrl} fallback={false}>
          <Text color={theme.text.link} underline>
            {apiKeyUrl}
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
