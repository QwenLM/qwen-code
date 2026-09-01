/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import {
  applyOutputStyleSelection,
  resolveOutputStyleChoice,
} from '../commands/output-style-utils.js';

const debugLogger = createDebugLogger('OUTPUT_STYLE_COMMAND');

interface UseOutputStyleCommandReturn {
  isOutputStyleDialogOpen: boolean;
  openOutputStyleDialog: () => void;
  handleOutputStyleSelect: (styleName: string | undefined) => void;
}

export const useOutputStyleCommand = (
  loadedSettings: LoadedSettings,
  config: Config,
  addItem?: (item: HistoryItemWithoutId, baseTimestamp: number) => void,
): UseOutputStyleCommandReturn => {
  const [isOutputStyleDialogOpen, setIsOutputStyleDialogOpen] = useState(false);

  const openOutputStyleDialog = useCallback(() => {
    setIsOutputStyleDialogOpen(true);
  }, []);

  const handleOutputStyleSelect = useCallback(
    (styleName: string | undefined) => {
      // Close first: the apply below rebuilds the system instruction, and the
      // dialog should not sit open while that runs.
      setIsOutputStyleDialogOpen(false);
      if (styleName === undefined) {
        // User cancelled the dialog — leave the current style unchanged.
        return;
      }
      const style = resolveOutputStyleChoice(styleName);
      if (style === null) {
        // The dialog only offers known names; this is unreachable in practice.
        return;
      }
      void (async () => {
        try {
          const message = await applyOutputStyleSelection(
            config,
            loadedSettings,
            style,
          );
          if (addItem) {
            const feedbackItem: HistoryItemWithoutId & Record<string, unknown> =
              {
                type: MessageType.INFO,
                text: message,
              };
            addItem(feedbackItem, Date.now());
            config.getChatRecordingService?.()?.recordSlashCommand({
              phase: 'result',
              rawCommand: '/output-style',
              outputHistoryItems: [feedbackItem],
            });
          }
        } catch (error) {
          debugLogger.warn('Failed to apply output style:', error);
        }
      })();
    },
    [config, loadedSettings, addItem],
  );

  return {
    isOutputStyleDialogOpen,
    openOutputStyleDialog,
    handleOutputStyleSelect,
  };
};
