/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import type { SlashCommand } from '../commands/types.js';
import type { Key } from './useKeypress.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import type { UseCommandCompletionReturn } from './useCommandCompletion.js';

const EXPORT_COMMAND_INPUT = '/export';

/**
 * Parse a single export format from an input buffer.
 *
 * The valid-format list is passed in so that adding a new "/export <fmt>"
 * sub-command to slashCommands automatically enables Phase-2 cycling for it,
 * without requiring a synchronous hard-coded regex update.
 *
 * Uses a simple slice-based approach (no regex) for two reasons:
 *   1. No escaping concerns when format names contain regex metacharacters.
 *   2. O(1) cost after the cheap startsWith prefix guard.
 */
export const getExportFormatFromInput = (
  input: string,
  validFormats: readonly string[],
): string | null => {
  const trimmed = input.trim();
  if (!trimmed.startsWith(EXPORT_COMMAND_INPUT + ' ')) {
    return null;
  }
  const rest = trimmed.slice(EXPORT_COMMAND_INPUT.length + 1);
  if (!rest || rest.includes(' ')) {
    return null;
  }
  return validFormats.includes(rest) ? rest : null;
};

/**
 * Compute the next index for export format cycling (round-robin).
 * Extracted as a module-level pure function to avoid per-keystroke
 * closure recreation inside handleInput.
 */
export const getNextExportCompletionIndex = (
  formatList: readonly string[],
  currentIndex: number,
  direction: 'up' | 'down',
) => {
  const total = formatList.length;
  if (total === 0) {
    return currentIndex;
  }
  const lastIndex = total - 1;
  if (direction === 'up') {
    return currentIndex <= 0 ? lastIndex : currentIndex - 1;
  }
  return currentIndex >= lastIndex ? 0 : currentIndex + 1;
};

export interface ExportCompletionResult {
  /** Whether the suggestions panel should be visible (export-specific). */
  shouldShowSuggestions: boolean;
  /**
   * Display props for the SuggestionsDisplay component when export
   * suggestions are active, or null if the caller should fall back
   * to the generic completion state.
   */
  suggestionDisplayProps: {
    suggestions: Suggestion[];
    activeIndex: number;
    isLoading: boolean;
    scrollOffset: number;
  } | null;
  /**
   * Handle a keypress for export-specific completion logic.
   * Returns true if the key was consumed, false if the caller should
   * fall through to generic completion handling.
   */
  handleExportInput: (
    key: Key,
    completion: UseCommandCompletionReturn,
  ) => boolean;
  /** Reset all export cycling state (call on ESC / Ctrl+C / Ctrl+U / submit). */
  reset: () => void;
  /**
   * Allow the next buffer text change to seed export cycling if it becomes
   * exactly "/export <fmt>". Call this only for direct user text edits.
   */
  markNextTextChangeAsUserInput: () => void;
  /**
   * Shared "has navigated" flag.  The generic completion path sets this
   * to true on arrow navigation and the isPerfectMatch + Enter path reads
   * it.  Owned by this hook so both the export-specific and generic paths
   * share a single source of truth.
   */
  navigatedRef: React.MutableRefObject<boolean>;
  /**
   * Buffer text snapshot captured when navigatedRef was last set to true.
   * Used by the caller to detect stale navigation state when the buffer
   * has been modified externally (e.g. via setText in tests).
   */
  navigatedTextRef: React.MutableRefObject<string>;
}

