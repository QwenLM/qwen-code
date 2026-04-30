/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { ApiKeyInput } from '../../components/ApiKeyInput.js';
import { DescriptiveRadioButtonSelect } from '../../components/shared/DescriptiveRadioButtonSelect.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import type { AlibabaModelStudioFlowProps } from './AuthFlowTypes.js';

export function AlibabaModelStudioFlow({
  viewLevel,
  items,
  baseUrlItems,
  baseUrlIndex,
  subscriptionApiKeyPlan,
  onSelect,
  onBaseUrlSelect,
  onBaseUrlHighlight,
  onApiKeySubmit,
  onBack,
}: AlibabaModelStudioFlowProps): React.JSX.Element | null {
  if (viewLevel === 'alibaba-modelstudio-select') {
    return (
      <>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={items}
            initialIndex={0}
            onSelect={onSelect}
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

  if (viewLevel === 'base-url-select') {
    return (
      <>
        <Box marginTop={1}>
          <Text color={theme.text.primary}>{t('Choose a Base URL')}</Text>
        </Box>
        <Box marginTop={1}>
          <DescriptiveRadioButtonSelect
            items={baseUrlItems}
            initialIndex={baseUrlIndex}
            onSelect={onBaseUrlSelect}
            onHighlight={onBaseUrlHighlight}
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

  if (viewLevel === 'api-key-input') {
    return (
      <Box marginTop={1}>
        <ApiKeyInput
          onSubmit={onApiKeySubmit}
          onCancel={onBack}
          plan={subscriptionApiKeyPlan}
        />
      </Box>
    );
  }

  return null;
}
