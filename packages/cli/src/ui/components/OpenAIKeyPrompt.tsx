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
}

export function OpenAIKeyPrompt({
  onSubmit,
  onCancel,
}: OpenAIKeyPromptProps): React.JSX.Element {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [azureEndpoint, setAzureEndpoint] = useState('');
  const [azureDeployment, setAzureDeployment] = useState('');
  const [azureApiKey, setAzureApiKey] = useState('');
  const [azureApiVersion, setAzureApiVersion] = useState('');
  const [currentField, setCurrentField] = useState<
    | 'apiKey'
    | 'baseUrl'
    | 'model'
    | 'azureEndpoint'
    | 'azureDeployment'
    | 'azureApiKey'
    | 'azureApiVersion'
  >('apiKey');

  useInput((input, key) => {
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
      } else if (currentField === 'azureEndpoint') {
        setAzureEndpoint((prev) => prev + cleanInput);
      } else if (currentField === 'azureDeployment') {
        setAzureDeployment((prev) => prev + cleanInput);
      } else if (currentField === 'azureApiKey') {
        setAzureApiKey((prev) => prev + cleanInput);
      } else if (currentField === 'azureApiVersion') {
        setAzureApiVersion((prev) => prev + cleanInput);
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
        // Check if we should use Azure configuration
        if (azureEndpoint && azureDeployment && azureApiKey) {
          // Set Azure environment variables and submit
          process.env.AZURE_OPENAI_ENDPOINT = azureEndpoint;
          process.env.AZURE_OPENAI_DEPLOYMENT = azureDeployment;
          process.env.AZURE_OPENAI_API_KEY = azureApiKey;
          if (azureApiVersion) {
            process.env.AZURE_OPENAI_API_VERSION = azureApiVersion;
          }
          // Use a placeholder API key since Azure uses the API key in a different way
          onSubmit('azure-api-key', '', azureDeployment);
        } else if (apiKey.trim()) {
          onSubmit(apiKey.trim(), baseUrl.trim(), model.trim());
        } else {
          // If API key is empty, go back to API key field
          setCurrentField('apiKey');
        }
      } else if (currentField === 'azureEndpoint') {
        setCurrentField('azureDeployment');
        return;
      } else if (currentField === 'azureDeployment') {
        setCurrentField('azureApiKey');
        return;
      } else if (currentField === 'azureApiKey') {
        setCurrentField('azureApiVersion');
        return;
      } else if (currentField === 'azureApiVersion') {
        // After filling all Azure fields, submit
        if (azureEndpoint && azureDeployment && azureApiKey) {
          // Set Azure environment variables and submit
          process.env.AZURE_OPENAI_ENDPOINT = azureEndpoint;
          process.env.AZURE_OPENAI_DEPLOYMENT = azureDeployment;
          process.env.AZURE_OPENAI_API_KEY = azureApiKey;
          if (azureApiVersion) {
            process.env.AZURE_OPENAI_API_VERSION = azureApiVersion;
          }
          // Use a placeholder API key since Azure uses the API key in a different way
          onSubmit('azure-api-key', '', azureDeployment);
        } else {
          // If Azure fields are not complete, go back to Azure endpoint field
          setCurrentField('azureEndpoint');
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
        setCurrentField('azureEndpoint');
      } else if (currentField === 'azureEndpoint') {
        setCurrentField('azureDeployment');
      } else if (currentField === 'azureDeployment') {
        setCurrentField('azureApiKey');
      } else if (currentField === 'azureApiKey') {
        setCurrentField('azureApiVersion');
      } else if (currentField === 'azureApiVersion') {
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
      } else if (currentField === 'azureEndpoint') {
        setCurrentField('model');
      } else if (currentField === 'azureDeployment') {
        setCurrentField('azureEndpoint');
      } else if (currentField === 'azureApiKey') {
        setCurrentField('azureDeployment');
      } else if (currentField === 'azureApiVersion') {
        setCurrentField('azureApiKey');
      }
      return;
    }

    if (key.downArrow) {
      if (currentField === 'apiKey') {
        setCurrentField('baseUrl');
      } else if (currentField === 'baseUrl') {
        setCurrentField('model');
      } else if (currentField === 'model') {
        setCurrentField('azureEndpoint');
      } else if (currentField === 'azureEndpoint') {
        setCurrentField('azureDeployment');
      } else if (currentField === 'azureDeployment') {
        setCurrentField('azureApiKey');
      } else if (currentField === 'azureApiKey') {
        setCurrentField('azureApiVersion');
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
      } else if (currentField === 'azureEndpoint') {
        setAzureEndpoint((prev) => prev.slice(0, -1));
      } else if (currentField === 'azureDeployment') {
        setAzureDeployment((prev) => prev.slice(0, -1));
      } else if (currentField === 'azureApiKey') {
        setAzureApiKey((prev) => prev.slice(0, -1));
      } else if (currentField === 'azureApiVersion') {
        setAzureApiVersion((prev) => prev.slice(0, -1));
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
        <Box width={15}>
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
        <Box width={15}>
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
        <Box width={15}>
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

      {/* Azure OpenAI Configuration */}
      <Box marginTop={1}>
        <Text bold color={Colors.AccentBlue}>
          OR Azure OpenAI Configuration
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={15}>
          <Text
            color={
              currentField === 'azureEndpoint' ? Colors.AccentBlue : Colors.Gray
            }
          >
            Endpoint:
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            {currentField === 'azureEndpoint' ? '> ' : '  '}
            {azureEndpoint}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={15}>
          <Text
            color={
              currentField === 'azureDeployment'
                ? Colors.AccentBlue
                : Colors.Gray
            }
          >
            Deployment:
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            {currentField === 'azureDeployment' ? '> ' : '  '}
            {azureDeployment}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={15}>
          <Text
            color={
              currentField === 'azureApiKey' ? Colors.AccentBlue : Colors.Gray
            }
          >
            API Key:
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            {currentField === 'azureApiKey' ? '> ' : '  '}
            {azureApiKey}
          </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="row">
        <Box width={15}>
          <Text
            color={
              currentField === 'azureApiVersion'
                ? Colors.AccentBlue
                : Colors.Gray
            }
          >
            API Version:
          </Text>
        </Box>
        <Box flexGrow={1}>
          <Text>
            {currentField === 'azureApiVersion' ? '> ' : '  '}
            {azureApiVersion || '2024-05-01-preview'}
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
