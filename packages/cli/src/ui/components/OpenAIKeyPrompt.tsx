/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';

type PromptVariant = 'openai' | 'azure';

interface OpenAIKeyPromptProps {
  onSubmit: (apiKey: string, baseUrl: string, model: string) => void;
  onCancel: () => void;
  variant?: PromptVariant; // default to 'openai' when not provided
}

export function OpenAIKeyPrompt({
  onSubmit,
  onCancel,
  variant = 'openai',
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
  >(variant === 'azure' ? 'azureEndpoint' : 'apiKey');

  useInput((input, key) => {
    // Robustly strip terminal focus and ANSI control sequences to avoid spurious '0'/'I'
    // Remove CSI sequences like ESC[...<final>
    let cleanInput = (input || '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // eslint-disable-line no-control-regex
      // Remove common bracketed paste markers
      .replace(/\[200~|\[201~|\[0I|\[I|\[O/g, '') // handle possible leftover without ESC
      // Remove leading/trailing stray '[' or '~'
      .replace(/^\[|~$/g, '');

    // Remove any residual "0I" or "I" that sometimes leak from focus events
    if (/^(0?I|O)$/.test(cleanInput)) {
      cleanInput = '';
    }

    // Filter non-printable ASCII except CR/LF which we process separately
    cleanInput = cleanInput
      .split('')
      .filter((ch) => ch.charCodeAt(0) >= 32)
      .join('');

    if (cleanInput.length > 0) {
      if (variant === 'openai') {
        if (currentField === 'apiKey') {
          setApiKey((prev) => prev + cleanInput);
        } else if (currentField === 'baseUrl') {
          setBaseUrl((prev) => prev + cleanInput);
        } else if (currentField === 'model') {
          setModel((prev) => prev + cleanInput);
        }
      } else {
        if (currentField === 'azureEndpoint') {
          setAzureEndpoint((prev) => prev + cleanInput);
        } else if (currentField === 'azureDeployment') {
          setAzureDeployment((prev) => prev + cleanInput);
        } else if (currentField === 'azureApiKey') {
          setAzureApiKey((prev) => prev + cleanInput);
        } else if (currentField === 'azureApiVersion') {
          setAzureApiVersion((prev) => prev + cleanInput);
        }
      }
      return;
    }

    // Enter handling (treat CR/LF as submission or advance)
    if (input.includes('\n') || input.includes('\r')) {
      if (variant === 'openai') {
        if (currentField === 'apiKey') {
          setCurrentField('baseUrl');
          return;
        } else if (currentField === 'baseUrl') {
          setCurrentField('model');
          return;
        } else if (currentField === 'model') {
          if (apiKey.trim()) {
            onSubmit(apiKey.trim(), baseUrl.trim(), model.trim());
          } else {
            setCurrentField('apiKey');
          }
          return;
        }
      } else {
        if (currentField === 'azureEndpoint') {
          setCurrentField('azureDeployment');
          return;
        } else if (currentField === 'azureDeployment') {
          setCurrentField('azureApiKey');
          return;
        } else if (currentField === 'azureApiKey') {
          setCurrentField('azureApiVersion');
          return;
        } else if (currentField === 'azureApiVersion') {
          if (azureEndpoint && azureDeployment && azureApiKey) {
            process.env.AZURE_OPENAI_ENDPOINT = azureEndpoint;
            process.env.AZURE_OPENAI_DEPLOYMENT = azureDeployment;
            process.env.AZURE_OPENAI_API_KEY = azureApiKey;
            if (azureApiVersion) {
              process.env.AZURE_OPENAI_API_VERSION = azureApiVersion;
            }
            // For Azure, use the deployment name as the model
            onSubmit(azureApiKey, '', azureDeployment);
          } else {
            setCurrentField('azureEndpoint');
          }
          return;
        }
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    // Handle Tab key for field navigation (cycle within current variant only)
    if (key.tab) {
      if (variant === 'openai') {
        if (currentField === 'apiKey') setCurrentField('baseUrl');
        else if (currentField === 'baseUrl') setCurrentField('model');
        else if (currentField === 'model') setCurrentField('apiKey');
      } else {
        if (currentField === 'azureEndpoint')
          setCurrentField('azureDeployment');
        else if (currentField === 'azureDeployment')
          setCurrentField('azureApiKey');
        else if (currentField === 'azureApiKey')
          setCurrentField('azureApiVersion');
        else if (currentField === 'azureApiVersion')
          setCurrentField('azureEndpoint');
      }
      return;
    }

    // Handle arrow keys for field navigation (within variant)
    if (key.upArrow) {
      if (variant === 'openai') {
        if (currentField === 'baseUrl') setCurrentField('apiKey');
        else if (currentField === 'model') setCurrentField('baseUrl');
      } else {
        if (currentField === 'azureDeployment')
          setCurrentField('azureEndpoint');
        else if (currentField === 'azureApiKey')
          setCurrentField('azureDeployment');
        else if (currentField === 'azureApiVersion')
          setCurrentField('azureApiKey');
      }
      return;
    }

    if (key.downArrow) {
      if (variant === 'openai') {
        if (currentField === 'apiKey') setCurrentField('baseUrl');
        else if (currentField === 'baseUrl') setCurrentField('model');
      } else {
        if (currentField === 'azureEndpoint')
          setCurrentField('azureDeployment');
        else if (currentField === 'azureDeployment')
          setCurrentField('azureApiKey');
        else if (currentField === 'azureApiKey')
          setCurrentField('azureApiVersion');
      }
      return;
    }

    // Handle backspace - check both key.backspace and delete key
    if (key.backspace || key.delete) {
      if (variant === 'openai') {
        if (currentField === 'apiKey') setApiKey((prev) => prev.slice(0, -1));
        else if (currentField === 'baseUrl')
          setBaseUrl((prev) => prev.slice(0, -1));
        else if (currentField === 'model')
          setModel((prev) => prev.slice(0, -1));
      } else {
        if (currentField === 'azureEndpoint')
          setAzureEndpoint((prev) => prev.slice(0, -1));
        else if (currentField === 'azureDeployment')
          setAzureDeployment((prev) => prev.slice(0, -1));
        else if (currentField === 'azureApiKey')
          setAzureApiKey((prev) => prev.slice(0, -1));
        else if (currentField === 'azureApiVersion')
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
        {variant === 'azure'
          ? 'Azure OpenAI Configuration Required'
          : 'OpenAI Configuration Required'}
      </Text>

      {variant === 'openai' ? (
        <>
          <Box marginTop={1}>
            <Text>
              Please enter your OpenAI configuration. You can get an API key
              from{' '}
              <Text color={Colors.AccentBlue}>
                https://platform.openai.com/api-keys
              </Text>
            </Text>
          </Box>

          <Box marginTop={1} flexDirection="row">
            <Box width={15}>
              <Text
                color={
                  currentField === 'apiKey' ? Colors.AccentBlue : Colors.Gray
                }
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
                color={
                  currentField === 'baseUrl' ? Colors.AccentBlue : Colors.Gray
                }
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
                color={
                  currentField === 'model' ? Colors.AccentBlue : Colors.Gray
                }
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
        </>
      ) : (
        <>
          <Box marginTop={1} flexDirection="row">
            <Box width={15}>
              <Text
                color={
                  currentField === 'azureEndpoint'
                    ? Colors.AccentBlue
                    : Colors.Gray
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
                  currentField === 'azureApiKey'
                    ? Colors.AccentBlue
                    : Colors.Gray
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
        </>
      )}

      <Box marginTop={1}>
        <Text color={Colors.Gray}>
          Press Enter to continue, Tab/↑↓ to navigate, Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
