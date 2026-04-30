/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import { DescriptiveRadioButtonSelect } from '../../components/shared/DescriptiveRadioButtonSelect.js';
import { TextInput } from '../../components/shared/TextInput.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import type { CustomProviderFlowProps } from './AuthFlowTypes.js';

export function CustomProviderFlow({
  viewLevel,
  state,
  documentationUrl,
  onProtocolSelect,
  onProtocolHighlight,
  onBaseUrlChange,
  onBaseUrlSubmit,
  onApiKeyChange,
  onApiKeySubmit,
  onModelIdsChange,
  onModelIdsSubmit,
}: CustomProviderFlowProps): React.JSX.Element | null {
  if (viewLevel === 'custom-protocol-select') {
    return (
      <>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={state.protocolItems}
            initialIndex={state.protocolIndex}
            onSelect={onProtocolSelect}
            onHighlight={onProtocolHighlight}
            itemGap={1}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Enter to select, ↑↓ to navigate, Esc to go back')}
          </Text>
        </Box>
      </>
    );
  }

  if (viewLevel === 'custom-base-url-input') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            {t('Enter the API endpoint for this protocol.')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            key="custom-base-url"
            value={state.baseUrl}
            onChange={onBaseUrlChange}
            onSubmit={onBaseUrlSubmit}
            placeholder="https://api.openai.com/v1"
          />
        </Box>
        {state.baseUrlError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{state.baseUrlError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Link url={documentationUrl} fallback={false}>
            <Text color={theme.text.link}>
              {t(
                'Need advanced generationConfig or capabilities? See documentation',
              )}
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

  if (viewLevel === 'custom-api-key-input') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            {t('Enter the API key for this endpoint.')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            key="custom-api-key"
            value={state.apiKey}
            onChange={onApiKeyChange}
            onSubmit={onApiKeySubmit}
            placeholder="sk-..."
          />
        </Box>
        {state.apiKeyError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{state.apiKeyError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Enter to submit, Esc to go back')}
          </Text>
        </Box>
      </Box>
    );
  }

  if (viewLevel === 'custom-model-id-input') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            {t('Enter one or more model IDs, separated by commas.')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            key="custom-model-ids"
            value={state.modelIds}
            onChange={onModelIdsChange}
            onSubmit={onModelIdsSubmit}
            placeholder="qwen/qwen3-coder,openai/gpt-4.1"
          />
        </Box>
        {state.modelIdsError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{state.modelIdsError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Enter to submit, Esc to go back')}
          </Text>
        </Box>
      </Box>
    );
  }

  if (viewLevel === 'custom-advanced-config') {
    const checkmark = (v: boolean) => (v ? '◉' : '○');
    const cursor = (index: number) =>
      state.focusedConfigIndex === index ? '›' : ' ';

    return (
      <Box marginTop={1} flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            {t('Optional: configure advanced generation settings.')}
          </Text>
        </Box>
        <Box marginTop={1} marginLeft={2}>
          <Text
            color={
              state.focusedConfigIndex === 0 ? theme.status.success : undefined
            }
          >
            {cursor(0)} {checkmark(state.thinkingEnabled)}{' '}
            {t('Enable thinking')}
          </Text>
        </Box>
        <Box marginTop={0} marginLeft={4}>
          <Text color={theme.text.secondary}>
            {t(
              'Allows the model to perform extended reasoning before responding.',
            )}
          </Text>
        </Box>
        <Box marginTop={1} marginLeft={2}>
          <Text
            color={
              state.focusedConfigIndex === 1 ? theme.status.success : undefined
            }
          >
            {cursor(1)} {checkmark(state.modalityEnabled)}{' '}
            {t('Enable modality')}
          </Text>
        </Box>
        <Box marginTop={0} marginLeft={4}>
          <Text color={theme.text.secondary}>
            {t('Enables image, video, and audio input/output capabilities.')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t(
              '\u2191\u2193 to navigate, Space to toggle, Enter to continue, Esc to go back',
            )}
          </Text>
        </Box>
      </Box>
    );
  }

  if (viewLevel === 'custom-review-json') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            {t('The following JSON will be saved to settings.json:')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text>{state.previewJson}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('Enter to save, Esc to go back')}
          </Text>
        </Box>
      </Box>
    );
  }

  return null;
}
