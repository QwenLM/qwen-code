/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import { useKeypress } from '../hooks/useKeypress.js';

interface ExternalAuthProgressProps {
  title: string;
  message: string;
  detail?: string;
  onCancel?: () => void;
}

export function ExternalAuthProgress({
  title,
  message,
  detail,
  onCancel,
}: ExternalAuthProgressProps): React.JSX.Element {
  useKeypress(
    (key) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        onCancel?.();
      }
    },
    { isActive: Boolean(onCancel) },
  );

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

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('Please wait while authentication completes...')}
        </Text>
        {onCancel ? (
          <Text color={theme.text.secondary}>{t('Esc to cancel')}</Text>
        ) : null}
      </Box>
    </Box>
  );
}
