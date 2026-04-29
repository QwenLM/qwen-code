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
import { Footer } from '../components/Footer.js';
import { ExitWarning } from '../components/ExitWarning.js';
import { StickyTodoList } from '../components/StickyTodoList.js';
import { BtwMessage } from '../components/messages/BtwMessage.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { StreamingState } from '../types.js';

export const ScreenReaderAppLayout: React.FC = () => {
  const uiState = useUIState();
  const stickyTodoWidth = Math.min(uiState.mainAreaWidth, 64);
  const shouldShowStickyTodos =
    uiState.stickyTodos !== null &&
    !uiState.dialogsVisible &&
    !uiState.isFeedbackDialogOpen &&
    uiState.streamingState !== StreamingState.WaitingForConfirmation;

  return (
    <Box flexDirection="column" width="90%" height="100%">
      <Notifications />
      <Footer />
      <Box flexGrow={1} overflow="hidden">
        <MainContent />
      </Box>

      {uiState.dialogsVisible ? (
        <Box marginX={2} flexDirection="column" width={uiState.mainAreaWidth}>
          <DialogManager
            terminalWidth={uiState.terminalWidth}
            addItem={uiState.historyManager.addItem}
          />
        </Box>
      ) : (
        <>
          {shouldShowStickyTodos && (
            <StickyTodoList
              todos={uiState.stickyTodos!}
              width={stickyTodoWidth}
            />
          )}
          {uiState.btwItem && (
            <Box marginX={2} width={uiState.mainAreaWidth}>
              <BtwMessage
                btw={uiState.btwItem.btw}
                containerWidth={uiState.mainAreaWidth}
              />
            </Box>
          )}
          <Composer />
        </>
      )}

      <ExitWarning />
    </Box>
  );
};
