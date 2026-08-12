/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import {
  applyReasoningEffort,
  getModelReasoningControls,
  normalizeModelReasoningEffort,
  type Config,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  getOwnKeyScope,
  getPersistScopeForModelSelection,
} from '../../config/modelProvidersScope.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import { mergeModelReasoningPreference } from '../../config/model-reasoning-preferences.js';
import { formatEffortChangeMessage } from '../commands/effort-utils.js';

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
        const model = config.getModel();
        const registration = config.getActiveRuntimeModelSnapshot?.()
          ? undefined
          : getModelReasoningControls(model);
        const persistedRegistration = getModelReasoningControls(model);
        const effectiveEffort = registration?.effort
          ? normalizeModelReasoningEffort(registration, effort)!
          : effort;
        applyReasoningEffort(config, effectiveEffort);
        // Mirror the slash-command path: `model.reasoningPreferences` is
        // scoped independently from `modelProviders`, so persist to the scope
        // owning the `model` key to avoid shadowed writes.
        const scope =
          getOwnKeyScope(loadedSettings, 'model') ??
          getPersistScopeForModelSelection(loadedSettings);
        if (persistedRegistration?.effort) {
          loadedSettings.setValue(
            scope,
            'model.reasoningPreferences',
            mergeModelReasoningPreference(
              loadedSettings.forScope(scope).settings,
              model,
              { effort: effectiveEffort },
            ),
          );
        } else {
          loadedSettings.setValue(scope, 'model.reasoningEffort', effort);
        }
        // Report the outcome in-chat instead of silently closing (the status
        // line is the only other signal). `setReasoningEffort` is a no-op when
        // thinking is explicitly disabled (`reasoning: false`): the tier is
        // still persisted for future sessions, but say it won't take effect
        // until thinking is re-enabled.
        if (addItem) {
          addItem(
            {
              type: MessageType.INFO,
              text: formatEffortChangeMessage(config, effectiveEffort, effort),
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
