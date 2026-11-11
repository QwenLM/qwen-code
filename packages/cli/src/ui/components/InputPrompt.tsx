/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useMemo,
} from 'react';
import { Box, Text, type DOMElement } from 'ink';
import {
  SuggestionsDisplay,
  MAX_SUGGESTIONS_TO_SHOW,
  MAX_WIDTH,
  type SuggestionsDisplayProps,
} from './SuggestionsDisplay.js';
import { theme, resolveThemeColor } from '../semantic-colors.js';
import { useInputHistory } from '../hooks/useInputHistory.js';
import { escapeAtSymbols } from '../utils/atMentionUtils.js';
import {
  type TextBuffer,
  expandPastePlaceholders,
  getTransformUnderCursor,
} from './shared/text-buffer.js';
import {
  cpSlice,
  cpLen,
  toCodePoints,
  cpIndexToOffset,
  containsControlCharacters,
} from '../utils/textUtils.js';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { useShellHistory } from '../hooks/useShellHistory.js';
import { useHistorySearch } from '../hooks/useHistorySearch.js';
import {
  useCommandCompletion,
  CompletionMode,
} from '../hooks/useCommandCompletion.js';
import { useNextActionSuggestions } from '../hooks/useNextActionSuggestions.js';
import { type Key } from '../hooks/useKeypress.js';
import { shouldSubmitFastReturnAfterInsertable } from '../contexts/KeypressContext.js';
import { useRegisterKeyboardContext } from '../contexts/KeyboardContextRegistry.js';
import {
  useRegisterActionHandlers,
  useRegisterFallbackHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { Command } from '../key/keyMatchers.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import {
  runLogger,
  type Config,
  type PermissionMode,
  type PastedContent,
  type SlashCommandSource,
  permissionModeColor,
  isVisionSupportedModel,
  findStandaloneUltracodeRanges,
  type UltracodeKeywordRange,
} from '@qwen-code/core';
import {
  parseInputForHighlighting,
  parseSegmentsFromTokens,
} from '../utils/highlight.js';
import {
  isAutoExecutableCommand,
  isSlashCommand,
} from '../utils/commandUtils.js';
import { parseSlashCommand } from '../../utils/commands.js';
import { SCREEN_READER_USER_PREFIX } from '../textConstants.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useModel } from '../contexts/ConfigContext.js';
import { useInputState } from '../contexts/InputContext.js';
import {
  appEvents,
  AppEvent,
  TransientMessageType,
} from '../../utils/events.js';
import { useSettingsStore } from '../contexts/SettingsContext.js';
import { StreamingState } from '../types.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useIsHelpDismissKey } from '../utils/shortcutsHelp.js';
import { useRepeatedKeyPress } from '../hooks/useRepeatedKeyPress.js';
import { usePasteExpansion } from '../hooks/usePasteExpansion.js';
import {
  useClipboardPaste,
  insertPastedImageFilePaths,
} from '../hooks/useClipboardPaste.js';
import {
  extractPastedImagePaths,
  mayContainPastedFilePaths,
} from '../utils/clipboardUtils.js';
import {
  hasPendingClipboardImages,
  materializePendingClipboardImages,
} from '../utils/clipboardImageCapture.js';
import {
  useKeyBindingConfig,
  useKeyMatchers,
} from '../hooks/useKeyMatchers.js';
import { formatCommand } from '../key/keybindingUtils.js';
import { useVim } from '../hooks/vim.js';
import { resolveColor } from '../themes/color-utils.js';
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js';
import { InputFrame } from './shared/InputFrame.js';
import {
  useSpellcheckHighlights,
  splitTextBySpellcheckSpans,
} from '../hooks/useSpellcheckHighlights.js';
import type { WorkflowKeywordStatus } from './StatusRow.js';
import {
  getLocalizedPermissionModeTitle,
  useI18nService,
} from '../i18n/index.js';

/**
 * Convert a hex color string to an SGR foreground color escape sequence.
 * Emits SET codes only (no close/reset) so the tokenizer tracks continuous style.
 */
function hexToSgrFg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Convert a hex color string to an SGR background color escape sequence.
 * Emits SET codes only (no close/reset) so the tokenizer tracks continuous style.
 */
