/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text } from 'ink';
import { useUIState } from '../contexts/UIStateContext.js';
import { theme } from '../semantic-colors.js';

export const ExitWarning: React.FC = () => {
  const uiState = useUIState();
  if (!uiState.dialogsVisible) {
    return null;
  }
  // No marginTop: a spacer row on top of a near-full dialog overflows the
  // terminal, Ink full-clears at stdout.rows, and the startup banner scrolls
  // off. Keep this to a single replacement row (matches Footer).
  if (uiState.ctrlCPressedOnce) {
    return (
      <Text color={theme.status.warning}>Press Ctrl+C again to exit.</Text>
    );
  }
  if (uiState.ctrlDPressedOnce) {
    return (
      <Text color={theme.status.warning}>Press Ctrl+D again to exit.</Text>
    );
  }
  return null;
};
