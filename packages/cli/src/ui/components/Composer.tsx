/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text, useIsScreenReaderEnabled, type DOMElement } from 'ink';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { LoadingIndicator } from './LoadingIndicator.js';
import { InputPrompt } from './InputPrompt.js';
import { Footer } from './Footer.js';
import { QueuedMessageDisplay } from './QueuedMessageDisplay.js';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useVimModeState } from '../contexts/VimModeContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { theme } from '../semantic-colors.js';
import { StreamingState } from '../types.js';
import { FeedbackDialog } from '../FeedbackDialog.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { useModBand } from '../hooks/use-mod-band.js';
import { ModBand } from './ModBand.js';
import { modBandMaxRows } from '../utils/mod-band-tree.js';
import { t } from '../../i18n/index.js';

interface ComposerProps {
  footerRef?: RefObject<DOMElement | null>;
}

export const Composer = ({ footerRef }: ComposerProps) => {
  const config = useConfig();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const uiState = useUIState();
  const subscriptionActive =
    config.getAuthType() === AuthType.QWEN_SUBSCRIPTION;
  const uiActions = useUIActions();
  const { vimEnabled } = useVimModeState();
  const modBand = useModBand(config);

  const {
    showAutoAcceptIndicator,
    streamingResponseLengthRef,
    isReceivingContent,
    responseCandidateTokens,
    taskStartTokens,
    taskStartStreamingChars,
  } = uiState;

  // Real-time token animation is performed inside LoadingIndicator itself, so
  // the 100ms polling only re-renders that one component — keeping InputPrompt
  // and Footer static avoids terminal flicker during streaming.
  const isStreaming =
    uiState.streamingState === StreamingState.Responding ||
    uiState.streamingState === StreamingState.WaitingForConfirmation;
  // `isStreaming` covers Responding|WaitingForConfirmation, but we only
  // suppress during Responding (active token output). A confirmation prompt
  // must remain visible regardless of width. Drop the redundant `isStreaming`
  // guard so future expansions of `isStreaming` don't silently widen suppression.
  const suppressBottomLoadingIndicator =
    uiState.streamingState === StreamingState.Responding &&
    uiState.terminalWidth <= 30;

  const { subscriptionHintsDismissed } = uiState;
  const { dismissSubscriptionHints } = uiActions;
  const lastSubscriptionLogin = uiState.history.findLastIndex(
    (item) =>
      item.type === 'info' && item.presentation === 'subscription-success',
  );
  const hasPriorInput = uiState.history
    .slice(lastSubscriptionLogin + 1)
    .some((item) => item.type === 'user' && item.text.trim() !== '/auth');
  const hasInput = uiState.buffer.text.length > 0;
  useEffect(() => {
    if (subscriptionActive && (hasInput || hasPriorInput || isStreaming)) {
      dismissSubscriptionHints();
    }
  }, [
    subscriptionActive,
    hasInput,
    hasPriorInput,
    isStreaming,
    dismissSubscriptionHints,
  ]);

  // State for keyboard shortcuts display toggle
  const [showShortcuts, setShowShortcuts] = useState(false);
  const handleToggleShortcuts = useCallback(() => {
    setShowShortcuts((prev) => !prev);
  }, []);

  // State for autocomplete-dropdown visibility (narrow signal). Drives the
  // Footer / KeyboardShortcuts hide-when-dropdown-visible logic below; kept
  // local to Composer because nothing outside this component needs the
  // narrow signal.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const clipboardUnavailableShownRef = useRef(false);

  // Broad signal — any input-area Tab consumer. Forwarded to AppContainer
  // via UIActionsContext so useAutoAcceptIndicator's `shouldBlockTab` can
  // suppress the Windows-only bare-Tab approval-mode fallback. See #4171.
  const handleTabConsumerChange = useCallback(
    (active: boolean) => {
      uiActions.onTabConsumerChange(active);
    },
    [uiActions],
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      {!uiState.embeddedShellFocused && !suppressBottomLoadingIndicator && (
        <LoadingIndicator
          // Hide loading phrases when enableLoadingPhrases is explicitly false.
          // Using === false ensures phrases show by default when undefined.
          currentLoadingPhrase={
            config.getAccessibility()?.enableLoadingPhrases === false
              ? undefined
              : uiState.currentLoadingPhrase
          }
          elapsedTime={uiState.elapsedTime}
          candidatesTokens={responseCandidateTokens}
          taskStartTokens={taskStartTokens}
          taskStartStreamingChars={taskStartStreamingChars}
          streamingCharsRef={streamingResponseLengthRef}
          isStreaming={isStreaming}
          showResponseTokensPerSecond={config.getShowResponseTokensPerSecond()}
          isReceivingContent={isReceivingContent}
        />
      )}
      {/*
       * Narrow-terminal fallback: when the full LoadingIndicator is suppressed
       * (≤30 cols, actively Responding) we still surface a minimal `esc to
       * cancel` hint so users on ultra-narrow terminals retain the cancel
       * affordance during long-running calls. The full timer/spinner/phrase
       * UI is still suppressed to avoid layout breakage.
       */}
      {!uiState.embeddedShellFocused && suppressBottomLoadingIndicator && (
        <Box paddingLeft={2}>
          <Text color={theme.text.secondary}>({t('Esc to cancel')})</Text>
        </Box>
      )}

      <QueuedMessageDisplay messageQueue={uiState.messageQueue} />

      {uiState.isFeedbackDialogOpen && <FeedbackDialog />}

      {uiState.isInputActive && (
        <ModBand
          band={modBand}
          maxRows={modBandMaxRows(uiState.terminalHeight)}
        />
      )}

      {uiState.isInputActive && (
        <InputPrompt
          buffer={uiState.buffer}
          pendingPastes={uiState.pendingPastes}
          onPendingPastesChange={uiActions.setPendingPastes}
          inputWidth={uiState.inputWidth}
          suggestionsWidth={uiState.suggestionsWidth}
          onSubmit={(text, options) => {
            if (subscriptionActive) dismissSubscriptionHints();
            uiActions.handleFinalSubmit(text, options);
          }}
          userMessages={uiState.userMessages}
          onClearScreen={uiActions.handleClearScreen}
          config={config}
          slashCommands={uiState.slashCommands}
          commandContext={uiState.commandContext}
          recentSlashCommands={uiState.recentSlashCommands}
          shellModeActive={uiState.shellModeActive}
          setShellModeActive={uiActions.setShellModeActive}
          approvalMode={showAutoAcceptIndicator}
          onEscapePromptChange={uiActions.onEscapePromptChange}
          onToggleShortcuts={handleToggleShortcuts}
          showShortcuts={showShortcuts}
          onSuggestionsVisibilityChange={setShowSuggestions}
          onTabConsumerChange={handleTabConsumerChange}
          focus={true}
          vimHandleInput={uiActions.vimHandleInput}
          isEmbeddedShellFocused={uiState.embeddedShellFocused}
          placeholder={
            vimEnabled
              ? '  ' + t("Press 'i' for INSERT mode and 'Esc' for NORMAL mode.")
              : '  ' +
                t(
                  subscriptionActive
                    ? 'Type your request, or /usage'
                    : 'Type your message or @path/to/file',
                )
          }
          promptSuggestion={uiState.promptSuggestion}
          onPromptSuggestionDismiss={uiState.abortPromptSuggestion}
          clipboardUnavailableShownRef={clipboardUnavailableShownRef}
          voiceMicWarnedStatusRef={uiState.voiceMicWarnedStatusRef}
        />
      )}

      {uiState.isInputActive &&
        subscriptionActive &&
        !subscriptionHintsDismissed &&
        !hasPriorInput &&
        !hasInput &&
        !showSuggestions &&
        !isStreaming && (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {t('Try:')}
              {'  '}
            </Text>
            <Text>
              <Text color={theme.text.link} underline>
                /usage
              </Text>
              {'  '}
              <Text color={theme.text.link} underline>
                /status
              </Text>
              {'  '}
              <Text color={theme.text.link} underline>
                /upgrade
              </Text>
              {'  '}
              <Text color={theme.text.link} underline>
                /logout
              </Text>
            </Text>
          </Box>
        )}

      {/* Exclusive area: only one component visible at a time */}
      {/* Hide footer when a confirmation dialog (e.g. ask_user_question) is active */}
      {/* The footer is the only production consumer of useConfigInitMessage,
          which returns a message exactly while initialization is pending — so
          it has to mount on that window too, or startup shows no progress at
          all. InputPrompt stays gated on isInputActive alone. */}
      {(uiState.isInputActive || !uiState.isConfigInitialized) &&
        !showSuggestions &&
        (showShortcuts ? (
          <KeyboardShortcuts />
        ) : (
          !isScreenReaderEnabled && <Footer containerRef={footerRef} />
        ))}
    </Box>
  );
};
