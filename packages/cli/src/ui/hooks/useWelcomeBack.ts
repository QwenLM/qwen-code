/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getProjectSummaryInfo,
  SessionService,
  type ProjectSummaryInfo,
  type Config,
} from '@qwen-code/qwen-code-core';
import { type Settings } from '../../config/settingsSchema.js';

export interface WelcomeBackState {
  welcomeBackInfo: ProjectSummaryInfo | null;
  showWelcomeBackDialog: boolean;
  welcomeBackChoice: 'restart' | 'continue' | null;
  shouldFillInput: boolean;
  inputFillText: string | null;
}

export interface WelcomeBackActions {
  handleWelcomeBackSelection: (choice: 'restart' | 'continue') => void;
  handleWelcomeBackClose: () => void;
  checkWelcomeBack: () => Promise<void>;
  clearInputFill: () => void;
}

export function useWelcomeBack(
  config: Config,
  submitQuery: (query: string) => void,
  buffer: { setText: (text: string) => void },
  settings: Settings,
  handleResume?: (sessionId: string) => Promise<boolean>,
): WelcomeBackState & WelcomeBackActions {
  const [welcomeBackInfo, setWelcomeBackInfo] =
    useState<ProjectSummaryInfo | null>(null);
  const [showWelcomeBackDialog, setShowWelcomeBackDialog] = useState(false);
  const [welcomeBackChoice, setWelcomeBackChoice] = useState<
    'restart' | 'continue' | null
  >(null);
  const [shouldFillInput, setShouldFillInput] = useState(false);
  const [inputFillText, setInputFillText] = useState<string | null>(null);

  // Check for conversation history on startup
  const checkWelcomeBack = useCallback(async () => {
    // Check if welcome back is enabled in settings
    if (settings.ui?.enableWelcomeBack === false) {
      return;
    }

    try {
      const info = await getProjectSummaryInfo();
      if (info.hasHistory) {
        setWelcomeBackInfo(info);
        setShowWelcomeBackDialog(true);
      }
    } catch (error) {
      // Silently ignore errors - welcome back is not critical
      config.getDebugLogger().debug('Welcome back check failed:', error);
    }
  }, [config, settings.ui?.enableWelcomeBack]);

  // Handle welcome back dialog selection
  const handleWelcomeBackSelection = useCallback(
    async (choice: 'restart' | 'continue') => {
      setWelcomeBackChoice(choice);
      setShowWelcomeBackDialog(false);

      if (choice === 'continue' && welcomeBackInfo?.content) {
        // Try to resume the most recent session for this project so the user
        // gets the actual conversation history back, not just the summary text.
        // If no session JSONL exists (e.g., PROJECT_SUMMARY.md was committed
        // without chat history), or if the listed session can't be loaded,
        // fall back to injecting the summary as context. handleResume returns
        // false when it short-circuits (e.g., loadSession returns nothing
        // because the file disappeared or has malformed lines), so we check
        // its result rather than treating any fulfilled call as success.
        let didResume = false;
        if (handleResume) {
          try {
            const sessionService = new SessionService(config.getTargetDir());
            const result = await sessionService.listSessions({ size: 1 });
            if (result.items.length > 0) {
              didResume = await handleResume(result.items[0].sessionId);
            }
          } catch (error) {
            config.getDebugLogger().debug('Welcome back resume failed:', error);
          }
        }

        if (!didResume) {
          // Create the context message to fill in the input box
          const contextMessage = `@.qwen/PROJECT_SUMMARY.md, Based on our previous conversation,Let's continue?`;

          // Set the input fill state instead of directly submitting
          setInputFillText(contextMessage);
          setShouldFillInput(true);
        }
      }
      // If choice is 'restart', just close the dialog and continue normally
    },
    [config, handleResume, welcomeBackInfo],
  );

  const handleWelcomeBackClose = useCallback(() => {
    setWelcomeBackChoice('restart'); // Default to restart when closed
    setShowWelcomeBackDialog(false);
  }, []);

  const clearInputFill = useCallback(() => {
    setShouldFillInput(false);
    setInputFillText(null);
  }, []);

  // Handle input filling from welcome back
  useEffect(() => {
    if (shouldFillInput && inputFillText) {
      buffer.setText(inputFillText);
      clearInputFill();
    }
  }, [shouldFillInput, inputFillText, buffer, clearInputFill]);

  // Check for welcome back on mount
  useEffect(() => {
    checkWelcomeBack();
  }, [checkWelcomeBack]);

  return {
    // State
    welcomeBackInfo,
    showWelcomeBackDialog,
    welcomeBackChoice,
    shouldFillInput,
    inputFillText,
    // Actions
    handleWelcomeBackSelection,
    handleWelcomeBackClose,
    checkWelcomeBack,
    clearInputFill,
  };
}