function hexToSgrBg(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Parse a hex color string (#RGB or #RRGGBB) to [R, G, B] values.
 */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/**
 * Returns if the terminal can be trusted to handle paste events atomically
 * rather than potentially sending multiple paste events separated by line
 * breaks which could trigger unintended command execution.
 */
export function isTerminalPasteTrusted(
  kittyProtocolSupported: boolean,
): boolean {
  // Ideally we could trust all VSCode family terminals as well but it appears
  // we cannot as Cursor users on windows reported being impacted by this
  // issue (https://github.com/google-gemini/gemini-cli/issues/3763).
  return kittyProtocolSupported;
}

export interface InputPromptProps {
  onSubmit: (
    value: string,
    imagePastedContents: Record<number, PastedContent>,
    preExpansionText?: string,
    slashCommandSource?: SlashCommandSource,
    suppressWorkflowKeyword?: boolean,
  ) => Promise<boolean> | boolean | void;
  onClearScreen: () => void;
  config: Config;
  slashCommands: readonly SlashCommand[];
  slashCommandCatalogReady?: boolean;
  commandContext: CommandContext;
  placeholder?: string;
  focus?: boolean;
  setShellModeActive: (value: boolean) => void;
  permissionMode: PermissionMode;
  onEscapePromptChange?: (showPrompt: boolean) => void;
  onDoubleEscapeEmpty?: () => void;
  onSuggestionsVisibilityChange?: (visible: boolean) => void;
  onFooterSuggestionsChange?: (
    suggestions: SuggestionsDisplayProps | null,
  ) => void;
  onFooterSuggestionsRelease?: () => void;
  onHistoryDownOverflow?: () => boolean;
  onWorkflowKeywordStatusChange?: (
    status: WorkflowKeywordStatus | null,
  ) => void;
  setQueueErrorMessage: (message: string | null) => void;
  streamingState: StreamingState;
  popAllMessages?: () => string | undefined;
  onQueueMessage?: (
    message: string,
    options?: {
      pastedContents?: Record<number, PastedContent>;
      preExpansionText?: string;
      suppressWorkflowKeyword?: boolean;
    },
  ) => void;
  suggestionsPosition?: 'above' | 'below' | 'footer';
}

// The input content, input container, and input suggestions list may have different widths
export const calculatePromptWidths = (mainContentWidth: number) => {
  const FRAME_PADDING_AND_BORDER = 4; // Border (2) + padding (2)
  const PROMPT_PREFIX_WIDTH = 2; // '> ' or '! '

  const FRAME_OVERHEAD = FRAME_PADDING_AND_BORDER + PROMPT_PREFIX_WIDTH;
  const suggestionsWidth = Math.max(20, mainContentWidth);

  return {
    inputWidth: Math.max(mainContentWidth - FRAME_OVERHEAD, 1),
    containerWidth: mainContentWidth,
    suggestionsWidth,
    frameOverhead: FRAME_OVERHEAD,
  } as const;
};

const DOUBLE_TAB_CLEAN_UI_TOGGLE_WINDOW_MS = 350;

/**
 * Attempt to toggle expansion of a paste placeholder in the buffer.
 * Returns true if a toggle action was performed or hint was shown, false otherwise.
 */
export function tryTogglePasteExpansion(buffer: TextBuffer): boolean {
  if (!buffer.pastedContent || Object.keys(buffer.pastedContent).length === 0) {
    return false;
  }

  const [row, col] = buffer.cursor;

  // 1. Check if cursor is on or immediately after a collapsed placeholder
  const transform = getTransformUnderCursor(
    row,
    col,
    buffer.transformationsByLine,
    { includeEdge: true },
  );
  if (transform?.type === 'paste' && transform.id) {
    buffer.togglePasteExpansion(transform.id, row, col);
    return true;
  }

  // 2. Check if cursor is inside an expanded paste region — collapse it
  const expandedId = buffer.getExpandedPasteAtLine(row);
  if (expandedId) {
    buffer.togglePasteExpansion(expandedId, row, col);
    return true;
  }

  // 3. Placeholders exist but cursor isn't on one — don't consume the key.
  // This allows Ctrl+O to bubble up to AppContainer's fold toggle (SHOW_MORE_LINES).
  return false;
}

function getSingleLineCoalescedSubmitText(sequence: string): string | null {
  const suffix = sequence.endsWith('\r\n')
    ? '\r\n'
    : sequence.endsWith('\r')
      ? '\r'
      : null;

  if (!suffix) {
    return null;
  }

  const text = sequence.slice(0, -suffix.length);

  // Control characters mean this is an escape sequence the parser did not
  // recognize, not typed text — submitting it would send invisible bytes as a
  // message (the emptiness guards downstream all use trim(), which keeps them).
  if (
    !text ||
    text.endsWith('\\') ||
    /[\r\n]/.test(text) ||
    containsControlCharacters(text)
  ) {
    return null;
  }

  return text;
}

function previewSingleLineInsert(buffer: TextBuffer, text: string): string {
  const lines = buffer.lines.length > 0 ? [...buffer.lines] : [''];
  const [cursorRow, cursorCol] = buffer.cursor;
  const row = Math.min(Math.max(cursorRow, 0), lines.length - 1);
  const line = lines[row] ?? '';
  const col = Math.min(Math.max(cursorCol, 0), cpLen(line));

  lines[row] = cpSlice(line, 0, col) + text + cpSlice(line, col);

  return lines.join('\n');
}

function getKeywordRangesByLine(
  lines: readonly string[],
  ranges: readonly UltracodeKeywordRange[],
): Map<number, UltracodeKeywordRange[]> {
  const byLine = new Map<number, UltracodeKeywordRange[]>();
  let lineStart = 0;
  lines.forEach((line, lineIndex) => {
    const lineLength = cpLen(line);
    const lineRanges = ranges
      .filter(
        (range) =>
          range.start >= lineStart && range.end <= lineStart + lineLength,
      )
      .map((range) => ({
        start: range.start - lineStart,
        end: range.end - lineStart,
      }));
    if (lineRanges.length > 0) byLine.set(lineIndex, lineRanges);
    lineStart += lineLength + 1;
  });
  return byLine;
}

function splitRunByKeywordRanges(
  text: string,
  transformedStart: number,
  transformedToLogicalMap: readonly number[] | undefined,
  ranges: readonly UltracodeKeywordRange[],
): Array<{ text: string; keyword: boolean }> {
  if (ranges.length === 0 || text.length === 0) {
    return [{ text, keyword: false }];
  }
  const result: Array<{ text: string; keyword: boolean }> = [];
  for (const [offset, char] of toCodePoints(text).entries()) {
    const transformedOffset = transformedStart + offset;
    const logicalOffset =
      transformedToLogicalMap?.[transformedOffset] ?? transformedOffset;
    const keyword = ranges.some(
      (range) => logicalOffset >= range.start && logicalOffset < range.end,
    );
    const previous = result.at(-1);
    if (previous?.keyword === keyword) {
      previous.text += char;
    } else {
      result.push({ text: char, keyword });
    }
  }
  return result;
}

export const InputPrompt: React.FC<InputPromptProps> = ({
  onSubmit,
  onClearScreen: _onClearScreen,
  config,
  slashCommands,
  slashCommandCatalogReady = true,
  commandContext,
  placeholder = '  Type your message or @path/to/file',
  focus = true,
  setShellModeActive,
  permissionMode,
  onEscapePromptChange,
  onDoubleEscapeEmpty,
  onSuggestionsVisibilityChange,
  onFooterSuggestionsChange,
  onFooterSuggestionsRelease,
  onHistoryDownOverflow,
  onWorkflowKeywordStatusChange,
  setQueueErrorMessage,
  streamingState,
  popAllMessages,
  onQueueMessage,
  suggestionsPosition = 'below',
}) => {
  const i18n = useI18nService();
  const inputState = useInputState();
  const {
    buffer,
    userMessages,
    shellModeActive,
    inputWidth,
    suggestionsWidth,
    stash,
  } = inputState;
  const { toggleStash, markRestorePending } = stash;
  const isHelpDismissKey = useIsHelpDismissKey();
  const keyMatchers = useKeyMatchers();
  const keyBindingConfig = useKeyBindingConfig();
  const { settings: settingsState } = useSettingsStore();
  const settings = settingsState.merged;
  const { setShortcutsHelpVisible, sendQueuedNow } = useUIActions();
  const {
    terminalWidth,
    shortcutsHelpVisible,
    activeShellId,
    modelNextActionSuggestions,
    currentModel,
    hasSessionBinding,
    isModelTurnActive,
    sessionName,
  } = useUIState();
  const listedModel = useModel(config, currentModel);
  const [suppressCompletion, setSuppressCompletion] = useState(false);
  const [suppressWorkflowKeyword, setSuppressWorkflowKeyword] = useState(false);
  const workflowKeywordRanges = useMemo(
    () =>
      !shellModeActive &&
      config.getWorkflowKeywordTriggerEnabled() &&
      config.isWorkflowToolAvailable()
        ? findStandaloneUltracodeRanges(buffer.text)
        : [],
    [buffer.text, config, shellModeActive],
  );
  const workflowKeywordRangesByLine = useMemo(
    () => getKeywordRangesByLine(buffer.lines, workflowKeywordRanges),
    [buffer.lines, workflowKeywordRanges],
  );
  const hasWorkflowKeyword = workflowKeywordRanges.length > 0;
  const workflowKeywordToggleHint =
    formatCommand(Command.WORKFLOW_KEYWORD_TOGGLE, keyBindingConfig) || 'Alt+W';
  useEffect(() => {
    if (!hasWorkflowKeyword && suppressWorkflowKeyword) {
      setSuppressWorkflowKeyword(false);
    }
  }, [hasWorkflowKeyword, suppressWorkflowKeyword]);
  useEffect(() => {
    onWorkflowKeywordStatusChange?.(
      hasWorkflowKeyword
        ? {
            suppressed: suppressWorkflowKeyword,
            shortcut: workflowKeywordToggleHint,
          }
        : null,
    );
  }, [
    hasWorkflowKeyword,
    onWorkflowKeywordStatusChange,
    suppressWorkflowKeyword,
    workflowKeywordToggleHint,
  ]);
  useEffect(
    () => () => {
      onWorkflowKeywordStatusChange?.(null);
    },
    [onWorkflowKeywordStatusChange],
  );
  const { handlePress: registerPlainTabPress, resetCount: resetPlainTabPress } =
    useRepeatedKeyPress({
      windowMs: DOUBLE_TAB_CLEAN_UI_TOGGLE_WINDOW_MS,
    });
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const { handlePress: handleEscPress, resetCount: resetEscapeState } =
    useRepeatedKeyPress({
      windowMs: 500,
      onRepeat: (count) => {
        if (count === 1) {
          setShowEscapePrompt(true);
        } else if (count === 2) {
          resetEscapeState();
          onFooterSuggestionsRelease?.();
          if (buffer.text.length > 0) {
            buffer.setText('');
            resetCompletionState();
            inputHistory.resetHistoryNav();
          } else {
            onDoubleEscapeEmpty?.();
          }
        }
      },
      onReset: () => setShowEscapePrompt(false),
    });
  const { isRecentPaste, markUnsafePaste } = usePasteExpansion();
  const innerBoxRef = useRef<DOMElement>(null);
  const hasUserNavigatedSuggestions = useRef(false);

  const [expandedSuggestionIndex, setExpandedSuggestionIndex] =
    useState<number>(-1);
  const [footerSuggestionsReservedHeight, setFooterSuggestionsReservedHeight] =
    useState(0);
  const shellHistory = useShellHistory(config.getProjectRoot(), config.storage);
  const shellHistoryData = shellHistory.history;

  const reverseSearch = useHistorySearch(buffer, shellHistoryData);
  const reverseSearchActive = reverseSearch.active;
  const reverseSearchCompletion = reverseSearch.completion;

  const reversedUserMessages = useMemo(
    () => [...userMessages].reverse(),
    [userMessages],
  );
  const commandSearch = useHistorySearch(buffer, reversedUserMessages);
  const commandSearchActive = commandSearch.active;
  const commandSearchCompletion = commandSearch.completion;

  const completion = useCommandCompletion({
    buffer,
    cwd: config.getTargetDir(),
    slashCommands,
    slashCommandCatalogReady,
    commandContext,
    reverseSearchActive,
    commandSearchActive,
    shellModeActive,
    config,
    active: !suppressCompletion,
    // A session binding bypasses the local attachment pipeline, so peer
    // tokens remain disabled on that path.
    peerMentionsEnabled: !hasSessionBinding,
  });

  const resetCompletionState = completion.resetCompletionState;
  const resetReverseSearchCompletionState =
    reverseSearchCompletion.resetCompletionState;
  const resetCommandSearchCompletionState =
    commandSearchCompletion.resetCompletionState;

  const getActiveCompletion = useCallback(() => {
    if (commandSearchActive) return commandSearchCompletion;
    if (reverseSearchActive) return reverseSearchCompletion;
    return completion;
  }, [
    commandSearchActive,
    commandSearchCompletion,
    reverseSearchActive,
    reverseSearchCompletion,
    completion,
  ]);

  const activeCompletion = getActiveCompletion();
  const shouldShowSuggestions = activeCompletion.showSuggestions;

  const { forceShowShellSuggestions, setForceShowShellSuggestions } =
    completion;
  const promptCompletion = completion.promptCompletion;
  const nextActionSuggestions = useNextActionSuggestions({
    buffer,
    modelSuggestions: modelNextActionSuggestions,
    active:
      !suppressCompletion &&
      focus &&
      streamingState === StreamingState.Idle &&
      !shellModeActive &&
      !reverseSearchActive &&
      !commandSearchActive &&
      !promptCompletion.text &&
      !(completion.showSuggestions && shouldShowSuggestions),
  });
  const recordNextActionSubmission = nextActionSuggestions.recordSubmission;
  const beginNextActionSubmission = nextActionSuggestions.beginSubmission;
  const resolveFailedNextActionSubmission =
    nextActionSuggestions.resolveFailedSubmission;

  // ESC handling for next-action suggestions. revertNextActionOnEscape is
  // the exact-match-guarded low-level check; ESC routes go through
  // revertNextActionWithVim (defined after useVim), which defers the revert
  // while vim is in INSERT mode so that press keeps its INSERT → NORMAL job.
  const revertNextActionOnEscape = useCallback((): boolean => {
    if (
      !focus ||
      streamingState !== StreamingState.Idle ||
      reverseSearchActive ||
      commandSearchActive ||
      // While the completion dropdown is open, ESC closes it and keeps the
      // text; the revert is offered on the next ESC once it is closed.
      (completion.showSuggestions && shouldShowSuggestions)
    ) {
      return false;
    }
    return nextActionSuggestions.revertAccept();
  }, [
    focus,
    nextActionSuggestions,
    streamingState,
    reverseSearchActive,
    commandSearchActive,
    completion.showSuggestions,
    shouldShowSuggestions,
  ]);

  const dismissNextActionOnEscape = useCallback((): boolean => {
    if (!nextActionSuggestions.isVisible) {
      return false;
    }
    nextActionSuggestions.clear();
    return true;
  }, [nextActionSuggestions]);

  const showCursor = focus;

  // Track the last time the user manually scrolled.
  // We avoid re-pinning if they scrolled within the last 3 seconds — they're
  // actively reading, not lost.
  const lastUserScrollTsRef = useRef(0);
  const prevTextRef = useRef(buffer.text);
  const clipboardImageSubmitPendingRef = useRef(false);
  // Latest buffer for async submission boundaries: the buffer memo captured
  // by handleSubmitAndClear's closure goes stale across its awaits, so
  // restore decisions must read the live object through this ref.
  const liveBufferRef = useRef(buffer);
  liveBufferRef.current = buffer;
  // Input and Enter can share a React batch. Only preview inserts that have
  // not appeared in a new buffer yet; fast-return text was already dispatched.
  const pendingInsertRef = useRef<{
    buffer: TextBuffer;
    text: string;
  } | null>(null);

  useEffect(() => {
    const handleUserScroll = () => {
      lastUserScrollTsRef.current = Date.now();
    };
    appEvents.on(AppEvent.UserScrolled, handleUserScroll);
    return () => {
      appEvents.off(AppEvent.UserScrolled, handleUserScroll);
    };
  }, []);

  // Only scroll to bottom on the empty→non-empty transition (i.e. user starts
  // typing into a fresh prompt), and only if they haven't manually scrolled
  // within the repin window. Typing snaps you back to bottom once, but
  // continuous typing doesn't repeatedly force scroll recalculation.
  const RECENT_SCROLL_REPIN_WINDOW_MS = 3000;
  useEffect(() => {
    const wasEmpty = prevTextRef.current === '';
    const isNonEmpty = buffer.text !== '';
    if (
      wasEmpty &&
      isNonEmpty &&
      Date.now() - lastUserScrollTsRef.current >= RECENT_SCROLL_REPIN_WINDOW_MS
    ) {
      appEvents.emit(AppEvent.ScrollToBottom);
    }
    prevTextRef.current = buffer.text;
  }, [buffer.text]);

  // Notify parent component about escape prompt state changes
  useEffect(() => {
    if (onEscapePromptChange) {
      onEscapePromptChange(showEscapePrompt);
    }
  }, [showEscapePrompt, onEscapePromptChange]);

  const pendingSlashCommandSourceRef = useRef<SlashCommandSource>('typed');

  const handleSubmitAndClear = useCallback(
    async (submittedValue: string) => {
      const slashCommandSource = pendingSlashCommandSourceRef.current;
      pendingSlashCommandSourceRef.current = 'typed';
      const workflowKeywordSuppressedAtSubmit =
        suppressWorkflowKeyword &&
        findStandaloneUltracodeRanges(submittedValue).length > 0;
      let processedValue = submittedValue;
      if (buffer.pastedContent) {
        processedValue = expandPastePlaceholders(
          processedValue,
          buffer.pastedContent,
        );
      }

      if (clipboardImageSubmitPendingRef.current) {
        return;
      }

      // Snapshot the composer text before the clipboard await: keystrokes
      // that land while a pending image capture materializes belong to the
      // user's next draft, not to this submission.
      const textAtSubmit = liveBufferRef.current.text;

      let imagePastedContents = { ...buffer.imagePastedContent };
      clipboardImageSubmitPendingRef.current = true;
      try {
        imagePastedContents =
          await materializePendingClipboardImages(imagePastedContents);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to read clipboard image.';
        appEvents.emit(AppEvent.TransientMessage, {
          message,
          type: TransientMessageType.Warning,
        });
        return;
      } finally {
        clipboardImageSubmitPendingRef.current = false;
      }

      if (shellModeActive) {
        shellHistory.addCommandToHistory(processedValue);
      }
      // Clear the buffer and completion state *before* calling onSubmit to
      // prevent stale input from remaining visible while the command executes.
      // This is critical for commands like /compact where InputPrompt stays
      // mounted (via isCompacting) — unlike other commands that unmount/remount
      // and get a fresh state automatically.
      // Mark a submission of the accepted suggestion (armed → submitting)
      // before the programmatic clear below, so a failed submit can re-arm
      // the ESC revert while user-edited text stays non-revertable.
      beginNextActionSubmission();
      // Capture what the clear below actually removes: the closure's buffer
      // is stale after the clipboard await above. That await also keeps the
      // composer live, so the buffer may already hold changes typed during
      // the capture — clearing would silently destroy them on a successful
      // submit. The submission keeps the snapshot taken at Enter and the
      // buffer keeps what the user sees.
      const bufferAtClear = liveBufferRef.current;
      const draftedDuringCapture =
        bufferAtClear.text !== textAtSubmit && bufferAtClear.text !== '';
      const previousText = textAtSubmit;
      if (!draftedDuringCapture) {
        // Clear through the same object the identity guard below compares
        // against, so "the buffer at clear time" is one coherent reference.
        bufferAtClear.setText('');
      }
      resetCompletionState();
      resetReverseSearchCompletionState();

      // Only restore the buffer if onSubmit signals rejection (returns false).
      // Pass the pre-expansion text (with paste placeholders) so @ reference
      // parsing only applies to user-typed content, not expanded paste data.
      const preExpansionText =
        processedValue !== submittedValue ? submittedValue : undefined;
      const restoreFailedSubmission = () => {
        // Keep a draft the user typed while the submission was pending:
        // either during the clipboard capture (the buffer was never
        // cleared) or after the programmatic clear. The latter implies at
        // least one re-render since the clear (buffer memo recreated) AND
        // non-empty text; right after the clear and before any re-render
        // the ref still shows the stale pre-clear object, which must not
        // count as a draft.
        const liveBuffer = liveBufferRef.current;
        if (
          draftedDuringCapture ||
          (liveBuffer !== bufferAtClear && liveBuffer.text !== '')
        ) {
          // Keep the draft and pass null so this accept can never re-arm:
          // a draft that happens to match the accepted text (e.g. recalled
          // from history) must not become ESC-revertable, or ESC would
          // clear text the user typed themselves. Resolving also keeps the
          // state machine out of a stuck 'submitting'.
          resolveFailedNextActionSubmission(null);
          return;
        }
        liveBuffer.setText(previousText);
        // Only a submission that began from armed re-arms the ESC revert.
        resolveFailedNextActionSubmission(previousText);
      };
      let result: boolean | void;
      try {
        result = workflowKeywordSuppressedAtSubmit
          ? await onSubmit(
              processedValue,
              imagePastedContents,
              preExpansionText,
              slashCommandSource,
              true,
            )
          : await onSubmit(
              processedValue,
              imagePastedContents,
              preExpansionText,
              slashCommandSource,
            );
      } catch (error) {
        restoreFailedSubmission();
        // useInputHistory intentionally does not return the submission
        // Promise, so this boundary must handle rejected submissions itself.
        runLogger.error('Error submitting input:', error);
        return;
      }
      if (result === false) {
        restoreFailedSubmission();
        return;
      }
      recordNextActionSubmission(processedValue);
      // Arm the stash restore only once the submission is known to have gone
      // through: a rejected submit puts the original text back, and that draft
      // must win over the stash.
      markRestorePending();
      setSuppressWorkflowKeyword(false);
    },
    [
      buffer,
      onSubmit,
      resetCompletionState,
      shellModeActive,
      shellHistory,
      resetReverseSearchCompletionState,
      recordNextActionSubmission,
      beginNextActionSubmission,
      resolveFailedNextActionSubmission,
      markRestorePending,
      suppressWorkflowKeyword,
    ],
  );

  const customSetTextAndResetCompletionSignal = useCallback(
    (newText: string, cursorPosition?: 'start' | 'end' | number) => {
      buffer.setText(newText, cursorPosition);
      setSuppressCompletion(true);
    },
    [buffer, setSuppressCompletion],
  );

  const inputHistory = useInputHistory({
    userMessages,
    onSubmit: handleSubmitAndClear,
    isActive:
      (!(completion.showSuggestions && shouldShowSuggestions) ||
        completion.suggestions.length === 1) &&
      !shellModeActive,
    currentQuery: buffer.text,
    currentCursorOffset: buffer.getOffset(),
    onChange: customSetTextAndResetCompletionSignal,
  });

  const isSlashInput = useCallback(
    (value: string): boolean => {
      const trimmed = value.trim();
      return isSlashCommand(trimmed, {
        isKnownCommand: Boolean(
          parseSlashCommand(trimmed, slashCommands).commandToExecute,
        ),
        commandCatalogReady: slashCommandCatalogReady,
      });
    },
    [slashCommands, slashCommandCatalogReady],
  );

  const handleSubmit = useCallback(
    (
      submittedValue: string,
      slashCommandSource: SlashCommandSource = 'typed',
    ) => {
      const trimmedMessage = submittedValue.trim();
      const isSlash = isSlashInput(trimmedMessage);
      pendingSlashCommandSourceRef.current = isSlash
        ? slashCommandSource
        : 'typed';
      const isSafeConcurrent =
        isSlash &&
        parseSlashCommand(trimmedMessage, slashCommands).commandToExecute
          ?.isSafeConcurrent;

      // Block all submissions while a foreground user shell command is running
      if (activeShellId) {
        if (isSafeConcurrent) {
          handleSubmitAndClear(trimmedMessage).catch((error) => {
            runLogger.error('Error handling slash command:', error);
          });
          return;
        }
        setQueueErrorMessage('A shell command is currently running');
        pendingSlashCommandSourceRef.current = 'typed';
        return;
      }

      const isShell = shellModeActive;
      if (
        (isSlash || isShell) &&
        streamingState === StreamingState.Responding
      ) {
        if (isSafeConcurrent) {
          handleSubmitAndClear(trimmedMessage).catch((error) => {
            runLogger.error('Error handling slash command:', error);
          });
          return;
        }
        setQueueErrorMessage(
          `${isShell ? 'Shell' : 'Slash'} commands cannot be queued`,
        );
        pendingSlashCommandSourceRef.current = 'typed';
        return;
      }
      inputHistory.handleSubmit(trimmedMessage);
    },
    [
      activeShellId,
      inputHistory,
      shellModeActive,
      streamingState,
      setQueueErrorMessage,
      slashCommands,
      handleSubmitAndClear,
      isSlashInput,
    ],
  );

  const {
    handleInput: vimHandleInput,
    mode: vimMode,
    vimModeEnabled,
    resetEscapeHistory: resetVimEscapeHistory,
  } = useVim(buffer, handleSubmit);

  // Both ESC gesture counters (vim's double-ESC and the prompt's own) are
  // cleared together whenever the UI consumes an ESC, so the press cannot
  // seed or complete a gesture the user did not aim at.
  const clearEscapeGestures = useCallback(() => {
    resetVimEscapeHistory();
    resetEscapeState();
  }, [resetVimEscapeHistory, resetEscapeState]);

  // Reverts a just-accepted next-action suggestion on ESC. While vim is in
  // INSERT mode the revert is deferred: that ESC belongs to the INSERT →
  // NORMAL transition (same deferral pattern as the completion dropdown in
  // revertNextActionOnEscape); from NORMAL mode the next press reverts.
  const revertNextActionWithVim = useCallback(
    (key: Key): boolean => {
      if (vimModeEnabled && vimMode === 'INSERT') {
        return false;
      }
      if (!revertNextActionOnEscape()) {
        return false;
      }
      // Cursor/history navigation can suppress completions without changing
      // the accepted text. A successful revert owns that stale suppression:
      // the now-empty prompt should show the restored Next actions again.
      setSuppressCompletion(false);
      // The revert cleared the buffer; mirror the double-ESC clear path so
      // completion state and history navigation don't stay mid-flight.
      resetCompletionState();
      inputHistory.resetHistoryNav();
      // Forward the consumed ESC so vim also cancels a half-typed operator,
      // then clear both ESC gesture counters so this press seeds no
      // double-ESC that would swallow the user's next one.
      vimHandleInput?.(key);
      clearEscapeGestures();
      return true;
    },
    [
      vimModeEnabled,
      vimMode,
      revertNextActionOnEscape,
      setSuppressCompletion,
      resetCompletionState,
      inputHistory,
      vimHandleInput,
      clearEscapeGestures,
    ],
  );

  // The single next-action ESC contract shared by every route that owns the
  // key (Chat fallback and chat:escape): revert a just-accepted suggestion
  // first (deferred while vim is in INSERT mode), otherwise dismiss a
  // visible list — both before vim sees the key. Keeping the order in one
  // place stops the routes from drifting apart.
  const tryNextActionEscape = useCallback(
    (key: Key): boolean => {
      if (revertNextActionWithVim(key)) {
        return true;
      }
      // A visible Next list owns ESC before Vim, but the consumed key is
      // still forwarded so vim leaves INSERT or cancels a half-typed
      // operator; clearing the gesture counters afterwards keeps this press
      // from completing or seeding a double-ESC (same order as the revert
      // branch above).
      if (dismissNextActionOnEscape()) {
        vimHandleInput?.(key);
        clearEscapeGestures();
        return true;
      }
      return false;
    },
    [
      revertNextActionWithVim,
      dismissNextActionOnEscape,
      vimHandleInput,
      clearEscapeGestures,
    ],
  );

  // Effect to reset completion if history navigation just occurred and set the text
  useEffect(() => {
    if (suppressCompletion) {
      resetCompletionState();
      resetReverseSearchCompletionState();
      resetCommandSearchCompletionState();
      setExpandedSuggestionIndex(-1);
    }
  }, [
    suppressCompletion,
    buffer.text,
    resetCompletionState,
    setSuppressCompletion,
    resetReverseSearchCompletionState,
    resetCommandSearchCompletionState,
    setExpandedSuggestionIndex,
  ]);

  // Helper function to handle loading queued messages into input
  // Returns true if we should continue with input history navigation
  const tryLoadQueuedMessages = useCallback(() => {
    if (buffer.text.trim() === '' && popAllMessages) {
      const allMessages = popAllMessages();
      if (allMessages) {
        buffer.setText(allMessages);
        return true;
      } else {
        // No queued messages, proceed with input history
        inputHistory.navigateUp();
      }
      return true; // We handled the up arrow key
    }
    return false;
  }, [buffer, popAllMessages, inputHistory]);

  // Handle clipboard pasting. Alt+V is image-only so Windows terminals do not
  // need to route image paste through the general text/OSC52 flow.
  const handleClipboardPaste = useClipboardPaste({ buffer, config });
  const handleClipboardImagePaste = useCallback(() => {
    void handleClipboardPaste({ imageOnly: true });
  }, [handleClipboardPaste]);

  const [isExternalEditorActive, setIsExternalEditorActive] = useState(false);
  const externalEditorBusyRef = useRef(false);
  const handleExternalEditor = useCallback(async () => {
    // A second full session on the same buffer would share one hint and one
    // input lock, and the first Closed event would unlock input while the
    // second editor is still open. During a GUI session this is unreachable —
    // KeypressContext intercepts the relaunch key at the lock and reopens the
    // window itself — but the terminal path never locks, so this stays as the
    // last line of defence.
    if (externalEditorBusyRef.current) {
      return;
    }
    externalEditorBusyRef.current = true;
    setIsExternalEditorActive(true);
    try {
      await buffer.openInExternalEditor();
    } finally {
      externalEditorBusyRef.current = false;
      setIsExternalEditorActive(false);
    }
  }, [buffer]);

  // Determines whether ESC should bypass local handlers (including vim) and
  // propagate to the Global app:escape handler for stream cancellation.
  const shouldEscapeDelegateToApp = useCallback((): boolean => {
    const isVimInsertMode = vimModeEnabled && vimMode === 'INSERT';
    const hasLocalEscapeHandler =
      isVimInsertMode ||
      reverseSearchActive ||
      commandSearchActive ||
      completion.completionMode !== CompletionMode.IDLE ||
      completion.showSuggestions ||
      shouldShowSuggestions ||
      shellModeActive;
    const isGenerating = streamingState !== StreamingState.Idle;
    return Boolean(activeShellId) || (!hasLocalEscapeHandler && isGenerating);
  }, [
    vimModeEnabled,
    vimMode,
    reverseSearchActive,
    commandSearchActive,
    completion.completionMode,
    completion.showSuggestions,
    shouldShowSuggestions,
    shellModeActive,
    streamingState,
    activeShellId,
  ]);

  /**
   * Queue the composer draft for the next turn (Tab, and send-now before it
   * interrupts). Paste placeholders are expanded and image attachments ride
   * along, the same payload a normal submit would carry.
   *
   * - 'blank': whitespace-only draft, cleared without queueing.
   * - 'rejected': nothing was queued (slash/shell input, an image still being
   *   captured, or no queue available); the draft stays for the user.
   * - 'queued': the draft is in the queue and the composer is cleared.
   */
  const queueDraft = useCallback((): 'queued' | 'rejected' | 'blank' => {
    const text = buffer.text;
    const trimmed = text.trim();
    if (!trimmed) {
      buffer.setText('');
      return 'blank';
    }
    if (isSlashInput(trimmed) || shellModeActive) {
      setQueueErrorMessage(
        `${shellModeActive ? 'Shell' : 'Slash'} commands cannot be queued`,
      );
      return 'rejected';
    }
    if (!onQueueMessage) {
      return 'rejected';
    }
    // A pasted clipboard image has no bytes until its capture lands; queueing
    // it now would send an empty attachment.
    if (hasPendingClipboardImages(buffer.imagePastedContent)) {
      setQueueErrorMessage('Image is still being captured, try again');
      return 'rejected';
    }

    const expanded =
      Object.keys(buffer.pastedContent).length > 0
        ? expandPastePlaceholders(text, buffer.pastedContent)
        : text;
    const options: {
      pastedContents?: Record<number, PastedContent>;
      preExpansionText?: string;
      suppressWorkflowKeyword?: boolean;
    } = {};
    if (Object.keys(buffer.imagePastedContent).length > 0) {
      options.pastedContents = { ...buffer.imagePastedContent };
    }
    if (expanded !== text) {
      options.preExpansionText = text;
    }
    if (suppressWorkflowKeyword && hasWorkflowKeyword) {
      options.suppressWorkflowKeyword = true;
    }
    if (Object.keys(options).length > 0) {
      onQueueMessage(expanded, options);
    } else {
      onQueueMessage(expanded);
    }

    buffer.setText('');
    setSuppressWorkflowKeyword(false);
    resetCompletionState();
    resetReverseSearchCompletionState();
    promptCompletion.clear();
    markRestorePending();
    return 'queued';
  }, [
    buffer,
    isSlashInput,
    shellModeActive,
    setQueueErrorMessage,
    onQueueMessage,
    suppressWorkflowKeyword,
    hasWorkflowKeyword,
    resetCompletionState,
    resetReverseSearchCompletionState,
    promptCompletion,
    markRestorePending,
  ]);

  const tryPrefillModelSuggestion = useCallback(
    (index: number): boolean => {
      const { isArgumentCompletion, leafCommand } =
        completion.slashCompletionRange;
      if (!isArgumentCompletion || leafCommand?.name !== 'model') {
        return false;
      }
      const completedText = completion.getCompletedText(
        completion.suggestions[index],
      );
      // Model selection is a two-step interaction: accept the highlighted
      // candidate, then submit. A complete model name must still execute.
      if (!completedText || completedText.trim() === buffer.text.trim()) {
        return false;
      }
      completion.handleAutocomplete(index);
      hasUserNavigatedSuggestions.current = false;
      setExpandedSuggestionIndex(-1);
      return true;
    },
    [buffer.text, completion],
  );

  const handleInput = useCallback(
    (key: Key) => {
      const pendingInsert = pendingInsertRef.current;
      pendingInsertRef.current = null;
      const singleLineSubmitText =
        key.insertable && key.name !== 'paste'
          ? getSingleLineCoalescedSubmitText(key.sequence)
          : null;
      const rememberPendingInsert = () => {
        if (
          shouldSubmitFastReturnAfterInsertable(key) &&
          !key.alt &&
          !key.ctrl &&
          !key.cmd
        ) {
          pendingInsertRef.current = {
            buffer,
            text:
              (pendingInsert?.buffer === buffer ? pendingInsert.text : '') +
              key.sequence,
          };
        }
      };
      // Determine if this keypress is a history navigation command
      const isHistoryUp =
        !shellModeActive &&
        (keyMatchers[Command.HISTORY_UP](key) ||
          (keyMatchers[Command.NAVIGATION_UP](key) &&
            (buffer.allVisualLines.length === 1 ||
              (buffer.visualCursor[0] === 0 && buffer.visualScrollRow === 0))));
      const isHistoryDown =
        !shellModeActive &&
        (keyMatchers[Command.HISTORY_DOWN](key) ||
          (keyMatchers[Command.NAVIGATION_DOWN](key) &&
            (buffer.allVisualLines.length === 1 ||
              buffer.visualCursor[0] === buffer.allVisualLines.length - 1)));

      const isHistoryNav = isHistoryUp || isHistoryDown;
      const isCursorMovement =
        keyMatchers[Command.MOVE_LEFT](key) ||
        keyMatchers[Command.MOVE_RIGHT](key) ||
        keyMatchers[Command.MOVE_UP](key) ||
        keyMatchers[Command.MOVE_DOWN](key) ||
        keyMatchers[Command.MOVE_WORD_LEFT](key) ||
        keyMatchers[Command.MOVE_WORD_RIGHT](key) ||
        keyMatchers[Command.HOME](key) ||
        keyMatchers[Command.END](key);

      const isSuggestionsNav =
        shouldShowSuggestions &&
        (keyMatchers[Command.COMPLETION_UP](key) ||
          keyMatchers[Command.COMPLETION_DOWN](key) ||
          keyMatchers[Command.EXPAND_SUGGESTION](key) ||
          keyMatchers[Command.COLLAPSE_SUGGESTION](key) ||
          keyMatchers[Command.ACCEPT_SUGGESTION](key));

      // Reset completion suppression if the user performs any action other than
      // history navigation or cursor movement.
      // We explicitly skip this if we are currently navigating suggestions.
      if (!isSuggestionsNav) {
        setSuppressCompletion(
          isHistoryNav || isCursorMovement || keyMatchers[Command.ESCAPE](key),
        );
        hasUserNavigatedSuggestions.current = false;

        if (key.name !== 'tab') {
          setForceShowShellSuggestions(false);
        }
      }

      // TODO(jacobr): this special case is likely not needed anymore.
      // We should probably stop supporting paste if the InputPrompt is not
      // focused.
      /// We want to handle paste even when not focused to support drag and drop.
      if (!focus && key.name !== 'paste') {
        return false;
      }

      // Handle escape to close shortcuts panel first, before letting it bubble
      // up for cancellation. This ensures pressing Escape once closes the panel,
      // and pressing again cancels the operation.
      if (shortcutsHelpVisible && key.name === 'escape') {
        setShortcutsHelpVisible(false);
        return true;
      }

      const isGenerating =
        streamingState === StreamingState.Responding ||
        streamingState === StreamingState.WaitingForConfirmation;

      const isQueueMessageKey = keyMatchers[Command.QUEUE_MESSAGE](key);
      const isPlainTab =
        key.name === 'tab' && !key.shift && !key.alt && !key.ctrl && !key.cmd;
      const nextActionsActive = nextActionSuggestions.isVisible;
      const hasTabCompletionInteraction =
        (completion.showSuggestions && shouldShowSuggestions) ||
        Boolean(promptCompletion.text) ||
        nextActionsActive ||
        reverseSearchActive ||
        commandSearchActive;

      if (
        isGenerating &&
        isQueueMessageKey &&
        !hasTabCompletionInteraction &&
        buffer.text.trim().length > 0
      ) {
        queueDraft();
        resetPlainTabPress();
        return true;
      }

      // Send-now (Ctrl+Enter by default, shared with NEWLINE): queue the
      // draft, then interrupt the running model turn so the queue goes out as
      // the next turn. Only without a session binding while a local model
      // turn is responding — slash commands can respond without a model turn,
      // and a permission prompt owns the keyboard. Every other state falls
      // through so the same key still inserts a newline below.
      if (
        streamingState === StreamingState.Responding &&
        isModelTurnActive &&
        !hasSessionBinding &&
        !reverseSearchActive &&
        !commandSearchActive &&
        keyMatchers[Command.SEND_NOW](key)
      ) {
        if (buffer.text.length > 0 && queueDraft() === 'rejected') {
          return true;
        }
        sendQueuedNow();
        return true;
      }

      if (isPlainTab && shellModeActive) {
        resetPlainTabPress();
        if (!shouldShowSuggestions) {
          setSuppressCompletion(false);
          if (promptCompletion.text) {
            promptCompletion.accept();
            return true;
          } else if (
            completion.suggestions.length > 0 &&
            !forceShowShellSuggestions
          ) {
            setForceShowShellSuggestions(true);
            return true;
          }
        }
      } else if (isPlainTab) {
        if (nextActionsActive) {
          resetPlainTabPress();
          if (nextActionSuggestions.accept(0)) {
            return true;
          }
        } else if (!hasTabCompletionInteraction) {
          if (registerPlainTabPress() === 2) {
            // toggleCleanUiDetailsVisible();
            resetPlainTabPress();
            return true;
          }
        } else {
          resetPlainTabPress();
        }
      } else {
        resetPlainTabPress();
      }

      if (key.name === 'paste') {
        if (shortcutsHelpVisible) {
          setShortcutsHelpVisible(false);
        }
        // Guard window: treat any Enter within 40ms as a pasted newline.
        // Uses a ref so the guard is visible synchronously even when
        // PASTE_END + Enter land in the same discreteUpdates batch.
        markUnsafePaste();

        let pasteSequence = key.sequence || '';

        // macOS Cmd+V of a clipboard image often arrives from the terminal as
        // an empty bracketed paste. Probe the system clipboard for an image
        // without disturbing regular text/path paste handling.
        if (process.platform === 'darwin' && pasteSequence.length === 0) {
          void handleClipboardPaste({
            imageOnly: true,
            silentIfNoImage: true,
          });
          return true;
        }

        // When pasting into an empty buffer, detect leading "!" to enter shell mode
        // (matches the typed-"!" behavior).
        if (buffer.text === '' && pasteSequence.startsWith('!')) {
          setShellModeActive(true);
          pasteSequence = pasteSequence.slice(1); // Strip the "!" prefix
          if (pasteSequence.length === 0) {
            // Pasted just "!" — activate shell mode, nothing else to insert
            return true;
          }
        }

        const sequenceToInsert = settings.ui?.escapePastedAtSymbols
          ? escapeAtSymbols(pasteSequence)
          : pasteSequence;
        const insertPasteAsText = () => {
          buffer.handleInput({
            ...key,
            sequence: sequenceToInsert,
          });
        };

        // Dragged/pasted image file paths are consumed in place as inline
        // [Image #N] PastedContent. The path stays out of the prompt and image
        // preparation starts in the background, matching clipboard-image paste.
        // Requires a vision-capable model; otherwise fall back to the normal
        // @-mention rewrite below.
        //
        // Image routing is purely syntactic here. Readability and decoding are
        // resolved behind the stable placeholder by the async image pipeline.
        if (
          !shellModeActive &&
          (!currentModel || isVisionSupportedModel(listedModel)) &&
          mayContainPastedFilePaths(pasteSequence)
        ) {
          const pastedImageSplit = extractPastedImagePaths(pasteSequence);
          if (pastedImageSplit) {
            insertPastedImageFilePaths(
              buffer,
              pastedImageSplit.imagePaths,
              pastedImageSplit.otherPaths,
            );
            return true;
          }
        }

        insertPasteAsText();

        return true;
      }

      if (shortcutsHelpVisible && isHelpDismissKey(key)) {
        setShortcutsHelpVisible(false);
      }

      if (shortcutsHelpVisible) {
        if (key.sequence === '?' && key.insertable) {
          setShortcutsHelpVisible(false);
          buffer.handleInput(key);
          return true;
        }
        // Escape is handled earlier to ensure it closes the panel before
        // potentially cancelling an operation
        if (key.name === 'backspace' || key.sequence === '\b') {
          setShortcutsHelpVisible(false);
          return true;
        }
        if (key.insertable) {
          setShortcutsHelpVisible(false);
        }
      }

      if (
        key.sequence === '?' &&
        key.insertable &&
        !shortcutsHelpVisible &&
        buffer.text.length === 0
      ) {
        setShortcutsHelpVisible(true);
        return true;
      }

      // Reset ESC count and hide prompt on any non-ESC key
      if (key.name !== 'escape') {
        resetEscapeState();
      }

      if (keyMatchers[Command.ESCAPE](key) && shouldEscapeDelegateToApp()) {
        return false;
      }

      // A single ESC undoes a just-accepted next-action suggestion (deferred
      // until vim reaches NORMAL mode) or dismisses a visible preview —
      // both before vim gets the key.
      if (keyMatchers[Command.ESCAPE](key) && tryNextActionEscape(key)) {
        return true;
      }

      if (
        !(vimMode === 'INSERT' && singleLineSubmitText) &&
        vimHandleInput &&
        vimHandleInput(key)
      ) {
        if (vimMode === 'INSERT') {
          rememberPendingInsert();
        }
        return true;
      }

      // Ctrl+O to expand/collapse paste placeholders
      if (keyMatchers[Command.EXPAND_PASTE](key)) {
        const handled = tryTogglePasteExpansion(buffer);
        if (handled) return true;
      }

      if (
        key.insertable &&
        key.sequence.startsWith('!') &&
        buffer.text === '' &&
        !(completion.showSuggestions && shouldShowSuggestions)
      ) {
        setShellModeActive(!shellModeActive);
        const remainingInput = key.sequence.slice(1);
        if (remainingInput.length > 0) {
          buffer.handleInput({ ...key, sequence: remainingInput });
        } else {
          buffer.setText(''); // Clear the '!' from input
        }
        return true;
      }

      if (keyMatchers[Command.ESCAPE](key)) {
        if (reverseSearchActive) {
          reverseSearch.cancel();
          setExpandedSuggestionIndex(-1);
          return true;
        }
        if (commandSearchActive) {
          commandSearch.cancel();
          setExpandedSuggestionIndex(-1);
          return true;
        }

        if (completion.showSuggestions && shouldShowSuggestions) {
          completion.resetCompletionState();
          setExpandedSuggestionIndex(-1);
          resetEscapeState();
          onFooterSuggestionsRelease?.();
          return true;
        }

        if (promptCompletion.text) {
          promptCompletion.clear();
          resetEscapeState();
          return true;
        }

        if (shellModeActive) {
          // Let app:escape handle abort when a command is running.
          if (activeShellId) {
            return false;
          }
          setShellModeActive(false);
          resetEscapeState();
          return true;
        }

        // If we're generating and no local overlay consumed Escape, let it
        // propagate to the global cancellation handler.
        if (isGenerating) {
          return false;
        }

        handleEscPress();
        return true;
      }

      // NOTE: CLEAR_SCREEN (ctrl+l) handling removed — context routing now maps
      // ctrl+l to app:toggleBackgroundShellList via cross-context cascade to Global.
      // The old clear-screen behavior is superseded by the context binding system.

      if (shellModeActive && keyMatchers[Command.REVERSE_SEARCH](key)) {
        reverseSearch.enter();
        return true;
      }

      if (reverseSearchActive || commandSearchActive) {
        const search = commandSearchActive ? commandSearch : reverseSearch;
        const sc = search.completion;
        const {
          activeSuggestionIndex,
          navigateUp,
          navigateDown,
          showSuggestions,
          suggestions,
        } = sc;

        if (showSuggestions) {
          if (keyMatchers[Command.NAVIGATION_UP](key)) {
            navigateUp();
            return true;
          }
          if (keyMatchers[Command.NAVIGATION_DOWN](key)) {
            navigateDown();
            return true;
          }
          if (keyMatchers[Command.COLLAPSE_SUGGESTION](key)) {
            if (suggestions[activeSuggestionIndex].label.length >= MAX_WIDTH) {
              setExpandedSuggestionIndex(-1);
              return true;
            }
          }
          if (keyMatchers[Command.EXPAND_SUGGESTION](key)) {
            if (suggestions[activeSuggestionIndex].label.length >= MAX_WIDTH) {
              setExpandedSuggestionIndex(activeSuggestionIndex);
              return true;
            }
          }
          if (keyMatchers[Command.ACCEPT_SUGGESTION_REVERSE_SEARCH](key)) {
            search.finish({ autocomplete: true });
            return true;
          }
        }

        if (keyMatchers[Command.SUBMIT_REVERSE_SEARCH](key)) {
          const textToSubmit = search.resolveSubmitText();
          handleSubmit(textToSubmit);
          search.finish();
          return true;
        }

        // Prevent up/down from falling through to regular history navigation
        if (
          keyMatchers[Command.NAVIGATION_UP](key) ||
          keyMatchers[Command.NAVIGATION_DOWN](key)
        ) {
          return true;
        }
      }

      // If the command is a perfect match, pressing enter should execute it.
      // We prioritize execution unless the user is explicitly selecting a different suggestion.
      if (
        completion.isPerfectMatch &&
        keyMatchers[Command.SUBMIT](key) &&
        !isRecentPaste() &&
        (!(completion.showSuggestions && shouldShowSuggestions) ||
          (completion.activeSuggestionIndex <= 0 &&
            !hasUserNavigatedSuggestions.current))
      ) {
        handleSubmit(buffer.text);
        return true;
      }

      // Newline insertion
      if (keyMatchers[Command.NEWLINE](key)) {
        buffer.newline();
        return true;
      }

      if (completion.showSuggestions && shouldShowSuggestions) {
        if (completion.suggestions.length > 1) {
          if (keyMatchers[Command.COMPLETION_UP](key)) {
            completion.navigateUp();
            hasUserNavigatedSuggestions.current = true;
            setExpandedSuggestionIndex(-1); // Reset expansion when navigating
            return true;
          }
          if (keyMatchers[Command.COMPLETION_DOWN](key)) {
            completion.navigateDown();
            hasUserNavigatedSuggestions.current = true;
            setExpandedSuggestionIndex(-1); // Reset expansion when navigating
            return true;
          }
        }

        if (keyMatchers[Command.ACCEPT_SUGGESTION](key)) {
          const isEnterKey = key.name === 'enter' && !key.ctrl;
          if (completion.suggestions.length > 0) {
            const targetIndex =
              completion.activeSuggestionIndex === -1
                ? 0 // Default to the first if none is active
                : completion.activeSuggestionIndex;

            if (targetIndex < completion.suggestions.length) {
              const suggestion = completion.suggestions[targetIndex];

              if (isEnterKey && shellModeActive) {
                if (hasUserNavigatedSuggestions.current) {
                  completion.handleAutocomplete(
                    completion.activeSuggestionIndex,
                  );
                  setExpandedSuggestionIndex(-1);
                  hasUserNavigatedSuggestions.current = false;
                  return true;
                }
                completion.resetCompletionState();
                setExpandedSuggestionIndex(-1);
                hasUserNavigatedSuggestions.current = false;
                if (buffer.text.trim()) {
                  handleSubmit(buffer.text);
                }
                return true;
              }

              if (isEnterKey && isSlashInput(buffer.text)) {
                if (suggestion.submitValue) {
                  setExpandedSuggestionIndex(-1);
                  handleSubmit(suggestion.submitValue.trim(), 'menu');
                  return true;
                }

                if (tryPrefillModelSuggestion(targetIndex)) {
                  return true;
                }

                const {
                  isArgumentCompletion,
                  leafCommand,
                  completionStart,
                  completionEnd,
                } = completion.slashCompletionRange;

                // Argument completion with a typed partial argument
                // (completionStart < completionEnd): Enter submits exactly
                // what the user typed unless they explicitly navigated to a
                // suggestion (mirrors shell-mode Enter). The auto-highlighted
                // first row must not hijack a plain Enter — e.g.
                // `/add-dir D:\foo` should submit D:\foo, not the first
                // directory suggestion. When the argument position is empty
                // (completionStart === completionEnd) the existing
                // auto-execute/autocomplete behavior is preserved.
                if (
                  isArgumentCompletion &&
                  !hasUserNavigatedSuggestions.current &&
                  completionStart < completionEnd
                ) {
                  completion.resetCompletionState();
                  setExpandedSuggestionIndex(-1);
                  hasUserNavigatedSuggestions.current = false;
                  if (buffer.text.trim()) {
                    handleSubmit(buffer.text);
                  }
                  return true;
                }

                if (
                  isArgumentCompletion &&
                  isAutoExecutableCommand(leafCommand)
                ) {
                  // isArgumentCompletion guarantees leafCommand exists
                  const completedText = completion.getCompletedText(suggestion);
                  if (completedText) {
                    setExpandedSuggestionIndex(-1);
                    hasUserNavigatedSuggestions.current = false;
                    handleSubmit(completedText.trim(), 'menu');
                    return true;
                  }
                } else if (!isArgumentCompletion) {
                  // Existing logic for command name completion
                  const command =
                    completion.getCommandFromSuggestion(suggestion);

                  // Only auto-execute if the command has no completion function
                  // (i.e., it doesn't require an argument to be selected)
                  if (
                    command &&
                    isAutoExecutableCommand(command) &&
                    !command.completion
                  ) {
                    const completedText =
                      completion.getCompletedText(suggestion);

                    if (completedText) {
                      setExpandedSuggestionIndex(-1);
                      handleSubmit(completedText.trim(), 'menu');
                      return true;
                    }
                  }
                }
              }

              // Default behavior: auto-complete to prompt box
              // For Tab: always autocomplete the text into the input
              // For Enter + AT mode: autocomplete into input (don't submit)
              // For Enter + other modes: submit the completed text directly
              if (isEnterKey) {
                if (completion.completionMode === CompletionMode.AT) {
                  // AT mode: insert into buffer, let user keep editing
                  completion.handleAutocomplete(targetIndex);
                  setExpandedSuggestionIndex(-1);
                  return true;
                }
                const completedText = completion.getCompletedText(suggestion);
                completion.resetCompletionState();
                setExpandedSuggestionIndex(-1);
                if (completedText && completedText.trim()) {
                  handleSubmit(completedText.trim(), 'menu');
                }
                return true;
              }

              completion.handleAutocomplete(targetIndex);
              // Accepting a completion swaps in a whole new suggestion list
              // (often a new command level) whose index is reset to 0, so the
              // previous level's navigation state must not carry over — it
              // would make the next Enter look "explicitly selected".
              hasUserNavigatedSuggestions.current = false;
              setExpandedSuggestionIndex(-1); // Reset expansion after selection
            }
          }
          // Only swallow key when suggestions exist or it's Tab (prevent tab insertion).
          // Let Enter fall through to submission when no suggestions to accept.
          if (completion.suggestions.length > 0 || key.name === 'tab') {
            return true;
          }
        }
      }

      // Handle Tab key for command ghost text acceptance
      if (
        key.name === 'tab' &&
        !key.shift &&
        !(completion.showSuggestions && shouldShowSuggestions) &&
        promptCompletion.text
      ) {
        promptCompletion.accept();
        return true;
      }

      if (!shellModeActive) {
        if (keyMatchers[Command.REVERSE_SEARCH](key)) {
          commandSearch.enter();
          return true;
        }

        if (isHistoryUp) {
          if (
            !inputHistory.isNavigatingHistory &&
            keyMatchers[Command.NAVIGATION_UP](key) &&
            buffer.visualCursor[1] > 0
          ) {
            buffer.move('home');
            return true;
          }
          // Check for queued messages first when input is empty
          // If no queued messages, inputHistory.navigateUp() is called inside tryLoadQueuedMessages
          if (tryLoadQueuedMessages()) {
            return true;
          }
          // Only navigate history if popAllMessages doesn't exist
          inputHistory.navigateUp();
          return true;
        }
        if (isHistoryDown) {
          if (
            keyMatchers[Command.NAVIGATION_DOWN](key) &&
            buffer.visualCursor[1] <
              cpLen(buffer.allVisualLines[buffer.visualCursor[0]] || '')
          ) {
            buffer.move('end');
            return true;
          }
          if (inputHistory.navigateDown()) {
            return true;
          }
          // At bottom of history — let the composer hand focus to a lower
          // overlay such as AgentSessionRail when one is available.
          if (onHistoryDownOverflow?.()) {
            return true;
          }
          return false;
        }
      } else {
        // Shell History Navigation
        if (keyMatchers[Command.NAVIGATION_UP](key)) {
          if (
            (buffer.allVisualLines.length === 1 ||
              (buffer.visualCursor[0] === 0 && buffer.visualScrollRow === 0)) &&
            buffer.visualCursor[1] > 0
          ) {
            buffer.move('home');
            return true;
          }
          const prevCommand = shellHistory.getPreviousCommand();
          if (prevCommand !== null) buffer.setText(prevCommand);
          return true;
        }
        if (keyMatchers[Command.NAVIGATION_DOWN](key)) {
          if (
            (buffer.allVisualLines.length === 1 ||
              buffer.visualCursor[0] === buffer.allVisualLines.length - 1) &&
            buffer.visualCursor[1] <
              cpLen(buffer.allVisualLines[buffer.visualCursor[0]] || '')
          ) {
            buffer.move('end');
            return true;
          }
          const nextCommand = shellHistory.getNextCommand();
          if (nextCommand !== null) buffer.setText(nextCommand);
          return true;
        }
      }

      if (singleLineSubmitText) {
        const nextText = previewSingleLineInsert(
          buffer,
          (pendingInsert?.buffer === buffer ? pendingInsert.text : '') +
            singleLineSubmitText,
        );
        if (nextText.trim()) {
          handleSubmit(nextText);
        }
        return true;
      }

      if (keyMatchers[Command.SUBMIT](key)) {
        if (isRecentPaste()) {
          buffer.newline();
          return true;
        }

        const textToSubmit =
          key.coalescedSubmitText && pendingInsert?.buffer === buffer
            ? previewSingleLineInsert(buffer, pendingInsert.text)
            : buffer.text;

        if (textToSubmit.trim()) {
          const [row, col] = buffer.cursor;
          const line = buffer.lines[row];
          const charBefore = col > 0 ? cpSlice(line, col - 1, col) : '';
          if (charBefore === '\\') {
            buffer.backspace();
            buffer.newline();
          } else {
            handleSubmit(textToSubmit);
          }
        }
        return true;
      }

      // NOTE: HOME/END, KILL_LINE_RIGHT/LEFT, and DELETE_WORD_BACKWARD handling
      // removed here — these are generic text-editing commands now handled by
      // buffer.handleInput (text-buffer.ts), so every TextInput surface gets
      // them, not just the main prompt. They are reached via the delegation to
      // buffer.handleInput below.

      // External editor
      if (keyMatchers[Command.OPEN_EXTERNAL_EDITOR](key)) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        handleExternalEditor();
        return true;
      }

      // Alt+V for image-only clipboard paste
      if (keyMatchers[Command.PASTE_CLIPBOARD_IMAGE](key)) {
        handleClipboardImagePaste();
        return true;
      }

      // Application-level clipboard fallback where input.paste is configured.
      // Native Windows text paste is terminal-owned by default.
      if (keyMatchers[Command.PASTE_CLIPBOARD](key)) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        handleClipboardPaste();
        return true;
      }

      // Ctrl+B is handled by the conditionally registered Chat action while a
      // foreground execution exists. Otherwise this fallback interprets it as
      // MOVE_LEFT.

      // NOTE: CLEAR_INPUT (ctrl+c) handling removed — the Chat:edit:clear action
      // handler now handles this. It clears buffer + resets completion, returns false
      // to cascade to Global:app:interrupt for quit counting.

      // Exit shell mode on backspace when input is empty
      if (
        shellModeActive &&
        buffer.text === '' &&
        keyMatchers[Command.DELETE_CHAR_LEFT](key)
      ) {
        setShellModeActive(false);
        return true;
      }

      // Fall back to the text buffer's default input handling for all other keys
      const handled = buffer.handleInput(key);

      if (handled) {
        rememberPendingInsert();
        // Clear completion affordances when user types regular characters.
        if (
          promptCompletion.text &&
          key.insertable &&
          !key.alt &&
          !key.ctrl &&
          !key.cmd
        ) {
          promptCompletion.clear();
          setExpandedSuggestionIndex(-1);
        }
        if (
          nextActionsActive &&
          key.insertable &&
          !key.alt &&
          !key.ctrl &&
          !key.cmd
        ) {
          nextActionSuggestions.clear();
        }
      }
      return handled;
    },
    [
      focus,
      activeShellId,
      buffer,
      completion,
      setForceShowShellSuggestions,
      shellModeActive,
      setShellModeActive,
      inputHistory,
      handleSubmit,
      shellHistory,
      reverseSearch,
      handleClipboardImagePaste,
      handleClipboardPaste,
      handleExternalEditor,
      currentModel,
      listedModel,
      resetEscapeState,
      vimHandleInput,
      vimMode,
      reverseSearchActive,
      isRecentPaste,
      markUnsafePaste,
      commandSearchActive,
      commandSearch,
      shortcutsHelpVisible,
      setShortcutsHelpVisible,
      tryLoadQueuedMessages,
      onFooterSuggestionsRelease,
      onHistoryDownOverflow,
      streamingState,
      handleEscPress,
      registerPlainTabPress,
      resetPlainTabPress,
      shouldShowSuggestions,
      forceShowShellSuggestions,
      keyMatchers,
      isHelpDismissKey,
      settings,
      shouldEscapeDelegateToApp,
      promptCompletion,
      nextActionSuggestions,
      tryNextActionEscape,
      isSlashInput,
      queueDraft,
      isModelTurnActive,
      hasSessionBinding,
      sendQueuedNow,
      tryPrefillModelSuggestion,
    ],
  );

  // ─── Keyboard Context Registration (Phase 1) ───
  // Chat context is now managed centrally by useAppFocusContextSync() in AppContainer.
  // Only non-managed contexts are registered here.
  useRegisterKeyboardContext(
    'Autocomplete',
    shouldShowSuggestions && completion.suggestions.length > 1,
  );
  useRegisterKeyboardContext('HistorySearch', reverseSearchActive);
  useRegisterKeyboardContext('CommandSearch', commandSearchActive);

  // ─── Autocomplete Action Handlers (Phase 2, Step 2.5) ───
  const autocompleteActive =
    shouldShowSuggestions && completion.suggestions.length > 1;
  useRegisterActionHandlers(
    'Autocomplete',
    {
      'suggest:focusPrevious': () => {
        completion.navigateUp();
        hasUserNavigatedSuggestions.current = true;
        setExpandedSuggestionIndex(-1);
        return true;
      },
      'suggest:focusNext': () => {
        completion.navigateDown();
        hasUserNavigatedSuggestions.current = true;
        setExpandedSuggestionIndex(-1);
        return true;
      },
      'suggest:accept': (key) => {
        const isEnterKey = key.name === 'enter' && !key.ctrl;

        // Enter on a fully-typed runnable command (e.g. `/plugins `) belongs to
        // the command itself, not to the auto-highlighted first subcommand.
        // Returning false hands the key back to context routing, which walks on
        // to Chat's `enter → input:submit` binding; no handler is registered for
        // it, so the Chat fallback runs handleInput and its perfect-match fast
        // path owns the decision. Keeping that decision in one place is the
        // point — this handler is a near-copy of handleInput, and the rule was
        // previously only in the copy that never ran for multi-suggestion
        // dropdowns. NOTE: registering a real 'input:submit' action handler for
        // Chat would intercept before the fallback and silently break this.
        // Tab is unaffected: it still completes the highlighted row.
        if (
          isEnterKey &&
          completion.slashCompletionRange.isCompletedRunnableCommand &&
          completion.activeSuggestionIndex <= 0 &&
          !hasUserNavigatedSuggestions.current
        ) {
          return false;
        }

        if (completion.suggestions.length > 0) {
          const targetIndex =
            completion.activeSuggestionIndex === -1
              ? 0
              : completion.activeSuggestionIndex;

          if (targetIndex < completion.suggestions.length) {
            const suggestion = completion.suggestions[targetIndex];

            if (isEnterKey && shellModeActive) {
              if (hasUserNavigatedSuggestions.current) {
                completion.handleAutocomplete(completion.activeSuggestionIndex);
                setExpandedSuggestionIndex(-1);
                hasUserNavigatedSuggestions.current = false;
                return true;
              }
              completion.resetCompletionState();
              setExpandedSuggestionIndex(-1);
              hasUserNavigatedSuggestions.current = false;
              if (buffer.text.trim()) {
                handleSubmit(buffer.text);
              }
              return true;
            }

            if (isEnterKey && isSlashInput(buffer.text)) {
              if (suggestion.submitValue) {
                setExpandedSuggestionIndex(-1);
                handleSubmit(suggestion.submitValue.trim(), 'menu');
                return true;
              }

              if (tryPrefillModelSuggestion(targetIndex)) {
                return true;
              }

              const {
                isArgumentCompletion,
                leafCommand,
                completionStart,
                completionEnd,
              } = completion.slashCompletionRange;

              // Argument completion with a typed partial argument: Enter
              // submits exactly what the user typed unless they explicitly
              // navigated to a suggestion (mirrors shell-mode Enter and the
              // handleInput branch above). Empty argument position keeps the
              // existing auto-execute/autocomplete behavior.
              if (
                isArgumentCompletion &&
                !hasUserNavigatedSuggestions.current &&
                completionStart < completionEnd
              ) {
                completion.resetCompletionState();
                setExpandedSuggestionIndex(-1);
                hasUserNavigatedSuggestions.current = false;
                if (buffer.text.trim()) {
                  handleSubmit(buffer.text);
                }
                return true;
              }

              if (
                isArgumentCompletion &&
                isAutoExecutableCommand(leafCommand)
              ) {
                const completedText = completion.getCompletedText(suggestion);
                if (completedText) {
                  setExpandedSuggestionIndex(-1);
                  hasUserNavigatedSuggestions.current = false;
                  handleSubmit(completedText.trim(), 'menu');
                  return true;
                }
              } else if (!isArgumentCompletion) {
                const command = completion.getCommandFromSuggestion(suggestion);
                if (
                  command &&
                  isAutoExecutableCommand(command) &&
                  !command.completion
                ) {
                  const completedText = completion.getCompletedText(suggestion);
                  if (completedText) {
                    setExpandedSuggestionIndex(-1);
                    handleSubmit(completedText.trim(), 'menu');
                    return true;
                  }
                }
              }
            }

            if (isEnterKey) {
              if (completion.completionMode === CompletionMode.AT) {
                // AT mode: insert into buffer, let user keep editing
                completion.handleAutocomplete(targetIndex);
                setExpandedSuggestionIndex(-1);
                return true;
              }
              const completedText = completion.getCompletedText(suggestion);
              completion.resetCompletionState();
              setExpandedSuggestionIndex(-1);
              if (completedText && completedText.trim()) {
                handleSubmit(completedText.trim(), 'menu');
              }
              return true;
            }

            completion.handleAutocomplete(targetIndex);
            // Mirrors handleInput: the accepted completion produces a fresh
            // suggestion list, so the old navigation state is stale.
            hasUserNavigatedSuggestions.current = false;
            setExpandedSuggestionIndex(-1);
          }
        }
        return true;
      },
      'suggest:expand': () => {
        const { suggestions, activeSuggestionIndex } = completion;
        if (
          activeSuggestionIndex >= 0 &&
          activeSuggestionIndex < suggestions.length &&
          suggestions[activeSuggestionIndex].label.length >= MAX_WIDTH
        ) {
          setExpandedSuggestionIndex(activeSuggestionIndex);
          return true;
        }
        return true;
      },
      'suggest:collapse': () => {
        const { suggestions, activeSuggestionIndex } = completion;
        if (
          activeSuggestionIndex >= 0 &&
          activeSuggestionIndex < suggestions.length &&
          suggestions[activeSuggestionIndex].label.length >= MAX_WIDTH
        ) {
          setExpandedSuggestionIndex(-1);
          return true;
        }
        return true;
      },
      'basic:cancel': () => {
        // ESC while the dropdown is open closes it and keeps the text; a
        // just-accepted suggestion stays revertable on the next ESC
        // (revertNextActionOnEscape declines while suggestions show).
        completion.resetCompletionState();
        setExpandedSuggestionIndex(-1);
        onFooterSuggestionsRelease?.();
        return true;
      },
    },
    autocompleteActive,
  );

  // ─── HistorySearch Action Handlers (Phase 2, Step 2.9) ───
  useRegisterActionHandlers(
    'HistorySearch',
    {
      'history:search:next': () =>
        // Ctrl+R cycles to next match (already in search mode)
        true, // handled by existing search logic in handleInput
      'history:search:accept': () => {
        reverseSearch.finish({ autocomplete: true });
        return true;
      },
      'history:search:submit': () => {
        const textToSubmit = reverseSearch.resolveSubmitText();
        handleSubmit(textToSubmit);
        reverseSearch.finish();
        return true;
      },
      'history:search:cancel': () => {
        reverseSearch.cancel();
        setExpandedSuggestionIndex(-1);
        return true;
      },
    },
    reverseSearchActive,
  );

  // ─── CommandSearch Action Handlers (Phase 2, Step 2.9) ───
  useRegisterActionHandlers(
    'CommandSearch',
    {
      'suggest:focusPrevious': () => {
        if (commandSearchCompletion.showSuggestions) {
          commandSearchCompletion.navigateUp();
          return true;
        }
        return true; // Prevent falling through to history nav
      },
      'suggest:focusNext': () => {
        if (commandSearchCompletion.showSuggestions) {
          commandSearchCompletion.navigateDown();
          return true;
        }
        return true;
      },
      'suggest:accept': () => {
        commandSearch.finish({ autocomplete: true });
        return true;
      },
      'basic:cancel': () => {
        commandSearch.cancel();
        setExpandedSuggestionIndex(-1);
        return true;
      },
    },
    commandSearchActive,
  );

  // ─── Chat Action Handlers (Phase 3) ───
  // Dedicated action handlers for critical Chat keys that need explicit
  // cascading behavior (returning false to let the next context handle).
  useRegisterActionHandlers(
    'Chat',
    {
      'chat:escape': (_key: Key) => {
        // ESC handling extracted from handleInput so the context routing system
        // dispatches it directly (rather than relying on the Chat fallback, which
        // is blocked when Global's app:escape handler exists).

        // Mirror the handleInput focus guard: an unfocused prompt must not
        // consume ESC (single or double press) — cascade to the overlay /
        // Global layers instead of clearing the composer behind the user.
        if (!focus) {
          return false;
        }

        if (shouldEscapeDelegateToApp()) {
          return false;
        }

        // A single ESC undoes a just-accepted next-action suggestion
        // (deferred until vim reaches NORMAL mode) or dismisses a visible
        // Next list — both before vim gets the key.
        if (tryNextActionEscape(_key)) {
          return true;
        }

        // Vim INSERT → NORMAL: when vim is in INSERT mode, ESC should transition
        // to NORMAL mode rather than triggering chat escape/rewind behavior.
        // vimHandleInput returns true if vim consumed the key (INSERT→NORMAL).
        if (vimHandleInput && vimHandleInput(_key)) {
          return true;
        }

        // Cancel reverse search
        if (reverseSearchActive) {
          reverseSearch.cancel();
          setExpandedSuggestionIndex(-1);
          return true;
        }
        // Cancel command search
        if (commandSearchActive) {
          commandSearch.cancel();
          setExpandedSuggestionIndex(-1);
          return true;
        }
        // Dismiss the inline ghost. A visible dropdown owns ESC first, but
        // otherwise this has to run before the reset below: that branch is
        // unconditionally true on a slash line (completionMode !== IDLE), so it
        // would swallow ESC while leaving the ghost on screen. Sits after
        // shouldEscapeDelegateToApp() so ESC during generation still cancels.
        if (
          !(completion.showSuggestions && shouldShowSuggestions) &&
          promptCompletion.text
        ) {
          promptCompletion.clear();
          resetEscapeState();
          return true;
        }
        // Dismiss autocomplete suggestions.
        // Use completionMode !== IDLE as the primary guard because it is
        // computed synchronously (useMemo) from the buffer text, whereas
        // showSuggestions depends on derived state that may lag behind due
        // to async useEffect chains in the completion hooks. This ensures
        // ESC always closes visible suggestions before cascading to
        // app:escape for stream cancellation.
        // Exception: while the agent is responding, a slash line keeps
        // completionMode non-IDLE purely from the buffer text — even after
        // the dropdown was dismissed — so treating that as a local ESC
        // handler would swallow every subsequent ESC and leave the running
        // task uncancellable until the user clears the input. While
        // responding, only actually visible suggestions may own ESC;
        // otherwise the key falls through to the app:escape cascade below.
        const suggestionsVisible =
          completion.showSuggestions || shouldShowSuggestions;
        if (
          (completion.completionMode !== CompletionMode.IDLE ||
            suggestionsVisible) &&
          (streamingState === StreamingState.Idle || suggestionsVisible)
        ) {
          completion.resetCompletionState();
          setExpandedSuggestionIndex(-1);
          resetEscapeState();
          onFooterSuggestionsRelease?.();
          return true;
        }
        // Exit shell mode
        if (shellModeActive) {
          // Let app:escape handle abort when a command is running.
          if (activeShellId) {
            return false;
          }
          setShellModeActive(false);
          resetEscapeState();
          return true;
        }
        // If streaming, cascade to Global app:escape for cancellation
        if (streamingState !== StreamingState.Idle) {
          return false;
        }
        // Double-press ESC → rewind (or clear buffer)
        handleEscPress();
        return true;
      },
      'chat:workflowKeywordToggle': () => {
        if (!focus || !hasWorkflowKeyword) return false;
        setSuppressWorkflowKeyword((current) => !current);
        return true;
      },
      'edit:deleteLeft': (key: Key) => {
        const isBackspace =
          key.name === 'backspace' ||
          key.sequence === '\b' ||
          key.sequence === '\x7f';
        if (
          focus &&
          isBackspace &&
          !suppressWorkflowKeyword &&
          workflowKeywordRanges.some(
            (range) => range.end === buffer.getOffset(),
          )
        ) {
          setSuppressWorkflowKeyword(true);
          return true;
        }
        return false;
      },
      'edit:clear': (key: Key) => {
        // Ctrl+C: clear buffer + reset completion + reset history nav, then
        // return false so the event cascades to Global:app:interrupt for quit counting.
        buffer.handleInput(key);
        resetCompletionState();
        inputHistory.resetHistoryNav();
        onFooterSuggestionsRelease?.();
        return false; // cascade to Global:app:interrupt
      },
      'input:paste': () => {
        void handleClipboardPaste();
        return true;
      },
      'input:pasteImage': () => {
        handleClipboardImagePaste();
        return true;
      },
      'input:stash': () => {
        // Mirror the chat:escape focus guard: an unfocused prompt must not
        // rearrange the composer behind the user.
        if (!focus) {
          return false;
        }
        const result = toggleStash();
        // Nothing to stash and nothing to bring back: stay silent and let the
        // key cascade, exactly as it did before this binding existed.
        if (result === 'noop') {
          return false;
        }
        resetCompletionState();
        resetReverseSearchCompletionState();
        inputHistory.resetHistoryNav();
        return true;
      },
    },
    true,
  );

  // ─── Chat Fallback Handler (Phase 2, Step 2.6) ───
  // The Chat context's handleInput is too complex to split into individual
  // action handlers (side effects, state machines, paste handling, etc.).
  // We register the existing handleInput as a fallback so the context routing
  // system can delegate to it for any key not handled by a more specific context.
  //
  // IMPORTANT: The legacy useKeypress(handleInput) is REMOVED because it caused
  // double execution — when the Chat fallback called handleInput which returned
  // false (e.g. Ctrl+C CLEAR_INPUT), context routing fell through to legacy,
  // causing handleInput to fire twice. Now the Chat fallback is the ONLY path.
  //
  // When handleInput returns false (e.g. Ctrl+C: buffer cleared but needs to
  // bubble for quit counting), context routing falls through to legacy handlers
  // that are still registered at lower priorities (e.g. AppContainer quit at 50).
  useRegisterFallbackHandler(
    'Chat',
    useCallback(
      (key: Key) => handleInput(key) || false,
      [handleInput],
    ),
    true,
  );

  // Legacy suggest FocusZone removed — now handled by Autocomplete context
  // action handlers (suggest:focusPrevious, suggest:focusNext, etc.) registered above.

  const [cursorVisualRowAbsolute, cursorVisualColAbsolute] =
    buffer.visualCursor;

  // Spell checking is for prose the user is composing. Shell commands, history
  // search and the external editor's placeholder are either
  // not prose or not settled enough to judge, and underlines are noise to a
  // screen reader.
  const { spansByLine: spellcheckSpansByLine, color: spellcheckColor } =
    useSpellcheckHighlights({
      buffer,
      active:
        focus &&
        !shellModeActive &&
        !reverseSearchActive &&
        !commandSearchActive &&
        !isExternalEditorActive &&
        !config.getScreenReader(),
      settings: settingsState,
    });

  // Declare the terminal cursor position so the OS IME candidate window
  // follows the text caret (critical for CJK input methods).
  const cursorLineText =
    buffer.viewportVisualLines[
      cursorVisualRowAbsolute - buffer.visualScrollRow
    ] ?? '';
  const inputCursorRef = useDeclaredCursor({
    line: cursorVisualRowAbsolute - buffer.visualScrollRow,
    column: stringWidth(cpSlice(cursorLineText, 0, cursorVisualColAbsolute)),
    active: Boolean(showCursor),
  });

  const getGhostTextLines = useCallback(() => {
    if (
      !promptCompletion.text ||
      !buffer.text ||
      !promptCompletion.text.startsWith(buffer.text)
    ) {
      return { inlineGhost: '', additionalLines: [] };
    }

    const ghostSuffix = promptCompletion.text.slice(buffer.text.length);
    if (!ghostSuffix) {
      return { inlineGhost: '', additionalLines: [] };
    }

    const currentLogicalLine = buffer.lines[buffer.cursor[0]] || '';
    const cursorCol = buffer.cursor[1];

    const textBeforeCursor = cpSlice(currentLogicalLine, 0, cursorCol);
    const usedWidth = stringWidth(textBeforeCursor);
    const remainingWidth = Math.max(0, inputWidth - usedWidth);

    const ghostTextLinesRaw = ghostSuffix.split('\n');
    const firstLineRaw = ghostTextLinesRaw.shift() || '';

    let inlineGhost = '';
    let remainingFirstLine = '';

    if (stringWidth(firstLineRaw) <= remainingWidth) {
      inlineGhost = firstLineRaw;
    } else {
      const words = firstLineRaw.split(' ');
      let currentLine = '';
      let wordIdx = 0;
      for (const word of words) {
        const prospectiveLine = currentLine ? `${currentLine} ${word}` : word;
        if (stringWidth(prospectiveLine) > remainingWidth) {
          break;
        }
        currentLine = prospectiveLine;
        wordIdx++;
      }
      inlineGhost = currentLine;
      if (words.length > wordIdx) {
        remainingFirstLine = words.slice(wordIdx).join(' ');
      }
    }

    const linesToWrap = [];
    if (remainingFirstLine) {
      linesToWrap.push(remainingFirstLine);
    }
    linesToWrap.push(...ghostTextLinesRaw);
    const remainingGhostText = linesToWrap.join('\n');

    const additionalLines: string[] = [];
    if (remainingGhostText) {
      const textLines = remainingGhostText.split('\n');
      for (const textLine of textLines) {
        const words = textLine.split(' ');
        let currentLine = '';

        for (const word of words) {
          const prospectiveLine = currentLine ? `${currentLine} ${word}` : word;
          const prospectiveWidth = stringWidth(prospectiveLine);

          if (prospectiveWidth > inputWidth) {
            if (currentLine) {
              additionalLines.push(currentLine);
            }

            let wordToProcess = word;
            while (stringWidth(wordToProcess) > inputWidth) {
              let part = '';
              const wordCP = toCodePoints(wordToProcess);
              let partWidth = 0;
              let splitIndex = 0;
              for (let i = 0; i < wordCP.length; i++) {
                const char = wordCP[i];
                const charWidth = stringWidth(char);
                if (partWidth + charWidth > inputWidth) {
                  break;
                }
                part += char;
                partWidth += charWidth;
                splitIndex = i + 1;
              }
              additionalLines.push(part);
              wordToProcess = cpSlice(wordToProcess, splitIndex);
            }
            currentLine = wordToProcess;
          } else {
            currentLine = prospectiveLine;
          }
        }
        if (currentLine) {
          additionalLines.push(currentLine);
        }
      }
    }

    return { inlineGhost, additionalLines };
  }, [
    promptCompletion.text,
    buffer.text,
    buffer.lines,
    buffer.cursor,
    inputWidth,
  ]);

  const { inlineGhost, additionalLines } = getGhostTextLines();

  // Names a mid-prompt `/token` may resolve to, so the highlighter can accent
  // a real command without accenting ordinary paths like `ls /usr/bin`.
  const knownCommandNames = useMemo(() => {
    const names = new Set<string>();
    for (const cmd of slashCommands) {
      if (cmd.hidden) continue;
      names.add(cmd.name);
      if (cmd.displayName) names.add(cmd.displayName);
      for (const alt of cmd.altNames ?? []) names.add(alt);
    }
    return names;
  }, [slashCommands]);

  const terminalBg = theme.background.primary || 'black';

  // The canonical input frame is transparent, so cursor highlighting always
  // uses the terminal surface and restores the terminal default background.
  const cursorSurfaceColor = useMemo(
    () => resolveColor(terminalBg) || terminalBg,
    [terminalBg],
  );

  // Helper: highlight a character for cursor display by explicitly setting
  // fg=boxBg and bg=textColor, avoiding SGR 7 inverse ambiguity.
  // Uses raw SGR codes so the tokenizer correctly assigns per-cell styles and
  // restores either the painted input surface or the terminal default.
  const highlightCursor = useCallback(
    (char: string, textColor: string): string => {
      if (
        !cursorSurfaceColor ||
        !cursorSurfaceColor.startsWith('#') ||
        !textColor.startsWith('#')
      ) {
        // Fallback: colors are not hex (e.g. ansi theme uses Ink names like
        // 'black', 'magenta'), so raw SGR truecolor codes won't work.
        // Use simple inverse which works everywhere, even if imperfect.
        return chalk.inverse(char);
      }
      // Build raw SGR sequences so the tokenizer sees a clean transition:
      //   normal -> cursor colors -> input surface/default background.
      const cursorFg = hexToSgrFg(cursorSurfaceColor);
      const cursorBg = hexToSgrBg(textColor);
      const restoreFg = hexToSgrFg(textColor);
      const restoreBg = '\x1b[49m';
      return `${cursorBg}${cursorFg}${char}${restoreBg}${restoreFg}`;
    },
    [cursorSurfaceColor],
  );

  // Build viewport lines synchronously — like cc's Cursor.render() approach.
  // text-buffer already slices visual lines to the viewport (viewportVisualLines)
  // and tracks scroll position (visualScrollRow). No VirtualizedList needed.
  const renderVisualLine = useCallback(
    (lineText: string, absoluteVisualIdx: number): React.ReactNode => {
      const mapEntry = buffer.visualToLogicalMap[absoluteVisualIdx];
      if (!mapEntry) return <Text key={`vl-${absoluteVisualIdx}`}> </Text>;

      const isOnCursorLine =
        focus && absoluteVisualIdx === cursorVisualRowAbsolute;
      const renderedLine: React.ReactNode[] = [];
      const [logicalLineIdx] = mapEntry;
      const logicalLine = buffer.lines[logicalLineIdx] || '';
      const transformations =
        buffer.transformationsByLine[logicalLineIdx] ?? [];
      const tokens = parseInputForHighlighting(
        logicalLine,
        logicalLineIdx,
        transformations,
        focus && buffer.cursor[0] === logicalLineIdx
          ? buffer.cursor[1]
          : undefined,
        knownCommandNames,
      );
      const visualStartCol =
        buffer.visualToTransformedMap[absoluteVisualIdx] ?? 0;
      const visualEndCol = visualStartCol + cpLen(lineText);
      const segments = parseSegmentsFromTokens(
        tokens,
        visualStartCol,
        visualEndCol,
      );
      // Misspellings decorate prose only, so they are cut out of the plain
      // runs and never touch a command, an @ reference, or a placeholder.
      const spellSpans = spellcheckSpansByLine.get(logicalLineIdx) ?? [];
      let charCount = 0;
      segments.forEach((seg, segIdx) => {
        const color =
          seg.type === 'command' || seg.type === 'file' || seg.type === 'paste'
            ? theme.text.accent
            : theme.text.primary;
        const runs =
          seg.type === 'default' && spellSpans.length > 0
            ? splitTextBySpellcheckSpans(
                seg.text,
                visualStartCol + charCount,
                buffer.transformedToLogicalMaps[logicalLineIdx],
                spellSpans,
              )
            : [{ text: seg.text, misspelled: false }];

        runs.forEach((run, runIdx) => {
          const keywordRuns = splitRunByKeywordRanges(
            run.text,
            visualStartCol + charCount,
            buffer.transformedToLogicalMaps[logicalLineIdx],
            workflowKeywordRangesByLine.get(logicalLineIdx) ?? [],
          );
          keywordRuns.forEach((keywordRun, keywordRunIdx) => {
            const runLen = cpLen(keywordRun.text);
            let display = keywordRun.text;
            const runColor = keywordRun.keyword
              ? suppressWorkflowKeyword
                ? theme.text.secondary
                : theme.text.accent
              : run.misspelled
                ? spellcheckColor
                : color;
            if (isOnCursorLine) {
              const relCol = cursorVisualColAbsolute;
              const runStart = charCount;
              const runEnd = runStart + runLen;
              // The word under the cursor is never marked, so the cursor cell
              // and an underlined run cannot land on each other.
              if (relCol >= runStart && relCol < runEnd) {
                const charToHighlight = cpSlice(
                  display,
                  relCol - runStart,
                  relCol - runStart + 1,
                );
                const highlighted = showCursor
                  ? highlightCursor(charToHighlight, runColor ?? color)
                  : charToHighlight;
                display =
                  cpSlice(display, 0, relCol - runStart) +
                  highlighted +
                  cpSlice(display, relCol - runStart + 1);
              }
              charCount = runEnd;
            } else {
              charCount += runLen;
            }
            renderedLine.push(
              <Text
                key={`token-${segIdx}-${runIdx}-${keywordRunIdx}`}
                color={runColor}
                underline={run.misspelled || undefined}
              >
                {display}
              </Text>,
            );
          });
        });
      });

      const currentLineGhost = isOnCursorLine ? inlineGhost : '';
      const argHint =
        isOnCursorLine &&
        cursorVisualColAbsolute === cpLen(lineText) &&
        !currentLineGhost &&
        completion.commandArgumentHint
          ? // A hint authored as `argument-hint: " <file>"` keeps its leading
            // space (the frontmatter parser trims before unquoting), which
            // would leave a stray gap column after the cursor cell. A hint
            // that is only whitespace normalizes to '' and still gets the
            // plain end-of-line cursor below.
            completion.commandArgumentHint.trimStart()
          : '';
      if (
        isOnCursorLine &&
        cursorVisualColAbsolute === cpLen(lineText) &&
        !currentLineGhost
      ) {
        renderedLine.push(
          <Text key={`cursor-end-${cursorVisualColAbsolute}`}>
            {showCursor ? highlightCursor(' ', theme.text.primary) : ' '}
          </Text>,
        );
      }
      // The cursor sits *on* the ghost's first character rather than in a
      // blank cell before it — a leading blank would push the whole suggestion
      // one column to the right of where the text will actually land.
      const cursorOnGhost = Boolean(
        focus &&
          isOnCursorLine &&
          showCursor &&
          cursorVisualColAbsolute === cpLen(lineText) &&
          currentLineGhost,
      );
      const ghostHead = cursorOnGhost ? cpSlice(currentLineGhost, 0, 1) : '';
      const ghostTail = cursorOnGhost
        ? cpSlice(currentLineGhost, 1)
        : currentLineGhost;
      return (
        <Box height={1} key={`vl-${absoluteVisualIdx}`}>
          <Text
            terminalCursorFocus={showCursor && isOnCursorLine}
            terminalCursorPosition={cpIndexToOffset(
              lineText,
              cursorVisualColAbsolute,
            )}
          >
            {renderedLine}
            {cursorOnGhost && highlightCursor(ghostHead, theme.text.primary)}
            {ghostTail && <Text color={theme.text.secondary}>{ghostTail}</Text>}
            {argHint && <Text color={theme.text.secondary}>{argHint}</Text>}
          </Text>
        </Box>
      );
    },
    [
      buffer.visualToLogicalMap,
      buffer.lines,
      buffer.transformationsByLine,
      buffer.cursor,
      buffer.visualToTransformedMap,
      buffer.transformedToLogicalMaps,
      focus,
      cursorVisualRowAbsolute,
      cursorVisualColAbsolute,
      showCursor,
      inlineGhost,
      completion.commandArgumentHint,
      highlightCursor,
      knownCommandNames,
      spellcheckSpansByLine,
      spellcheckColor,
      workflowKeywordRangesByLine,
      suppressWorkflowKeyword,
    ],
  );

  // Cursor visibility is now handled synchronously by text-buffer's scrollRowState
  // (see text-buffer.ts lines 2958-2970). No async scroll sync needed.

  useEffect(() => {
    if (onSuggestionsVisibilityChange) {
      onSuggestionsVisibilityChange(shouldShowSuggestions);
    }
  }, [shouldShowSuggestions, onSuggestionsVisibilityChange]);

  const showYoloStyling = !shellModeActive && permissionMode === 'yolo';

  const modeColor = useMemo(() => {
    const color = permissionModeColor(permissionMode);
    return color.startsWith('#') ? color : resolveThemeColor(color);
  }, [permissionMode]);

  let statusColor: string | undefined;
  let statusText = '';
  if (shellModeActive) {
    statusColor = theme.ui.symbol;
    statusText = i18n.get('status.shellModeAria');
  } else if (permissionMode !== 'default') {
    statusColor = modeColor;
    statusText = getLocalizedPermissionModeTitle(permissionMode, i18n.get);
  }

  const suggestionsMode =
    completion.completionMode === CompletionMode.AT ||
    completion.completionMode === CompletionMode.SHELL
      ? 'reverse'
      : isSlashInput(buffer.text) &&
          !buffer.text.includes(' ') &&
          !reverseSearchActive &&
          !commandSearchActive
        ? 'slash'
        : 'reverse';
  const renderSuggestionsInFooter =
    suggestionsPosition === 'footer' && shouldShowSuggestions;
  const showSuggestionsSeparator = !renderSuggestionsInFooter;
  // Ratcheting this height prevents suggestion filtering from shrinking the prompt
  // without adding extra blank footer rows.
  const currentSuggestionsHeight =
    shouldShowSuggestions && activeCompletion.suggestions.length > 0
      ? Math.min(activeCompletion.suggestions.length, MAX_SUGGESTIONS_TO_SHOW) +
        (showSuggestionsSeparator ? 1 : 0)
      : 0;
  const reservedSuggestionsHeight = renderSuggestionsInFooter
    ? Math.max(footerSuggestionsReservedHeight, currentSuggestionsHeight)
    : undefined;

  useEffect(() => {
    if (!renderSuggestionsInFooter) {
      setFooterSuggestionsReservedHeight(0);
      return;
    }
    setFooterSuggestionsReservedHeight((prev) =>
      Math.max(prev, currentSuggestionsHeight),
    );
  }, [currentSuggestionsHeight, renderSuggestionsInFooter]);

  const suggestionsDisplayProps =
    useMemo<SuggestionsDisplayProps | null>(() => {
      if (!shouldShowSuggestions) {
        return null;
      }

      return {
        suggestions: activeCompletion.suggestions,
        activeIndex: activeCompletion.activeSuggestionIndex,
        isLoading: activeCompletion.isLoadingSuggestions,
        width: suggestionsWidth,
        reservedHeight: reservedSuggestionsHeight,
        scrollOffset: activeCompletion.visibleStartIndex,
        userInput: buffer.text,
        mode: suggestionsMode,
        expandedIndex: expandedSuggestionIndex,
        showSeparator: showSuggestionsSeparator,
      };
    }, [
      activeCompletion.activeSuggestionIndex,
      activeCompletion.isLoadingSuggestions,
      activeCompletion.suggestions,
      activeCompletion.visibleStartIndex,
      buffer.text,
      expandedSuggestionIndex,
      reservedSuggestionsHeight,
      shouldShowSuggestions,
      showSuggestionsSeparator,
      suggestionsMode,
      suggestionsWidth,
    ]);

  useLayoutEffect(() => {
    if (!onFooterSuggestionsChange) {
      return;
    }

    onFooterSuggestionsChange(
      renderSuggestionsInFooter ? suggestionsDisplayProps : null,
    );
  }, [
    onFooterSuggestionsChange,
    renderSuggestionsInFooter,
    suggestionsDisplayProps,
  ]);

  useEffect(
    () => () => {
      onFooterSuggestionsChange?.(null);
    },
    [onFooterSuggestionsChange],
  );

  const inlineSuggestionsNode =
    suggestionsDisplayProps && !renderSuggestionsInFooter ? (
      <Box>
        <SuggestionsDisplay {...suggestionsDisplayProps} />
      </Box>
    ) : null;
  const inlineSuggestionsPosition =
    suggestionsPosition === 'footer' ? 'below' : suggestionsPosition;

  // Shared prompt prefix element
  const promptPrefix = (
    <>
      {shellModeActive ? (
        reverseSearchActive ? (
          <Text color={theme.text.link} aria-label={SCREEN_READER_USER_PREFIX}>
            (r:){' '}
          </Text>
        ) : (
          '!'
        )
      ) : commandSearchActive ? (
        <Text color={theme.text.accent}>(r:) </Text>
      ) : showYoloStyling ? (
        '*'
      ) : (
        '>'
      )}{' '}
    </>
  );

  // The next action is a preview until Tab accepts it. Keep it out of the
  // text buffer so Enter cannot submit it and typing starts the user's draft.
  // Ink wraps the preview, including CJK text, within the input frame.
  const emptyInputHint = nextActionSuggestions.isVisible
    ? nextActionSuggestions.suggestions[0]?.text || placeholder
    : placeholder;

  // Shared input content element
  const defaultInputContent =
    buffer.text.length === 0 && emptyInputHint ? (
      <Box ref={inputCursorRef} width="100%">
        {showCursor ? (
          <Text
            wrap="wrap"
            terminalCursorFocus={showCursor}
            terminalCursorPosition={0}
          >
            {highlightCursor(
              cpSlice(emptyInputHint, 0, 1),
              theme.text.secondary,
            )}
            <Text color={theme.text.secondary}>{cpSlice(emptyInputHint, 1)}</Text>
          </Text>
        ) : (
          <Text color={theme.text.secondary}>{emptyInputHint}</Text>
        )}
      </Box>
    ) : (
      <Box
        ref={inputCursorRef}
        flexDirection="column"
        height={Math.min(buffer.viewportHeight, buffer.allVisualLines.length)}
        width="100%"
      >
        {buffer.viewportVisualLines.map((lineText, viewportIdx) => {
          const absoluteVisualIdx = buffer.visualScrollRow + viewportIdx;
          return renderVisualLine(lineText, absoluteVisualIdx);
        })}
        {additionalLines.map((ghostLine, index) => {
          const padding = Math.max(0, inputWidth - stringWidth(ghostLine));
          return (
            <Box height={1} key={`ghost-${index}`}>
              <Text color={theme.text.secondary}>
                {ghostLine}
                {' '.repeat(padding)}
              </Text>
            </Box>
          );
        })}
      </Box>
    );

  // While an external editor owns the prompt, replace the input with a hint.
  // Terminal editors clear the screen, so this is really for GUI editors, where
  // the terminal keeps rendering normally while the user edits elsewhere and
  // KeypressContext's input lock makes the prompt deaf to everything but the
  // two escape hatches named here.
  const inputContent = isExternalEditorActive ? (
    <Box ref={inputCursorRef}>
      <Text color={theme.text.secondary}>
        Save and close editor to continue · ctrl+x reopen · ctrl+c ×2 quit
      </Text>
    </Box>
  ) : (
    defaultInputContent
  );

  return (
    <>
      {inlineSuggestionsPosition === 'above' && inlineSuggestionsNode}
      <InputFrame active width={terminalWidth} title={sessionName}>
        <Text
          color={statusColor ?? theme.text.accent}
          aria-label={statusText || undefined}
        >
          {promptPrefix}
        </Text>
        <Box flexGrow={1} flexDirection="column" ref={innerBoxRef}>
          {inputContent}
        </Box>
      </InputFrame>
      {inlineSuggestionsPosition === 'below' && inlineSuggestionsNode}
    </>
  );
};
