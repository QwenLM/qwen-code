/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useEffect, useState } from 'react';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { logicalPosToOffset } from '../components/shared/text-buffer.js';
import { toCodePoints } from '../utils/textUtils.js';
import { isSlashCommand } from '../utils/commandUtils.js';
import { useAtCompletion } from './useAtCompletion.js';
import { useSlashCompletion } from './useSlashCompletion.js';
import { useShellCompletion } from './useShellCompletion.js';
import {
  usePromptCompletion,
  PROMPT_COMPLETION_MIN_LENGTH,
  type PromptCompletion,
} from './usePromptCompletion.js';
import type { Config } from '@qwen-code/core';
import {
  parseArguments,
  generateProgressiveArgumentHint,
} from '@qwen-code/core';
import { useCompletion } from './useCompletion.js';
import { useInlineCommandGhost } from './useInlineCommandGhost.js';
import { parseSlashCommand } from '../../utils/commands.js';
import { CommandService } from '../../services/CommandService.js';
import { useI18nService } from '../i18n/index.js';

export enum CompletionMode {
  IDLE = 'IDLE',
  AT = 'AT',
  SLASH = 'SLASH',
  PROMPT = 'PROMPT',
  SHELL = 'SHELL',
}

export interface UseCommandCompletionReturn {
  suggestions: Suggestion[];
  activeSuggestionIndex: number;
  visibleStartIndex: number;
  showSuggestions: boolean;
  isLoadingSuggestions: boolean;
  isPerfectMatch: boolean;
  forceShowShellSuggestions: boolean;
  setForceShowShellSuggestions: (value: boolean) => void;
  isShellSuggestionsVisible: boolean;
  setActiveSuggestionIndex: React.Dispatch<React.SetStateAction<number>>;
  resetCompletionState: () => void;
  navigateUp: () => void;
  navigateDown: () => void;
  handleAutocomplete: (indexToUse: number) => void;
  promptCompletion: PromptCompletion;
  getCommandFromSuggestion: (
    suggestion: Suggestion,
  ) => SlashCommand | undefined;
  slashCompletionRange: {
    completionStart: number;
    completionEnd: number;
    getCommandFromSuggestion: (
      suggestion: Suggestion,
    ) => SlashCommand | undefined;
    isArgumentCompletion: boolean;
    leafCommand: SlashCommand | null;
    isCompletedRunnableCommand: boolean;
  };
  getCompletedText: (suggestion: Suggestion) => string | null;
  completionMode: CompletionMode;
  /** Argument hint to display as dim text after the command (e.g., "[model]"). */
  commandArgumentHint: string | undefined;
}

export interface UseCommandCompletionOptions {
  buffer: TextBuffer;
  cwd: string;
  slashCommands: readonly SlashCommand[];
  slashCommandCatalogReady?: boolean;
  commandContext: CommandContext;
  reverseSearchActive?: boolean;
  /** History command search (Ctrl+R) — renders the same inline buffer. */
  commandSearchActive?: boolean;
  shellModeActive: boolean;
  config?: Config;
  active: boolean;
  /**
   * Whether `@` may complete on peer sessions.
   *
   * Disabled when a session binding bypasses the local attachment pipeline.
   * Defaults to true so the ordinary local composer needs no opt-in.
   */
  peerMentionsEnabled?: boolean;
}

