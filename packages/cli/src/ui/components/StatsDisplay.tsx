/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

interface StatsDisplayProps {
  duration: string;
  title?: string;
}

export const StatsDisplay: React.FC<StatsDisplayProps> = ({
  duration,
  title,
}) => (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
    >
      <Text bold color={theme.text.accent}>
        {title || t('Session Stats')}
      </Text>
      <Box height={1} />
      <Text color={theme.text.primary}>
        {t('Session stats are disabled in this build.')}
      </Text>
      <Box height={1} />
      <Text color={theme.text.secondary}>Duration: {duration}</Text>
    </Box>
  );
