/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getProjectSummaryInfo,
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
      console.debug('Welcome back check failed:', error);
    }
  }, [settings.ui?.enableWelcomeBack]);

  // Handle welcome back dialog selection
  const handleWelcomeBackSelection = useCallback(
    (choice: 'restart' | 'continue') => {
      setWelcomeBackChoice(choice);
      setShowWelcomeBackDialog(false);

      if (choice === 'continue' && welcomeBackInfo?.content) {
        // Create the context message to fill in the input box
        const contextMessage = `@.qwen/PROJECT_SUMMARY.md, Based on our previous conversation,Let's continue?`;

        // Set the input fill state instead of directly submitting
        setInputFillText(contextMessage);
        setShouldFillInput(true);
      }
      // If choice is 'restart', just close the dialog and continue normally
    },
    [welcomeBackInfo],
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
