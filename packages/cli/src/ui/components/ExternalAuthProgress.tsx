/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

interface ExternalAuthProgressProps {
  title: string;
  message: string;
  detail?: string;
}

export function ExternalAuthProgress({
  title,
  message,
  detail,
}: ExternalAuthProgressProps): React.JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{title}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text>{message}</Text>
        {detail ? <Text color={theme.text.secondary}>{detail}</Text> : null}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Please wait while authentication completes...')}
        </Text>
      </Box>
    </Box>
  );
}
