/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useState } from 'react';
import { z } from 'zod';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';

interface OpenAIKeyPromptProps {
  onSubmit: (apiKey: string, baseUrl: string) => void;
  onCancel: () => void;
  defaultApiKey?: string;
  defaultBaseUrl?: string;
}

export const credentialSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  baseUrl: z
    .union([z.string().url('Base URL must be a valid URL'), z.literal('')])
    .optional(),
});

export type OpenAICredentials = z.infer<typeof credentialSchema>;

export function OpenAIKeyPrompt({
  onSubmit,
  onCancel,
  defaultApiKey,
  defaultBaseUrl,
}: OpenAIKeyPromptProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState(defaultApiKey || '');
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl || '');
  const [currentField, setCurrentField] = useState<'apiKey' | 'baseUrl'>(
    'apiKey',
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const validateAndSubmit = () => {
    setValidationError(null);

    try {
      const validated = credentialSchema.parse({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
      });

      onSubmit(
        validated.apiKey,
        validated.baseUrl === '' ? '' : validated.baseUrl || '',
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessage = error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        setValidationError(
          t('Invalid credentials: {{errorMessage}}', { errorMessage }),
        );
      } else {
        setValidationError(t('Failed to validate credentials'));
      }
    }
  };

  useKeypress(
    (key) => {
      // Handle escape
      if (key.name === 'escape') {
        onCancel();
        return;
      }

      // Handle Enter key
      if (key.name === 'return') {
        if (currentField === 'apiKey') {
          setCurrentField('baseUrl');
          return;
        } else if (currentField === 'baseUrl') {
          // Only submit if API key is not empty
          if (apiKey.trim()) {
            validateAndSubmit();
          } else {
            setCurrentField('apiKey');
          }
        }
        return;
      }

      // Handle Tab key for field navigation
      if (key.name === 'tab') {
        setCurrentField(currentField === 'apiKey' ? 'baseUrl' : 'apiKey');
        return;
      }

      // Handle arrow keys for field navigation
      if (key.name === 'up') {
        if (currentField === 'baseUrl') {
          setCurrentField('apiKey');
        }
        return;
      }

      if (key.name === 'down') {
        if (currentField === 'apiKey') {
          setCurrentField('baseUrl');
        }
        return;
      }

      // Handle backspace/delete
      if (key.name === 'backspace' || key.name === 'delete') {
        if (currentField === 'apiKey') {
          setApiKey((prev) => prev.slice(0, -1));
        } else if (currentField === 'baseUrl') {
          setBaseUrl((prev) => prev.slice(0, -1));
        }
        return;
      }

      // Handle paste mode - if it's a paste event with content
      if (key.paste && key.sequence) {
        // 过滤粘贴相关的控制序列
        let cleanInput = key.sequence
          // 过滤 ESC 开头的控制序列（如 \u001b[200~、\u001b[201~ 等）
          .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '') // eslint-disable-line no-control-regex
          // 过滤粘贴开始标记 [200~
          .replace(/\[200~/g, '')
          // 过滤粘贴结束标记 [201~
          .replace(/\[201~/g, '')
          // 过滤单独的 [ 和 ~ 字符（可能是粘贴标记的残留）
          .replace(/^\[|~$/g, '');

        // 再过滤所有不可见字符（ASCII < 32，除了回车换行）
        cleanInput = cleanInput
          .split('')
          .filter((ch) => ch.charCodeAt(0) >= 32)
          .join('');

        if (cleanInput.length > 0) {
          if (currentField === 'apiKey') {
            setApiKey((prev) => prev + cleanInput);
          } else if (currentField === 'baseUrl') {
            setBaseUrl((prev) => prev + cleanInput);
          }
        }
        return;
      }

      // Handle regular character input
      if (key.sequence && !key.ctrl && !key.meta) {
        // Filter control characters
        const cleanInput = key.sequence
          .split('')
          .filter((ch) => ch.charCodeAt(0) >= 32)
          .join('');

        if (cleanInput.length > 0) {
          if (currentField === 'apiKey') {
            setApiKey((prev) => prev + cleanInput);
          } else if (currentField === 'baseUrl') {
            setBaseUrl((prev) => prev + cleanInput);
          }
        }
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.AccentBlue}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold color={Colors.AccentBlue}>
        {t('OpenAI Configuration Required')}
      </Text>
      {validationError && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{validationError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          {t(
            'Please enter your OpenAI configuration. You can get an API key from',
          )}{' '}
          <Text color={Colors.AccentBlue}>
            https://bailian.console.aliyun.com/?tab=model#/api-key
          </Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={12}>
          <Text
            color={currentField === 'apiKey' ? Colors.AccentBlue : Colors.Gray}
          >
            {t('API Key:')}
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
            {t('Base URL:')}
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            {currentField === 'baseUrl' ? '> ' : '  '}
            {baseUrl}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          {t('Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel')}
        </Text>
      </Box>
    </Box>
  );
}
