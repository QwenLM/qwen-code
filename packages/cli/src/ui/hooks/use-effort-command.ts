/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { Config, ReasoningEffort } from '@qwen-code/qwen-code-core';
import {
  applyReasoningEffort,
  resolveModelReasoningConfiguration,
  supportsGenericReasoningEffort,
  usesMandatoryReasoningDefaultOnly,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { getPersistScopeForModelSelection } from '../../config/modelProvidersScope.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
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
        const generation = config.getContentGeneratorConfig?.();
        if (
          generation &&
          usesMandatoryReasoningDefaultOnly({
            modelId: config.getModel?.(),
            authType: generation.authType,
            baseUrl: generation.baseUrl,
            thinkingMandatory: generation.thinkingMandatory,
          })
        ) {
          return;
        }
        const reasoning = resolveModelReasoningConfiguration({
          modelId: config.getModel?.(),
          authType: generation?.authType ?? config.getAuthType?.(),
          baseUrl:
            generation?.baseUrl ??
            config.getCurrentModelRegistryBaseUrl?.() ??
            undefined,
        });
        if (
          reasoning?.toggleOnly ||
          (reasoning && !reasoning.efforts.includes(effort)) ||
          (!reasoning && !supportsGenericReasoningEffort(config.getModel?.()))
        ) {
          return;
        }
        // Apply at runtime (next turn) and persist for future sessions; provider
        // adapters clamp the tier to what the active model supports.
        applyReasoningEffort(config, effort);
        loadedSettings.setValue(
          getPersistScopeForModelSelection(loadedSettings),
          'model.reasoningEffort',
          effort,
        );
        // Report the outcome in-chat instead of silently closing (the status
        // line is the only other signal). The setter no-ops when thinking is
        // explicitly disabled (`reasoning: false`): the tier is still persisted
        // for future sessions, but say it won't take effect until thinking is
        // re-enabled.
        if (addItem) {
          const feedbackItem: HistoryItemWithoutId & Record<string, unknown> = {
            type: MessageType.INFO,
            text: formatEffortChangeMessage(config, effort),
          };
          addItem(feedbackItem, Date.now());
          config.getChatRecordingService?.()?.recordSlashCommand({
            phase: 'result',
            rawCommand: '/effort',
            outputHistoryItems: [feedbackItem],
          });
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
