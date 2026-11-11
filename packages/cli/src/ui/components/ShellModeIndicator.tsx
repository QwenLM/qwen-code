/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useI18nService } from '../i18n/index.js';

export const ShellModeIndicator: React.FC = () => {
  const i18n = useI18nService();
  return (
    <Box>
      <Text color={theme.ui.symbol}>
        {i18n.get('status.shellMode')}
        <Text color={theme.text.secondary}>
          {i18n.get('status.shellModeDisable')}
        </Text>
      </Text>
    </Box>
  );
};