export function useExportCompletion(
  buffer: TextBuffer,
  slashCommands: readonly SlashCommand[],
): ExportCompletionResult {
  const navigatedRef = useRef(false);
  const navigatedTextRef = useRef('');
  const cyclingActiveRef = useRef(false);
  const nextTextChangeWasUserInputRef = useRef(false);

  // Derive the canonical export format list from slashCommands so adding a
  // new "/export <fmt>" sub-command automatically enables arrow/Tab cycling.
  const exportFormatSuggestions = useMemo<Suggestion[]>(() => {
    const exportCommand = slashCommands.find(
      (command) => command.name === EXPORT_COMMAND_INPUT.slice(1),
    );
    const subCommands = exportCommand?.subCommands;
    if (subCommands && subCommands.length > 0) {
      return subCommands.map((command) => ({
        label: command.name,
        value: command.name,
        description: command.description,
        commandKind: command.kind,
      }));
    }
    return [];
  }, [slashCommands]);

  // Cache the export format names (keys only) so the cycle logic inside
  // handleInput does not call .map() on every keystroke.
  const exportCycleFormats = useMemo(
    () => exportFormatSuggestions.map((s) => s.value),
    [exportFormatSuggestions],
  );

  const markNextTextChangeAsUserInput = useCallback(() => {
    nextTextChangeWasUserInputRef.current = true;
  }, []);

  // Seed cyclingActiveRef only for text changes that InputPrompt marked as
  // direct user edits. History navigation and programmatic setText() calls can
  // also produce "/export <fmt>", but they must not steal the next Up/Down key
  // from the normal history/navigation handlers.
  useEffect(() => {
    const fmt = getExportFormatFromInput(buffer.text, exportCycleFormats);
    if (
      nextTextChangeWasUserInputRef.current &&
      fmt !== null &&
      !cyclingActiveRef.current
    ) {
      cyclingActiveRef.current = true;
    }
    nextTextChangeWasUserInputRef.current = false;
  }, [buffer.text, exportCycleFormats]);

  // Reset navigated flag on every popup visibility transition (true↔false)
  // and on every buffer text change, to prevent flag stickiness when the
  // user navigates, then backspaces and retypes the command.
  useEffect(() => {
    navigatedRef.current = false;
    navigatedTextRef.current = '';
  }, [buffer.text]);

  const reset = useCallback(() => {
    cyclingActiveRef.current = false;
    nextTextChangeWasUserInputRef.current = false;
    navigatedRef.current = false;
    navigatedTextRef.current = '';
  }, []);

  const getExportIndexForActiveSuggestion = useCallback(
    (completion: UseCommandCompletionReturn): number => {
      const idx = completion.activeSuggestionIndex;
      if (idx < 0 || idx >= completion.suggestions.length) {
        return -1;
      }
      return exportCycleFormats.indexOf(completion.suggestions[idx].value);
    },
    [exportCycleFormats],
  );

  const setExportCompletionInput = useCallback(
    (index: number): boolean => {
      const format = exportCycleFormats[index];
      if (!format) return false;
      buffer.setText(`${EXPORT_COMMAND_INPUT} ${format}`);
      cyclingActiveRef.current = true;
      navigatedRef.current = false;
      return true;
    },
    [buffer, exportCycleFormats],
  );

  const handleExportInput = useCallback(
    (key: Key, completion: UseCommandCompletionReturn): boolean => {
      const isCompletionUpKey = keyMatchers[Command.COMPLETION_UP](key);
      const isCompletionDownKey = keyMatchers[Command.COMPLETION_DOWN](key);
      const isCompletionTabKey =
        key.name === 'tab' &&
        !key.shift &&
        !key.ctrl &&
        !key.meta &&
        !key.paste;

      // ---- Phase 1 detection (popup is showing pure "/export") ----
      const hasExportFormatSuggestions =
        buffer.text.trim() === EXPORT_COMMAND_INPUT &&
        completion.suggestions.length > 0 &&
        exportCycleFormats.length > 0 &&
        exportCycleFormats.every((format) =>
          completion.suggestions.some((s) => s.value === format),
        );

      // ---- Phase 2 guard ----
      const parsedFormat = getExportFormatFromInput(
        buffer.text,
        exportCycleFormats,
      );

      // Phase-2 cycling: buffer is "/export <fmt>" and cycling is active.
      if (
        cyclingActiveRef.current &&
        parsedFormat !== null &&
        !key.ctrl &&
        !key.meta &&
        !key.paste &&
        (isCompletionUpKey || isCompletionDownKey || isCompletionTabKey)
      ) {
        const direction = isCompletionUpKey ? 'up' : 'down';
        const currentIndex = exportCycleFormats.indexOf(parsedFormat);
        const nextIndex = getNextExportCompletionIndex(
          exportCycleFormats,
          currentIndex,
          direction,
        );
        setExportCompletionInput(nextIndex);
        return true;
      }

      if (!completion.showSuggestions) {
        return false;
      }

      // ---- Phase 1: popup is visible ----
      if (completion.suggestions.length > 1) {
        if (isCompletionUpKey || isCompletionDownKey) {
          if (hasExportFormatSuggestions) {
            const currentIdx = getExportIndexForActiveSuggestion(completion);
            if (currentIdx !== -1) {
              const nextIdx = getNextExportCompletionIndex(
                exportCycleFormats,
                currentIdx,
                isCompletionUpKey ? 'up' : 'down',
              );
              setExportCompletionInput(nextIdx);
              return true;
            }
          }
        }
      }

      if (keyMatchers[Command.ACCEPT_SUGGESTION](key) && !key.paste) {
        if (
          hasExportFormatSuggestions &&
          !(completion.isPerfectMatch && keyMatchers[Command.RETURN](key))
        ) {
          const exportIdx = getExportIndexForActiveSuggestion(completion);
          if (exportIdx !== -1) {
            setExportCompletionInput(exportIdx);
            return true;
          }
        }
      }

      return false;
    },
    [
      buffer,
      exportCycleFormats,
      getExportIndexForActiveSuggestion,
      setExportCompletionInput,
    ],
  );

  // ---- Render-time derivations ----
  const selectedExportFormat = getExportFormatFromInput(
    buffer.text,
    exportCycleFormats,
  );
  const selectedExportFormatIndex =
    selectedExportFormat === null
      ? -1
      : exportFormatSuggestions.findIndex(
          (s) => s.value === selectedExportFormat,
        );

  const shouldShowSuggestions =
    !cyclingActiveRef.current || selectedExportFormatIndex === -1
      ? false
      : true;

  const suggestionDisplayProps = useMemo<
    ExportCompletionResult['suggestionDisplayProps']
  >(
    () =>
      shouldShowSuggestions
        ? {
            suggestions: exportFormatSuggestions,
            activeIndex: selectedExportFormatIndex,
            isLoading: false,
            scrollOffset: 0,
          }
        : null,
    [exportFormatSuggestions, selectedExportFormatIndex, shouldShowSuggestions],
  );

  return useMemo(
    () => ({
      shouldShowSuggestions,
      suggestionDisplayProps,
      handleExportInput,
      reset,
      markNextTextChangeAsUserInput,
      navigatedRef,
      navigatedTextRef,
    }),
    [
      shouldShowSuggestions,
      suggestionDisplayProps,
      handleExportInput,
      reset,
      markNextTextChangeAsUserInput,
    ],
  );
}
