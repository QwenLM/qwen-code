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

interface OpenAIKeyPromptProps {
  onSubmit: (apiKey: string, baseUrl: string, model: string) => void;
  onCancel: () => void;
  defaultApiKey?: string;
  defaultBaseUrl?: string;
  defaultModel?: string;
}

export const credentialSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  baseUrl: z
    .union([z.string().url('Base URL must be a valid URL'), z.literal('')])
    .optional(),
  model: z.string().min(1, 'Model must be a non-empty string').optional(),
});

export type OpenAICredentials = z.infer<typeof credentialSchema>;

export function OpenAIKeyPrompt({
  onSubmit,
  onCancel,
  defaultApiKey,
  defaultBaseUrl,
  defaultModel,
}: OpenAIKeyPromptProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState(defaultApiKey || '');
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl || '');
  const [model, setModel] = useState(defaultModel || '');
  const [currentField, setCurrentField] = useState<
    'apiKey' | 'baseUrl' | 'model'
  >('apiKey');
  const [validationError, setValidationError] = useState<string | null>(null);

  const validateAndSubmit = () => {
    setValidationError(null);

    try {
      const validated = credentialSchema.parse({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
      });

      onSubmit(
        validated.apiKey,
        validated.baseUrl === '' ? '' : validated.baseUrl || '',
        validated.model || '',
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessage = error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join(', ');
        setValidationError(`Invalid credentials: ${errorMessage}`);
      } else {
        setValidationError('Failed to validate credentials');
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
          // 允许空 API key 跳转到下一个字段，让用户稍后可以返回修改
          setCurrentField('baseUrl');
          return;
        } else if (currentField === 'baseUrl') {
          setCurrentField('model');
          return;
        } else if (currentField === 'model') {
          // 只有在提交时才检查 API key 是否为空
          if (apiKey.trim()) {
            validateAndSubmit();
          } else {
            // 如果 API key 为空，回到 API key 字段
            setCurrentField('apiKey');
          }
        }
        return;
      }

      // Handle Tab key for field navigation
      if (key.name === 'tab') {
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
      if (key.name === 'up') {
        if (currentField === 'baseUrl') {
          setCurrentField('apiKey');
        } else if (currentField === 'model') {
          setCurrentField('baseUrl');
        }
        return;
      }

      if (key.name === 'down') {
        if (currentField === 'apiKey') {
          setCurrentField('baseUrl');
        } else if (currentField === 'baseUrl') {
          setCurrentField('model');
        }
        return;
      }

      // Handle backspace/delete
      if (key.name === 'backspace' || key.name === 'delete') {
        if (currentField === 'apiKey') {
          setApiKey((prev) => prev.slice(0, -1));
        } else if (currentField === 'baseUrl') {
          setBaseUrl((prev) => prev.slice(0, -1));
        } else if (currentField === 'model') {
          setModel((prev) => prev.slice(0, -1));
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
          } else if (currentField === 'model') {
            setModel((prev) => prev + cleanInput);
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
          } else if (currentField === 'model') {
            setModel((prev) => prev + cleanInput);
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
        OpenAI Configuration Required
      </Text>
      {validationError && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{validationError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>
          Please enter your OpenAI configuration. You can get an API key from{' '}
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
