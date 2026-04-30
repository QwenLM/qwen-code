/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { DescriptiveRadioButtonSelect } from '../../components/shared/DescriptiveRadioButtonSelect.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import type { OAuthFlowProps } from './AuthFlowTypes.js';

export function OAuthFlow({
  items,
  initialIndex,
  onSelect,
  onHighlight,
}: OAuthFlowProps): React.JSX.Element {
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
