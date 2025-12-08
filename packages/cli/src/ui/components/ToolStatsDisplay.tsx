/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

export const ToolStatsDisplay: React.FC = () => (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      paddingY={1}
      paddingX={2}
    >
      <Text color={theme.text.primary}>
        {t('Tool stats are disabled in this build.')}
      </Text>
    </Box>
  );
