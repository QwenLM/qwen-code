/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { Config, ReasoningEffort } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import { t } from '../../i18n/index.js';

interface UseEffortCommandReturn {
  isEffortDialogOpen: boolean;
  openEffortDialog: () => void;
  handleEffortSelect: (effort: ReasoningEffort | undefined) => void;
}

export const useEffortCommand = (
  loadedSettings: LoadedSettings,
  config: Config,
  addItem?: (item: HistoryItemWithoutId, baseTimestamp: number) => void,
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
        // `setReasoningEffort` is a no-op when thinking is explicitly disabled
        // (`reasoning: false`). Mirror the slash-command path's read-back check
        // so the dialog doesn't silently close with nothing applied: the tier is
        // still persisted for future sessions, but tell the user it won't take
        // effect until thinking is re-enabled.
        if (addItem && config.getReasoningEffort() !== effort) {
          addItem(
            {
              type: MessageType.INFO,
              text: t(
                'Reasoning effort set to {{tier}}, but thinking is currently disabled — it will take effect when thinking is re-enabled.',
                { tier: effort },
              ),
            },
            Date.now(),
          );
        }
      } finally {
        setIsEffortDialogOpen(false);
      }
    },
    [config, loadedSettings, addItem],
  );

  return {
    isEffortDialogOpen,
    openEffortDialog,
    handleEffortSelect,
  };
};
