/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box } from 'ink';
import { Notifications } from '../components/Notifications.js';
import { MainContent } from '../components/MainContent.js';
import { DialogManager } from '../components/DialogManager.js';
import { Composer } from '../components/Composer.js';
import { ExitWarning } from '../components/ExitWarning.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

export const DefaultAppLayout: React.FC = () => {
  const uiState = useUIState();
  const { columns: terminalWidth } = useTerminalSize();

  return (
    <Box flexDirection="column" width={terminalWidth}>
      <MainContent />

      <Box flexDirection="column" ref={uiState.mainControlsRef}>
        <Notifications />

        {uiState.dialogsVisible ? (
          <Box marginX={2} flexDirection="column" width={uiState.mainAreaWidth}>
            <DialogManager
              terminalWidth={uiState.terminalWidth}
              addItem={uiState.historyManager.addItem}
            />
          </Box>
        ) : (
          <Composer />
        )}

        <ExitWarning />
      </Box>
    </Box>
  );
};
