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
  // Counts opens so a load that resolves after the user moved on cannot act.
  // The open suspends on a disk read, so a dismissal can land in between; the
  // continuation would then re-open the dialog the user just closed, and the
  // next Enter would be captured by it and write `general.outputStyle`.
  const openGenerationRef = useRef(0);

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

  const openOutputStyleDialog = useCallback(() => {
    const generation = ++openGenerationRef.current;
    choicesRef.current = [];
    setOutputStyleChoices([]);
    setIsOutputStyleDialogOpen(true);
    // Keep the selector non-interactive until the complete catalog is ready.
    void (async () => {
      let choices: readonly OutputStyleDefinition[];
      try {
        choices = await loadSessionOutputStyles(config);
      } catch (error) {
        if (openGenerationRef.current !== generation) {
          return;
        }
        debugLogger.warn('Failed to load custom output styles:', error);
        setIsOutputStyleDialogOpen(false);
        report(
          MessageType.ERROR,
          t('Failed to load output styles: {{error}}', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return;
      }
      if (openGenerationRef.current !== generation) {
        return;
      }
      choicesRef.current = choices;
      setOutputStyleChoices(choices);
    })();
  }, [config, report]);

  const handleOutputStyleSelect = useCallback(
    (styleName: string | undefined) => {
      // Close first: the apply below rebuilds the system instruction, and the
      // dialog should not sit open while that runs. Retiring the generation
      // is part of closing: an open still waiting on its disk read must not
      // re-open the dialog behind this selection.
      openGenerationRef.current += 1;
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
