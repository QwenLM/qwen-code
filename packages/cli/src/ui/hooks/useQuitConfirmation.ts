/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { QuitChoice } from '../components/QuitConfirmationDialog.js';

export const useQuitConfirmation = () => {
  const [isQuitConfirmationOpen, setIsQuitConfirmationOpen] = useState(false);

  const showQuitConfirmation = useCallback(() => {
    setIsQuitConfirmationOpen(true);
  }, []);

  const handleQuitConfirmationSelect = useCallback((choice: QuitChoice) => {
    setIsQuitConfirmationOpen(false);

    if (choice === QuitChoice.CANCEL) {
      return { shouldQuit: false, action: 'cancel' };
    } else if (choice === QuitChoice.QUIT) {
      return { shouldQuit: true, action: 'quit' };
    } else if (choice === QuitChoice.SAVE_AND_QUIT) {
      return { shouldQuit: true, action: 'save_and_quit' };
    } else if (choice === QuitChoice.SUMMARY_AND_QUIT) {
      return { shouldQuit: true, action: 'summary_and_quit' };
    }

    // Default to cancel if unknown choice
    return { shouldQuit: false, action: 'cancel' };
  }, []);

  return {
    isQuitConfirmationOpen,
    showQuitConfirmation,
    handleQuitConfirmationSelect,
  };
};
