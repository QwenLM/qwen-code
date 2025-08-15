/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';
import { saveToQwenEnv } from '../../config/auth.js';

interface OpenAIKeyPromptProps {
  onSubmit: (apiKey: string, baseUrl: string, model: string) => void;
  onCancel: () => void;
}

export function OpenAIKeyPrompt({
  onSubmit,
  onCancel,
}: OpenAIKeyPromptProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [currentField, setCurrentField] = useState<
    'apiKey' | 'baseUrl' | 'model'
  >('apiKey');
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [savedApiKey, setSavedApiKey] = useState('');
  const [savedBaseUrl, setSavedBaseUrl] = useState('');
  const [savedModel, setSavedModel] = useState('');

  useInput((input, key) => {
    // Handle save prompt
    if (showSavePrompt) {
      if (key.escape) {
        // Don't save and continue
        onSubmit(savedApiKey, savedBaseUrl, savedModel);
        return;
      }

      const cleanInput = input.trim().toLowerCase();
      if (
        cleanInput === 'y' ||
        cleanInput === 'yes' ||
        input.includes('\n') ||
        input.includes('\r')
      ) {
        // Save and continue
        saveToQwenEnv(savedApiKey, savedBaseUrl, savedModel)
          .then(() => {
            onSubmit(savedApiKey, savedBaseUrl, savedModel);
          })
          .catch((error) => {
            console.warn('Failed to save credentials to .qwen.env:', error);
            // Even if save fails, continue with the session
            onSubmit(savedApiKey, savedBaseUrl, savedModel);
          });
        return;
      } else if (cleanInput === 'n' || cleanInput === 'no') {
        // Don't save and continue
        onSubmit(savedApiKey, savedBaseUrl, savedModel);
        return;
      }
      return;
    }

    // 过滤粘贴相关的控制序列
    let cleanInput = (input || '')
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
      return;
    }

    // 检查是否是 Enter 键（通过检查输入是否包含换行符）
    if (input.includes('\n') || input.includes('\r')) {
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
          // Store the values and show save prompt
          setSavedApiKey(apiKey.trim());
          setSavedBaseUrl(baseUrl.trim());
          setSavedModel(model.trim());
          setShowSavePrompt(true);
        } else {
          // 如果 API key 为空，回到 API key 字段
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

  if (showSavePrompt) {
    return (
      <Box
        borderStyle="round"
        borderColor={Colors.AccentBlue}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text bold color={Colors.AccentBlue}>
          Save Configuration?
        </Text>
        <Box marginTop={1}>
          <Text>Save these credentials to .qwen.env for future use? [Y/n]</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={Colors.AccentYellow}>
            Note: .qwen.env is already in .gitignore to prevent accidental commits
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={Colors.Gray}>
            Press Enter or Y to save, N for session-only, Esc to use session-only
          </Text>
        </Box>
      </Box>
    );
  }

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
      <Box marginTop={1}>
        <Text>
          Please enter your OpenAI configuration. You can get an API key from{' '}
          <Text color={Colors.AccentBlue}>
            https://platform.openai.com/api-keys
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
