/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, useIsScreenReaderEnabled } from 'ink';
import { useCallback, useState } from 'react';
import { LoadingIndicator } from './LoadingIndicator.js';
import { InputPrompt } from './InputPrompt.js';
import { Footer } from './Footer.js';
import { QueuedMessageDisplay } from './QueuedMessageDisplay.js';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { StreamingState } from '../types.js';
import { ConfigInitDisplay } from '../components/ConfigInitDisplay.js';
import { FeedbackDialog } from '../FeedbackDialog.js';
import { t } from '../../i18n/index.js';
import { useAnimationFrame } from '../hooks/useAnimationFrame.js';

export const Composer = () => {
  const config = useConfig();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const uiState = useUIState();
  const uiActions = useUIActions();
  const { vimEnabled } = useVimMode();

  const {
    showAutoAcceptIndicator,
    streamingResponseLengthRef,
    isReceivingContent,
  } = uiState;

  // --- Real-time token estimation ---
  // Poll streamingResponseLengthRef at 50ms; only re-renders when the value
  // actually changes, avoiding unnecessary empty renders.
  const isStreaming =
    uiState.streamingState === StreamingState.Responding ||
    uiState.streamingState === StreamingState.WaitingForConfirmation;
  const streamingChars = useAnimationFrame(
    streamingResponseLengthRef,
    isStreaming ? 50 : null,
  );
  const estimatedStreamingTokens = Math.round(streamingChars / 4);

  // Aggregate agent tool tokens from executing tool calls
  let agentTokens = 0;
  for (const item of uiState.pendingGeminiHistoryItems ?? []) {
    if (item.type === 'tool_group' && 'tools' in item) {
      const toolGroup = item as {
        tools: Array<{ resultDisplay?: { type: string; tokenCount?: number } }>;
      };
      for (const tool of toolGroup.tools) {
        if (
          tool.resultDisplay?.type === 'task_execution' &&
          tool.resultDisplay?.tokenCount
        ) {
          agentTokens += tool.resultDisplay.tokenCount;
        }
      }
    }
  }

  const taskTokens = estimatedStreamingTokens + agentTokens;

  // State for keyboard shortcuts display toggle
  const [showShortcuts, setShowShortcuts] = useState(false);
  const handleToggleShortcuts = useCallback(() => {
    setShowShortcuts((prev) => !prev);
  }, []);

  // State for suggestions visibility
  const [showSuggestions, setShowSuggestions] = useState(false);
  const handleSuggestionsVisibilityChange = useCallback(
    (visible: boolean) => {
      setShowSuggestions(visible);
      // Also notify AppContainer for Tab key handling
      uiActions.onSuggestionsVisibilityChange(visible);
    },
    [uiActions],
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      {!uiState.embeddedShellFocused && (
        <LoadingIndicator
          // Hide loading phrases when enableLoadingPhrases is explicitly false.
          // Using === false ensures phrases show by default when undefined.
          thought={
            uiState.streamingState === StreamingState.WaitingForConfirmation ||
            config.getAccessibility()?.enableLoadingPhrases === false
              ? undefined
              : uiState.thought
          }
          currentLoadingPhrase={
            config.getAccessibility()?.enableLoadingPhrases === false
              ? undefined
              : uiState.currentLoadingPhrase
          }
          elapsedTime={uiState.elapsedTime}
          candidatesTokens={taskTokens}
          isReceivingContent={isReceivingContent}
        />
      )}

      {!uiState.isConfigInitialized && <ConfigInitDisplay />}

      <QueuedMessageDisplay messageQueue={uiState.messageQueue} />

      {uiState.isFeedbackDialogOpen && <FeedbackDialog />}

      {uiState.isInputActive && (
        <InputPrompt
          buffer={uiState.buffer}
          inputWidth={uiState.inputWidth}
          suggestionsWidth={uiState.suggestionsWidth}
          onSubmit={uiActions.handleFinalSubmit}
          userMessages={uiState.userMessages}
          onClearScreen={uiActions.handleClearScreen}
          config={config}
          slashCommands={uiState.slashCommands}
          commandContext={uiState.commandContext}
          shellModeActive={uiState.shellModeActive}
          setShellModeActive={uiActions.setShellModeActive}
          approvalMode={showAutoAcceptIndicator}
          onEscapePromptChange={uiActions.onEscapePromptChange}
          onToggleShortcuts={handleToggleShortcuts}
          showShortcuts={showShortcuts}
          onSuggestionsVisibilityChange={handleSuggestionsVisibilityChange}
          focus={true}
          vimHandleInput={uiActions.vimHandleInput}
          isEmbeddedShellFocused={uiState.embeddedShellFocused}
          placeholder={
            vimEnabled
              ? '  ' + t("Press 'i' for INSERT mode and 'Esc' for NORMAL mode.")
              : '  ' + t('Type your message or @path/to/file')
          }
          promptSuggestion={uiState.promptSuggestion}
          onPromptSuggestionDismiss={uiState.dismissPromptSuggestion}
        />
      )}

      {/* Exclusive area: only one component visible at a time */}
      {/* Hide footer when a confirmation dialog (e.g. ask_user_question) is active */}
      {uiState.isInputActive &&
        !showSuggestions &&
        (showShortcuts ? (
          <KeyboardShortcuts />
        ) : (
          !isScreenReaderEnabled && <Footer />
        ))}
    </Box>
  );
};
