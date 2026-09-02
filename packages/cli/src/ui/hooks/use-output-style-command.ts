/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef } from 'react';
import type { Config, OutputStyleDefinition } from '@qwen-code/qwen-code-core';
import {
  BUILT_IN_OUTPUT_STYLES,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import {
  applyOutputStyleSelection,
  loadSessionOutputStyles,
  resolveOutputStyleChoice,
} from '../commands/output-style-utils.js';

const debugLogger = createDebugLogger('OUTPUT_STYLE_COMMAND');

interface UseOutputStyleCommandReturn {
  isOutputStyleDialogOpen: boolean;
  /** The styles the open dialog offers; loaded from disk when it opens. */
  outputStyleChoices: readonly OutputStyleDefinition[];
  openOutputStyleDialog: () => void;
  handleOutputStyleSelect: (styleName: string | undefined) => void;
}

export const useOutputStyleCommand = (
  loadedSettings: LoadedSettings,
  config: Config,
  addItem?: (item: HistoryItemWithoutId, baseTimestamp: number) => void,
): UseOutputStyleCommandReturn => {
  const [isOutputStyleDialogOpen, setIsOutputStyleDialogOpen] = useState(false);
  const [outputStyleChoices, setOutputStyleChoices] = useState<
    readonly OutputStyleDefinition[]
  >(BUILT_IN_OUTPUT_STYLES);
  // The select handler resolves against the list the dialog showed, without
  // waiting on React state.
  const choicesRef = useRef<readonly OutputStyleDefinition[]>(
    BUILT_IN_OUTPUT_STYLES,
  );

  const openOutputStyleDialog = useCallback(() => {
    // Read the style files first so the picker opens complete rather than
    // growing custom entries a moment later.
    void (async () => {
      let choices: readonly OutputStyleDefinition[] = BUILT_IN_OUTPUT_STYLES;
      try {
        choices = await loadSessionOutputStyles(config);
      } catch (error) {
        debugLogger.warn('Failed to load custom output styles:', error);
      }
      choicesRef.current = choices;
      setOutputStyleChoices(choices);
      setIsOutputStyleDialogOpen(true);
    })();
  }, [config]);

  const report = useCallback(
    (type: MessageType.INFO | MessageType.ERROR, text: string) => {
      if (!addItem) {
        return;
      }
      const feedbackItem: HistoryItemWithoutId & Record<string, unknown> = {
        type,
        text,
      };
      addItem(feedbackItem, Date.now());
      config.getChatRecordingService?.()?.recordSlashCommand({
        phase: 'result',
        rawCommand: '/output-style',
        outputHistoryItems: [feedbackItem],
      });
    },
    [addItem, config],
  );

  const handleOutputStyleSelect = useCallback(
    (styleName: string | undefined) => {
      // Close first: the apply below rebuilds the system instruction, and the
      // dialog should not sit open while that runs.
      setIsOutputStyleDialogOpen(false);
      if (styleName === undefined) {
        // User cancelled the dialog — leave the current style unchanged.
        return;
      }
      const style = resolveOutputStyleChoice(styleName, choicesRef.current);
      if (style === null) {
        // The dialog only offers names from the list it was opened with.
        report(
          MessageType.ERROR,
          t('Unknown output style "{{value}}".', { value: styleName }),
        );
        return;
      }
      void (async () => {
        try {
          report(
            MessageType.INFO,
            await applyOutputStyleSelection(config, loadedSettings, style),
          );
        } catch (error) {
          debugLogger.warn('Failed to apply output style:', error);
          report(
            MessageType.ERROR,
            t('Failed to set "{{key}}": {{error}}', {
              key: 'general.outputStyle',
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      })();
    },
    [config, loadedSettings, report],
  );

  return {
    isOutputStyleDialogOpen,
    outputStyleChoices,
    openOutputStyleDialog,
    handleOutputStyleSelect,
  };
};
