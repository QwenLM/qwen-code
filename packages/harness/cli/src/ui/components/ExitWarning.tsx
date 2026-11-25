/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { useUIState } from '../contexts/UIStateContext.js';
import { theme } from '../semantic-colors.js';
import { useI18nService } from '../i18n/index.js';

export const ExitWarning: React.FC = () => {
  const uiState = useUIState();
  const i18n = useI18nService();
  return (
    <>
      {uiState.dialogsVisible && uiState.ctrlCPressedOnce && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            {i18n.get('status.exitWarning', { shortcut: 'Ctrl+C' })}
          </Text>
        </Box>
      )}

      {uiState.dialogsVisible && uiState.ctrlDPressedOnce && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            {i18n.get('status.exitWarning', { shortcut: 'Ctrl+D' })}
          </Text>
        </Box>
      )}
    </>
  );
};
