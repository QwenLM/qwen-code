/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { MainContent } from '../components/MainContent.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useFlickerDetector } from '../hooks/useFlickerDetector.js';
import { useAlternateBuffer } from '../hooks/useAlternateBuffer.js';
import { QuittingDisplay } from '../components/QuittingDisplay.js';
import { theme } from '../semantic-colors.js';
import { Command } from '../key/keyBindings.js';
import { formatCommand } from '../key/keybindingUtils.js';
import { useI18nService } from '../i18n/index.js';
import {
  DialogContextBridge,
  MainControls,
} from '../components/MainControls.js';

const transcriptToggleKey = formatCommand(Command.SHOW_MORE_LINES);

export const DefaultAppLayout: React.FC = () => {
  const uiState = useUIState();
  const i18n = useI18nService();
  const isAlternateBuffer = useAlternateBuffer();

  const { rootUiRef, terminalHeight } = uiState;
  useFlickerDetector(rootUiRef, terminalHeight);

  // Full-screen dialog mode: replaces the entire layout.
  // No height constraint — content flows into native terminal scrollback.
  // Used by /diff file detail view to allow unlimited-height diff rendering.
  if (uiState.fullScreenDialog && !uiState.quittingMessages) {
    return (
      <Box
        flexDirection="column"
        width={uiState.terminalWidth}
        flexShrink={0}
        flexGrow={0}
        ref={uiState.rootUiRef}
      >
        <DialogContextBridge>{uiState.fullScreenDialog}</DialogContextBridge>
      </Box>
    );
  }

  // If in alternate buffer mode, need to leave room to draw the scrollbar on
  // the right side of the terminal.
  return (
    <Box
      flexDirection="column"
      width={uiState.terminalWidth}
      height={isAlternateBuffer ? terminalHeight : undefined}
      paddingBottom={isAlternateBuffer ? 1 : undefined}
      flexShrink={0}
      flexGrow={0}
      ref={uiState.rootUiRef}
    >
      <MainContent />

      {uiState.quittingMessages ? (
        <QuittingDisplay />
      ) : uiState.conversationScreen === 'transcript' ? (
        <Box paddingX={1} marginTop={1}>
          <Text color={theme.text.secondary}>
            {i18n.get('status.transcript.showing', {
              shortcut: transcriptToggleKey,
            })}
          </Text>
        </Box>
      ) : (
        <MainControls uiState={uiState} />
      )}
    </Box>
  );
};
