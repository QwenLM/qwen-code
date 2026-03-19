/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import React from 'react';
import { useAppContext } from '../contexts/AppContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { theme } from '../semantic-colors.js';
import { StreamingState } from '../types.js';
import { UpdateNotification } from './UpdateNotification.js';

// Check if a warning is a home directory warning (less severe)
const isHomeDirectoryWarning = (warning: string): boolean => {
  return warning.includes('running Qwen Code in your home directory');
};

// Check if a warning is a root directory warning (more severe)
const isRootDirectoryWarning = (warning: string): boolean => {
  return warning.includes('running Qwen Code in the root directory');
};

export const Notifications = () => {
  const { startupWarnings } = useAppContext();
  const { initError, streamingState, updateInfo, startupWarningsDismissed } = useUIState();
  const { dismissStartupWarnings } = useUIActions();

  // Filter out dismissed warnings
  const visibleWarnings = startupWarningsDismissed 
    ? [] 
    : startupWarnings;

  const showStartupWarnings = visibleWarnings.length > 0;
  const showInitError =
    initError && streamingState !== StreamingState.Responding;

  return (
    <>
      {updateInfo && <UpdateNotification message={updateInfo.message} />}
      {showStartupWarnings && (
        <Box
          borderStyle="round"
          borderColor={theme.status.warning}
          paddingX={1}
          marginY={1}
          flexDirection="column"
        >
          {visibleWarnings.map((warning, index) => {
            // Use different styling for home directory warnings (info level)
            const isHomeDir = isHomeDirectoryWarning(warning);
            const isRootDir = isRootDirectoryWarning(warning);

            return (
              <Text
                key={index}
                color={isHomeDir ? theme.status.warningDim : theme.status.warning}
              >
                {isHomeDir ? 'ℹ ' : isRootDir ? '⚠ ' : ''}
                {warning}
              </Text>
            );
          })}
          <Text dimColor>
            {' '}
            Press `Esc` to dismiss
          </Text>
        </Box>
      )}
      {showInitError && (
        <Box
          borderStyle="round"
          borderColor={theme.status.error}
          paddingX={1}
          marginBottom={1}
        >
          <Text color={theme.status.error}>
            Initialization Error: {initError}
          </Text>
          <Text color={theme.status.error}>
            {' '}
            Please check API key and configuration.
          </Text>
        </Box>
      )}
    </>
  );
};