export function useCommandCompletion({
  buffer,
  cwd,
  slashCommands: loadedSlashCommands,
  slashCommandCatalogReady = true,
  commandContext,
  reverseSearchActive = false,
  commandSearchActive = false,
  shellModeActive,
  config,
  active,
  peerMentionsEnabled = true,
}: UseCommandCompletionOptions): UseCommandCompletionReturn {
  // Inline slash-command suggestions also need current declarations.
  const needsCommandCatalog = !shellModeActive && buffer.text.includes('/');
  const slashCommands = useMemo(
    () =>
      needsCommandCatalog && loadedSlashCommands
        ? CommandService.readCurrentCommands(loadedSlashCommands)
        : loadedSlashCommands,
    // Input changes reread plugin declarations without a background notification.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadedSlashCommands, buffer.text, needsCommandCatalog],
  );
  const i18n = useI18nService();
  const { locale } = i18n;
  const [forceShowShellSuggestions, setForceShowShellSuggestions] =
    useState(false);

  const {
    suggestions,
    activeSuggestionIndex,
    visibleStartIndex,
    isLoadingSuggestions,
    isPerfectMatch,

    setSuggestions,
    setActiveSuggestionIndex,
    setIsLoadingSuggestions,
    setIsPerfectMatch,
    setVisibleStartIndex,

    resetCompletionState: baseResetCompletionState,
    navigateUp,
    navigateDown,
  } = useCompletion();

  const resetCompletionState = useCallback(() => {
    baseResetCompletionState();
    setForceShowShellSuggestions(false);
  }, [baseResetCompletionState]);

  const cursorRow = buffer.cursor[0];
  const cursorCol = buffer.cursor[1];

  const {
    completionMode,
    query: memoQuery,
    completionStart,
    completionEnd,
  } = useMemo(() => {
    const currentLine = buffer.lines[cursorRow] || '';
    const codePoints = toCodePoints(currentLine);

    if (shellModeActive) {
      return {
        completionMode:
          currentLine.trim().length === 0
            ? CompletionMode.IDLE
            : CompletionMode.SHELL,
        query: '',
        completionStart: -1,
        completionEnd: -1,
      };
    }

    // FIRST: Check for @ completion (scan backwards from cursor)
    // This must happen before slash command check so that `/cmd @file`
    // triggers file completion, not just slash command completion.
    for (let i = cursorCol - 1; i >= 0; i--) {
      const char = codePoints[i];

      if (char === ' ') {
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && codePoints[j] === '\\'; j--) {
          backslashCount++;
        }
        if (backslashCount % 2 === 0) {
          break;
        }
      } else if (char === '@') {
        let end = codePoints.length;
        for (let i = cursorCol; i < codePoints.length; i++) {
          if (codePoints[i] === ' ') {
            let backslashCount = 0;
            for (let j = i - 1; j >= 0 && codePoints[j] === '\\'; j--) {
              backslashCount++;
            }

            if (backslashCount % 2 === 0) {
              end = i;
              break;
            }
          }
        }
        const pathStart = i + 1;
        const partialPath = currentLine.substring(pathStart, end);
        return {
          completionMode: CompletionMode.AT,
          query: partialPath,
          completionStart: pathStart,
          completionEnd: end,
        };
      }
    }

    // THEN: Check for slash command (only if no @ completion is active)
    const trimmedCurrentLine = currentLine.trim();
    const isKnownSlashCommand = Boolean(
      parseSlashCommand(trimmedCurrentLine, slashCommands).commandToExecute,
    );
    if (
      cursorRow === 0 &&
      isSlashCommand(trimmedCurrentLine, {
        isKnownCommand: isKnownSlashCommand,
        commandCatalogReady: slashCommandCatalogReady,
      })
    ) {
      return {
        completionMode: CompletionMode.SLASH,
        query: currentLine,
        completionStart: 0,
        completionEnd: currentLine.length,
      };
    }

    // Check for prompt completion - only if enabled
    const trimmedText = buffer.text.trim();
    const isPromptCompletionEnabled = false;
    if (
      isPromptCompletionEnabled &&
      trimmedText.length >= PROMPT_COMPLETION_MIN_LENGTH &&
      !isSlashCommand(trimmedText) &&
      !trimmedText.includes('@')
    ) {
      return {
        completionMode: CompletionMode.PROMPT,
        query: trimmedText,
        completionStart: 0,
        completionEnd: trimmedText.length,
      };
    }

    return {
      completionMode: CompletionMode.IDLE,
      query: null,
      completionStart: -1,
      completionEnd: -1,
    };
  }, [
    cursorRow,
    cursorCol,
    buffer.lines,
    buffer.text,
    shellModeActive,
    slashCommands,
    slashCommandCatalogReady,
  ]);

  useAtCompletion({
    enabled: active && completionMode === CompletionMode.AT,
    pattern: memoQuery || '',
    config,
    cwd,
    peerMentionsEnabled,
    setSuggestions,
    setIsLoadingSuggestions,
  });

  const slashCompletionRange = useSlashCompletion({
    enabled:
      active && completionMode === CompletionMode.SLASH && !shellModeActive,
    query: memoQuery,
    slashCommands,
    commandContext,
    setSuggestions,
    setIsLoadingSuggestions,
    setIsPerfectMatch,
    translate: i18n.get,
    locale,
  });

  const shellCompletionRange = useShellCompletion({
    enabled: active && completionMode === CompletionMode.SHELL,
    line: buffer.lines[cursorRow] || '',
    cursorCol,
    cwd,
    setSuggestions,
    setIsLoadingSuggestions,
  });

  const query =
    completionMode === CompletionMode.SHELL
      ? shellCompletionRange.query
      : memoQuery;

  const basePromptCompletion = usePromptCompletion({
    buffer,
  });

  const isShellSuggestionsVisible =
    completionMode !== CompletionMode.SHELL || forceShowShellSuggestions;

  // Declared before the inline ghost because the ghost gates on it: this is the
  // quantity the dropdown actually renders from, so using it makes "dropdown
  // open" and "ghost visible" mutually exclusive rather than merely ordered.
  // Suggestions land through effects, so a parser-level check would leave a
  // window where last keystroke's rows are still on screen next to a new ghost.
  const showSuggestions =
    active &&
    completionMode !== CompletionMode.IDLE &&
    !reverseSearchActive &&
    isShellSuggestionsVisible &&
    (isLoadingSuggestions || suggestions.length > 0);

  // Whether the line-start command owns everything typed after its name. A
  // command with a `completion` function has the dropdown supplying its
  // arguments, so a `/token` sitting in that argument text is far more likely
  // to be a path or a model id than a command — completing it would be the
  // `cd /usr/bin` misfire.
  //
  // Resolved from the line-start command rather than the parser's leaf on
  // purpose: the leaf collapses to null as soon as an argument fails to resolve
  // (useSlashCompletion.ts:124-131), which would leave `/add-dir ~/proj /doc`
  // unguarded at argument depth 2.
  const leadingCommandOwnsArguments = useMemo(() => {
    if (completionMode !== CompletionMode.SLASH) {
      return false;
    }
    const line = buffer.lines[cursorRow] ?? '';
    return Boolean(
      parseSlashCommand(line.trim(), slashCommands).commandToExecute
        ?.completion,
    );
  }, [completionMode, buffer.lines, cursorRow, slashCommands]);

  // Mid-input `/command` ghost text. SLASH is allowed through so a second
  // `/token` on a line that already starts with a command still gets a hint —
  // the trigger regex requires a separator before the `/`, so the line's own
  // first command can never match here and steal the dropdown's turn.
  const inlineCommandGhost = useInlineCommandGhost({
    enabled:
      active &&
      !shellModeActive &&
      !reverseSearchActive &&
      !commandSearchActive &&
      !showSuggestions &&
      (completionMode === CompletionMode.IDLE ||
        (completionMode === CompletionMode.SLASH &&
          !leadingCommandOwnsArguments)),
    buffer,
    slashCommands,
  });

  const promptCompletion = useMemo(() => {
    if (
      completionMode === CompletionMode.SHELL &&
      suggestions.length === 1 &&
      query != null &&
      shellCompletionRange.completionStart === shellCompletionRange.activeStart
    ) {
      const suggestion = suggestions[0];
      const textToInsertBase = suggestion.value;

      if (
        textToInsertBase.startsWith(query) &&
        textToInsertBase.length > query.length
      ) {
        const currentLine = buffer.lines[cursorRow] || '';
        const start = shellCompletionRange.completionStart;
        const end = shellCompletionRange.completionEnd;

        let textToInsert = textToInsertBase;
        const charAfterCompletion = currentLine[end];
        if (
          charAfterCompletion !== ' ' &&
          !textToInsert.endsWith('/') &&
          !textToInsert.endsWith('\\')
        ) {
          textToInsert += ' ';
        }

        const newText =
          currentLine.substring(0, start) +
          textToInsert +
          currentLine.substring(end);

        // The ghost renderer only draws when the completion extends the buffer
        // as a prefix (InputPrompt's getGhostTextLines). With text after the
        // completion point — or any earlier line — `newText` is a rewrite
        // rather than an extension, so nothing is drawn. Bail out instead of
        // handing back a truthy `text`, which the shell Tab branch would
        // happily accept even though the user was shown nothing.
        if (!newText.startsWith(buffer.text)) {
          return basePromptCompletion;
        }

        return {
          text: newText,
          isActive: true,
          isLoading: false,
          accept: () => {
            buffer.replaceRangeByOffset(
              logicalPosToOffset(buffer.lines, cursorRow, start),
              logicalPosToOffset(buffer.lines, cursorRow, end),
              textToInsert,
            );
          },
          clear: () => {},
          markSelected: () => {},
        };
      }
    }
    if (inlineCommandGhost) {
      return inlineCommandGhost;
    }
    return basePromptCompletion;
  }, [
    completionMode,
    suggestions,
    query,
    basePromptCompletion,
    inlineCommandGhost,
    buffer,
    cursorRow,
    shellCompletionRange,
  ]);

  useEffect(() => {
    setActiveSuggestionIndex(suggestions.length > 0 ? 0 : -1);
    setVisibleStartIndex(0);

    // Generic perfect match detection for non-slash modes or as a fallback
    if (completionMode !== CompletionMode.SLASH) {
      if (suggestions.length > 0) {
        const firstSuggestion = suggestions[0];
        setIsPerfectMatch(firstSuggestion.value === query);
      } else {
        setIsPerfectMatch(false);
      }
    }
  }, [
    suggestions,
    setActiveSuggestionIndex,
    setVisibleStartIndex,
    completionMode,
    query,
    setIsPerfectMatch,
  ]);

  useEffect(() => {
    if (
      !active ||
      completionMode === CompletionMode.IDLE ||
      reverseSearchActive
    ) {
      resetCompletionState();
    }
  }, [active, completionMode, reverseSearchActive, resetCompletionState]);

  /**
   * Gets the completed text by replacing the completion range with the suggestion value.
   * This is the core string replacement logic used by both autocomplete and auto-execute.
   *
   * @param suggestion The suggestion to apply
   * @returns The completed text with the suggestion applied, or null if invalid
   */
  const getCompletedText = useCallback(
    (suggestion: Suggestion): string | null => {
      const currentLine = buffer.lines[cursorRow] || '';

      let start = completionStart;
      let end = completionEnd;
      if (completionMode === CompletionMode.SLASH) {
        start = slashCompletionRange.completionStart;
        end = slashCompletionRange.completionEnd;
      } else if (completionMode === CompletionMode.SHELL) {
        start = shellCompletionRange.completionStart;
        end = shellCompletionRange.completionEnd;
      }

      if (start === -1 || end === -1) {
        return null;
      }

      // Apply space padding for slash commands (needed for subcommands like "/chat list")
      let suggestionText = suggestion.insertValue ?? suggestion.value;
      if (completionMode === CompletionMode.SLASH) {
        // Add leading space if completing a subcommand (cursor is after parent command with no space)
        if (start === end && start > 1 && currentLine[start - 1] !== ' ') {
          suggestionText = ' ' + suggestionText;
        }
      }

      // Build the completed text with proper spacing
      return (
        currentLine.substring(0, start) +
        suggestionText +
        currentLine.substring(end)
      );
    },
    [
      cursorRow,
      buffer.lines,
      completionMode,
      completionStart,
      completionEnd,
      slashCompletionRange,
      shellCompletionRange,
    ],
  );

  const handleAutocomplete = useCallback(
    (indexToUse: number) => {
      if (indexToUse < 0 || indexToUse >= suggestions.length) {
        return;
      }
      const suggestion = suggestions[indexToUse];
      const completedText = getCompletedText(suggestion);

      if (completedText === null) {
        return;
      }

      let start = completionStart;
      let end = completionEnd;
      if (completionMode === CompletionMode.SLASH) {
        start = slashCompletionRange.completionStart;
        end = slashCompletionRange.completionEnd;
      } else if (completionMode === CompletionMode.SHELL) {
        start = shellCompletionRange.completionStart;
        end = shellCompletionRange.completionEnd;
      }

      // Add space padding for Tab completion (auto-execute gets padding from getCompletedText)
      let suggestionText = suggestion.insertValue ?? suggestion.value;
      if (completionMode === CompletionMode.SLASH) {
        if (
          start === end &&
          start > 1 &&
          (buffer.lines[cursorRow] || '')[start - 1] !== ' '
        ) {
          suggestionText = ' ' + suggestionText;
        }
      }

      const lineCodePoints = toCodePoints(buffer.lines[cursorRow] || '');
      const charAfterCompletion = lineCodePoints[end];

      // Every accepted completion gets a trailing space, so the cursor lands
      // where the next token goes. The `/` and `\` guards keep directory
      // completions chainable.
      if (
        charAfterCompletion !== ' ' &&
        !suggestionText.endsWith('/') &&
        !suggestionText.endsWith('\\')
      ) {
        suggestionText += ' ';
      }

      buffer.replaceRangeByOffset(
        logicalPosToOffset(buffer.lines, cursorRow, start),
        logicalPosToOffset(buffer.lines, cursorRow, end),
        suggestionText,
      );
    },
    [
      cursorRow,
      buffer,
      suggestions,
      completionMode,
      completionStart,
      completionEnd,
      slashCompletionRange,
      shellCompletionRange,
      getCompletedText,
    ],
  );

  /**
   * Compute commandArgumentHint based on the current input and matched command.
   *   - Static argumentHint: shown only when no args typed yet (first trailing space)
   *   - Progressive hint from argNames: shown whenever input ends with space and argNames exist
   *   - Otherwise: undefined (no hint)
   */
  const currentLine = buffer.lines[cursorRow] || '';
  const leafCommand = slashCompletionRange.leafCommand;

  const commandArgumentHint = useMemo((): string | undefined => {
    if (completionMode !== CompletionMode.SLASH) return undefined;
    if (!leafCommand) return undefined;

    // Find the first space (separating command name from arguments)
    const spaceIndex = currentLine.indexOf(' ');
    if (spaceIndex === -1) return undefined;

    const afterCommand = currentLine.slice(spaceIndex + 1);
    const noArgsTyped = currentLine.length === spaceIndex + 1;

    // Priority 1: Static argumentHint (only when no args typed yet)
    if (leafCommand.argumentHint && noArgsTyped) {
      return leafCommand.argumentHint;
    }

    // Priority 2: Progressive hint from argNames (when input ends with space)
    if (
      leafCommand.argNames &&
      leafCommand.argNames.length > 0 &&
      currentLine.endsWith(' ')
    ) {
      const typedArgs = parseArguments(afterCommand);
      return generateProgressiveArgumentHint(leafCommand.argNames, typedArgs);
    }

    return undefined;
  }, [completionMode, leafCommand, currentLine]);

  return {
    suggestions,
    activeSuggestionIndex,
    visibleStartIndex,
    showSuggestions,
    isLoadingSuggestions,
    isPerfectMatch,
    forceShowShellSuggestions,
    setForceShowShellSuggestions,
    isShellSuggestionsVisible,
    setActiveSuggestionIndex,
    resetCompletionState,
    navigateUp,
    navigateDown,
    handleAutocomplete,
    promptCompletion,
    getCommandFromSuggestion: slashCompletionRange.getCommandFromSuggestion,
    slashCompletionRange,
    getCompletedText,
    completionMode,
    commandArgumentHint,
  };
}
