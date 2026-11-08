/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import {
  Storage,
  isDebugLogFileEnabled,
  isDebugLoggingDegraded,
} from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { theme } from '../semantic-colors.js';

/**
 * Displays debug mode status and log file path when debug mode is enabled.
 */
export const DebugModeNotification = () => {
  const config = useConfig();

  if (!config.getDebugMode()) {
    return null;
  }

  const isFileLoggingEnabled = isDebugLogFileEnabled();
  const isDegraded = isDebugLoggingDegraded();

  return (
    <Box paddingX={1} marginTop={1} flexDirection="column">
      <Text color={theme.status.warning}>Debug mode enabled</Text>
      {isFileLoggingEnabled ? (
        <Text dimColor>
          Logging to: {Storage.getDebugLogPath(config.getSessionId())}
        </Text>
      ) : (
        <Text dimColor>Debug log file disabled by QWEN_DEBUG_LOG_FILE</Text>
      )}
      {isDegraded && (
        <Text dimColor>
          Warning: Debug logging is degraded (write failures occurred)
        </Text>
      )}
    </Box>
  );
};
