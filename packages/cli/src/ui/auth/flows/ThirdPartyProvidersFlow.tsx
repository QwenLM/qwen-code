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
import type { ThirdPartyProvidersFlowProps } from './AuthFlowTypes.js';

export function ThirdPartyProvidersFlow({
  viewLevel,
  items,
  initialIndex,
  preset,
  onSelect,
  onHighlight,
  onEndpointOptionSelect,
  onEndpointOptionHighlight,
  onApiKeyChange,
  onApiKeySubmit,
  onModelIdChange,
  onModelSubmit,
}: ThirdPartyProvidersFlowProps): React.JSX.Element | null {
  if (viewLevel === 'api-key-type-select') {
    return (
      <>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={items}
            initialIndex={initialIndex}
            onSelect={onSelect}
            onHighlight={onHighlight}
            itemGap={1}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={theme?.text?.secondary}>
            {t('Enter to select, ↑↓ to navigate, Esc to go back')}
          </Text>
        </Box>
      </>
    );
  }

  if (viewLevel === 'preset-api-key-endpoint-select') {
    return (
      <>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={preset.endpointOptionItems}
            initialIndex={preset.endpointOptionIndex}
            onSelect={onEndpointOptionSelect}
            onHighlight={onEndpointOptionHighlight}
            itemGap={1}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={theme?.text?.secondary}>
            {t('Enter to select, ↑↓ to navigate, Esc to go back')}
          </Text>
        </Box>
      </>
    );
  }

  if (viewLevel === 'preset-api-key-input') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>Endpoint: {preset.endpoint}</Text>
        </Box>
        {preset.documentationUrl && (
          <>
            <Box marginTop={1}>
              <Text color={theme.text.secondary}>{t('Documentation')}:</Text>
            </Box>
            <Box marginTop={0}>
              <Link url={preset.documentationUrl} fallback={false}>
                <Text color={theme.text.link}>{preset.documentationUrl}</Text>
              </Link>
            </Box>
          </>
        )}
        <Box marginTop={1}>
          <TextInput
            value={preset.apiKey}
            onChange={onApiKeyChange}
            onSubmit={onApiKeySubmit}
            placeholder="sk-..."
          />
        </Box>
        {preset.apiKeyError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{preset.apiKeyError}</Text>
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

  if (viewLevel === 'preset-model-id-input') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t(
              'You can enter multiple model IDs, separated by commas. Examples: {{modelIds}}',
              { modelIds: preset.providerDefaultModelIds },
            )}
          </Text>
        </Box>
        <Box marginTop={1}>
          <TextInput
            value={preset.modelId}
            onChange={onModelIdChange}
            onSubmit={onModelSubmit}
            placeholder={preset.providerDefaultModelIds}
          />
        </Box>
        {preset.modelIdError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{preset.modelIdError}</Text>
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

  return null;
}
