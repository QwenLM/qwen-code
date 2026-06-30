/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { Config, ReasoningEffort } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';

interface UseEffortCommandReturn {
  isEffortDialogOpen: boolean;
  openEffortDialog: () => void;
  handleEffortSelect: (effort: ReasoningEffort | undefined) => void;
}

export const useEffortCommand = (
  loadedSettings: LoadedSettings,
  config: Config,
): UseEffortCommandReturn => {
  const [isEffortDialogOpen, setIsEffortDialogOpen] = useState(false);

  const openEffortDialog = useCallback(() => {
    setIsEffortDialogOpen(true);
  }, []);

  const handleEffortSelect = useCallback(
    (effort: ReasoningEffort | undefined) => {
      try {
        if (!effort) {
          // User cancelled the dialog — leave the current effort unchanged.
          return;
        }
        // Apply at runtime (next turn) and persist for future sessions; provider
        // adapters clamp the tier to what the active model supports.
        config.setReasoningEffort(effort);
        loadedSettings.setValue(
          getPersistScopeForModelSelection(loadedSettings),
          'model.reasoningEffort',
          effort,
        );
      } finally {
        setIsEffortDialogOpen(false);
      }
    },
    [config, loadedSettings],
  );

  return {
    isEffortDialogOpen,
    openEffortDialog,
    handleEffortSelect,
  };
};
