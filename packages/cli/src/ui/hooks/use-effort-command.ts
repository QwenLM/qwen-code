/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import {
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
import { t } from '../../i18n/index.js';
import { mergeModelReasoningPreference } from '../../config/model-reasoning-preferences.js';

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
        config.setReasoningEffort(effectiveEffort);
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
        // Mirror the slash-command path's read-back so the dialog reports the
        // outcome in-chat instead of silently closing (the status line is the
        // only other signal). `setReasoningEffort` is a no-op when thinking is
        // explicitly disabled (`reasoning: false`): the tier is still persisted
        // for future sessions, but say it won't take effect until thinking is
        // re-enabled; otherwise confirm the requested tier.
        if (addItem) {
          if (config.getReasoningEffort() !== effectiveEffort) {
            addItem(
              {
                type: MessageType.INFO,
                text: t(
                  'Reasoning effort set to {{tier}}, but thinking is currently disabled — it will take effect when thinking is re-enabled.',
                  { tier: effectiveEffort },
                ),
              },
              Date.now(),
            );
          } else {
            addItem(
              {
                type: MessageType.INFO,
                text:
                  effectiveEffort === effort
                    ? t(
                        'Reasoning effort: {{tier}} (requested; the effective tier depends on the active provider/model).',
                        { tier: effort },
                      )
                    : t(
                        'Reasoning effort: {{tier}} (normalized from {{requested}} for the active model).',
                        { tier: effectiveEffort, requested: effort },
                      ),
              },
              Date.now(),
            );
          }
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
