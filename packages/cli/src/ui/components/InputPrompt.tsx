/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Box, Text } from 'ink';
import { SuggestionsDisplay, MAX_WIDTH } from './SuggestionsDisplay.js';
import type { RecentSlashCommands } from '../hooks/useSlashCompletion.js';
import { theme } from '../semantic-colors.js';
import { useInputHistory } from '../hooks/useInputHistory.js';
import type { TextBuffer } from './shared/text-buffer.js';
import { logicalPosToOffset } from './shared/text-buffer.js';
import { cpSlice, cpLen } from '../utils/textUtils.js';
import chalk from 'chalk';
import { useShellHistory } from '../hooks/useShellHistory.js';
import { useReverseSearchCompletion } from '../hooks/useReverseSearchCompletion.js';
import { useCommandCompletion } from '../hooks/useCommandCompletion.js';
import { useExportCompletion } from '../hooks/useExportCompletion.js';
import { useFollowupSuggestionsCLI } from '../hooks/useFollowupSuggestions.js';
import type { Key } from '../hooks/useKeypress.js';
import { keyMatchers, Command } from '../keyMatchers.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import {
  ApprovalMode,
  type Config,
  Storage,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import {
  parseInputForHighlighting,
  buildSegmentsForVisualSlice,
} from '../utils/highlight.js';
import { t } from '../../i18n/index.js';
import {
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages,
} from '../utils/clipboardUtils.js';
import * as path from 'node:path';
import { SCREEN_READER_USER_PREFIX } from '../textConstants.js';
import { useShellFocusState } from '../contexts/ShellFocusContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useKeypressContext } from '../contexts/KeypressContext.js';
import {
  useAgentViewState,
  useAgentViewActions,
} from '../contexts/AgentViewContext.js';
import {
  useBackgroundTaskViewState,
  useBackgroundTaskViewActions,
} from '../contexts/BackgroundTaskViewContext.js';
import { isLiveAgentPanelVisibleEntry } from './background-view/liveAgentPanelVisibility.js';
import { FEEDBACK_DIALOG_KEYS } from '../FeedbackDialog.js';
import { BaseTextInput } from './BaseTextInput.js';
import type { RenderLineOptions } from './BaseTextInput.js';
import { getApprovalModePromptStyle } from './approvalModeVisuals.js';

/**
 * Represents an attachment (e.g., pasted image) displayed above the input prompt
 */
export interface Attachment {
  id: string; // Unique identifier (timestamp)
  path: string; // Full file path
  filename: string; // Filename only (for display)
}

const debugLogger = createDebugLogger('INPUT_PROMPT');

export interface InputPromptProps {
  buffer: TextBuffer;
  onSubmit: (value: string) => void;
  userMessages: readonly string[];
  onClearScreen: () => void;
  config: Config;
  slashCommands: readonly SlashCommand[];
  commandContext: CommandContext;
  recentSlashCommands?: RecentSlashCommands;
  placeholder?: string;
  focus?: boolean;
  inputWidth: number;
  suggestionsWidth: number;
  shellModeActive: boolean;
  setShellModeActive: (value: boolean) => void;
  approvalMode: ApprovalMode;
  onEscapePromptChange?: (showPrompt: boolean) => void;
  onToggleShortcuts?: () => void;
  showShortcuts?: boolean;
  /**
   * Reports autocomplete-dropdown visibility specifically. Composer uses
   * this to hide the Footer / KeyboardShortcuts when the dropdown would
   * overlap their vertical space. Must stay narrow — followup suggestions
   * and mid-input ghost text don't take Footer's space and shouldn't hide
   * it. See #4171 / #4308 review.
   */
  onSuggestionsVisibilityChange?: (visible: boolean) => void;
  /**
   * Reports whether any input-area handler will consume a Tab keystroke
   * (autocomplete dropdown, followup prompt suggestion, or mid-input ghost
   * text). AppContainer feeds this into useAutoAcceptIndicator's
   * `shouldBlockTab` to suppress the Windows-only "bare Tab cycles approval
   * mode" fallback. See #4171.
   */
  onTabConsumerChange?: (active: boolean) => void;
  vimHandleInput?: (key: Key) => boolean;
  isEmbeddedShellFocused?: boolean;
  /** Prompt suggestion text to display after response completes */
  promptSuggestion?: string | null;
  /** Called when prompt suggestion is dismissed (user typed) */
  onPromptSuggestionDismiss?: () => void;
}

// Re-export from shared utils for backwards compatibility
export { calculatePromptWidths } from '../utils/layoutUtils.js';

// Large paste placeholder thresholds
const LARGE_PASTE_CHAR_THRESHOLD = 1000;
const LARGE_PASTE_LINE_THRESHOLD = 10;

export const InputPrompt: React.FC<InputPromptProps> = ({
  buffer,
  onSubmit,
  userMessages,
  onClearScreen,
  config,
  slashCommands,
  commandContext,
  recentSlashCommands,
  placeholder,
  focus = true,
  suggestionsWidth,
  shellModeActive,
  setShellModeActive,
  approvalMode,
  onEscapePromptChange,
  onToggleShortcuts,
  showShortcuts,
  onSuggestionsVisibilityChange,
  onTabConsumerChange,
  vimHandleInput,
  isEmbeddedShellFocused,
  promptSuggestion,
  onPromptSuggestionDismiss,
}) => {
  const isShellFocused = useShellFocusState();
  const uiState = useUIState();
  const uiActions = useUIActions();
  const { pasteWorkaround } = useKeypressContext();
  const { agents, agentTabBarFocused } = useAgentViewState();
  const { setAgentTabBarFocused } = useAgentViewActions();
  const {
    entries: bgEntries,
    dialogOpen: bgDialogOpen,
    pillFocused: bgPillFocused,
    livePanelFocused,
    livePanelSelectedIndex,
  } = useBackgroundTaskViewState();
  const {
    setLivePanelFocused,
    setLivePanelSelectedIndex,
    enterDetailFromPanel: enterBgDetailFromPanel,
    setSelectedIndex: setBgSelectedIndex,
  } = useBackgroundTaskViewActions();
  const hasAgents = agents.size > 0;
  const getVisibleBgAgents = useCallback(
    () => bgEntries.filter((e) => isLiveAgentPanelVisibleEntry(e, Date.now())),
    [bgEntries],
  );
  const hasActiveToolConfirmation = useMemo(
    () =>
      Boolean(uiState.confirmationRequest) ||
      (uiState.pendingGeminiHistoryItems ?? []).some(
        (item) =>
          item.type === 'tool_group' &&
          item.tools.some((tool) => tool.confirmationDetails),
      ),
    [uiState.confirmationRequest, uiState.pendingGeminiHistoryItems],
  );
  const [historyRestoredText, setHistoryRestoredText] = useState<string | null>(
    null,
  );
  const [escPressCount, setEscPressCount] = useState(0);
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const escapeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [recentPasteTime, setRecentPasteTime] = useState<number | null>(null);
  const pasteTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Attachment state for clipboard images
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isAttachmentMode, setIsAttachmentMode] = useState(false);
  const [selectedAttachmentIndex, setSelectedAttachmentIndex] = useState(-1);
  // Large paste placeholder handling
  const [pendingPastes, setPendingPastes] = useState<Map<string, string>>(
    new Map(),
  );
  // Track active placeholder IDs for each charCount to enable reuse
  const activePlaceholderIds = useRef<Map<number, Set<number>>>(new Map());

  // Parse placeholder to extract charCount and ID
  const parsePlaceholder = useCallback(
    (placeholder: string): { charCount: number; id: number } | null => {
      const match = placeholder.match(
        /^\[Pasted Content (\d+) chars\](?: #(\d+))?$/,
      );
      if (!match) return null;
      const charCount = parseInt(match[1], 10);
      const id = match[2] ? parseInt(match[2], 10) : 1;
      return { charCount, id };
    },
    [],
  );

  // Free a placeholder ID when deleted so it can be reused
  const freePlaceholderId = useCallback((charCount: number, id: number) => {
    const activeIds = activePlaceholderIds.current.get(charCount);
    if (activeIds) {
      activeIds.delete(id);
      if (activeIds.size === 0) {
        activePlaceholderIds.current.delete(charCount);
      }
    }
  }, []);

  const [reverseSearchActive, setReverseSearchActive] = useState(false);
  const [commandSearchActive, setCommandSearchActive] = useState(false);
  const [textBeforeReverseSearch, setTextBeforeReverseSearch] = useState('');
  const [cursorPosition, setCursorPosition] = useState<[number, number]>([
    0, 0,
  ]);
  const [expandedSuggestionIndex, setExpandedSuggestionIndex] =
    useState<number>(-1);
  const exportCompletion = useExportCompletion(buffer, slashCommands);
  const shellHistory = useShellHistory(config.getProjectRoot());
  const shellHistoryData = shellHistory.history;
  const isHistoryRestoredText =
    historyRestoredText !== null && buffer.text === historyRestoredText;

  const completion = useCommandCompletion(
    buffer,
    config.getTargetDir(),
    slashCommands,
    commandContext,
    reverseSearchActive,
    config,
    // Suppress completion for history-restored text until the user edits it.
    !isHistoryRestoredText,
    recentSlashCommands,
  );
  const showCompletionSuggestions =
    completion.showSuggestions && !isHistoryRestoredText;

  // Ref so renderLineWithHighlighting (stable useCallback) can access fresh ghost text
  const midInputGhostTextRef = useRef<{
    text: string;
    insertPosition: number;
    acceptText?: string;
    showCursorBeforeText?: boolean;
  } | null>(null);
  midInputGhostTextRef.current = completion.midInputGhostText;

  const reverseSearchCompletion = useReverseSearchCompletion(
    buffer,
    shellHistoryData,
    reverseSearchActive,
  );

  const commandSearchHistory = useMemo(
    () => [...userMessages].reverse(),
    [userMessages],
  );

  const commandSearchCompletion = useReverseSearchCompletion(
    buffer,
    commandSearchHistory,
    commandSearchActive,
  );

  // Prompt suggestion hook
  const followup = useFollowupSuggestionsCLI({
    onAccept: (suggestion) => {
      buffer.insert(suggestion);
    },
    config,
    isFocused: isShellFocused,
  });

  const resetCompletionState = completion.resetCompletionState;
  const resetReverseSearchCompletionState =
    reverseSearchCompletion.resetCompletionState;
  const resetCommandSearchCompletionState =
    commandSearchCompletion.resetCompletionState;

  const showCursor =
    focus && isShellFocused && !isEmbeddedShellFocused && !agentTabBarFocused;

  const resetEscapeState = useCallback(() => {
    if (escapeTimerRef.current) {
      clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = null;
    }
    setEscPressCount(0);
    setShowEscapePrompt(false);
  }, []);

  // Notify parent component about escape prompt state changes
  useEffect(() => {
    if (onEscapePromptChange) {
      onEscapePromptChange(showEscapePrompt);
    }
  }, [showEscapePrompt, onEscapePromptChange]);

  // Helper to generate unique placeholder for large pastes
  // Reuses IDs that have been freed up from deleted placeholders
  const nextLargePastePlaceholder = useCallback((charCount: number): string => {
    const activeIds = activePlaceholderIds.current.get(charCount) || new Set();

    // Find smallest available ID (starting from 1)
    let id = 1;
    while (activeIds.has(id)) {
      id++;
    }

    // Mark as active
    activeIds.add(id);
    activePlaceholderIds.current.set(charCount, activeIds);

    const base = `[Pasted Content ${charCount} chars]`;
    return id === 1 ? base : `${base} #${id}`;
  }, []);

  // Clear escape prompt timer on unmount
  useEffect(
    () => () => {
      if (escapeTimerRef.current) {
        clearTimeout(escapeTimerRef.current);
      }
      if (pasteTimeoutRef.current) {
        clearTimeout(pasteTimeoutRef.current);
      }
    },
    [],
  );

  // Ref to inputHistory.resetHistoryNav, populated after useInputHistory runs.
  // Needed because handleSubmitAndClear is passed into useInputHistory as
  // onSubmit, so we can't reference inputHistory directly here without a cycle.
  const resetHistoryNavRef = useRef<() => void>(() => {});

  const handleSubmitAndClear = useCallback(
    (submittedValue: string) => {
      exportCompletion.reset();
      // Expand any large paste placeholders to their full content before submitting
      let finalValue = submittedValue;
      if (pendingPastes.size > 0) {
        const placeholders = Array.from(pendingPastes.keys()).sort(
          (a, b) => b.length - a.length,
        );
        const escapedPlaceholders = placeholders.map((placeholderValue) =>
          placeholderValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        );
        const placeholderRegex = new RegExp(escapedPlaceholders.join('|'), 'g');
        finalValue = finalValue.replace(
          placeholderRegex,
          (matchedPlaceholder) =>
            pendingPastes.get(matchedPlaceholder) ?? matchedPlaceholder,
        );
        setPendingPastes(new Map());
        activePlaceholderIds.current.clear();
      }
      if (shellModeActive) {
        shellHistory.addCommandToHistory(finalValue);
      }

      // Convert attachments to @references and prepend to the message
      if (attachments.length > 0) {
        const attachmentRefs = attachments
          .map((att) => `@${path.relative(config.getTargetDir(), att.path)}`)
          .join(' ');
        finalValue = `${attachmentRefs}\n\n${finalValue.trim()}`;
      }

      // Clear the buffer *before* calling onSubmit to prevent potential re-submission
      // if onSubmit triggers a re-render while the buffer still holds the old value.
      buffer.setText('');
      onSubmit(finalValue);

      // Reset history navigation so the next Up-arrow starts from the newest
      // entry rather than advancing from whatever index the user picked.
      resetHistoryNavRef.current();

      // Dismiss follow-up suggestion after submit
      followup.dismiss();

      // Clear attachments after submit
      setAttachments([]);
      setIsAttachmentMode(false);
      setSelectedAttachmentIndex(-1);

      resetCompletionState();
      resetReverseSearchCompletionState();
    },
    [
      exportCompletion,
      onSubmit,
      buffer,
      resetCompletionState,
      shellModeActive,
      shellHistory,
      resetReverseSearchCompletionState,
      attachments,
      config,
      pendingPastes,
      followup,
    ],
  );

  const customSetTextAndResetCompletionSignal = useCallback(
    (newText: string) => {
      buffer.setText(newText);
      setHistoryRestoredText(newText);
    },
    [buffer],
  );

  const inputHistory = useInputHistory({
    userMessages,
    onSubmit: handleSubmitAndClear,
    // History navigation (Ctrl+P/N) now always works since completion navigation
    // only uses arrow keys. Only disable in shell mode.
    isActive: !shellModeActive,
    currentQuery: buffer.text,
    onChange: customSetTextAndResetCompletionSignal,
  });

  resetHistoryNavRef.current = inputHistory.resetHistoryNav;

  // When an arena session starts (agents appear), reset history position so
  // that pressing down-arrow immediately focuses the agent tab bar instead
  // of cycling through input history.
  const prevHasAgentsRef = useRef(hasAgents);
  useEffect(() => {
    if (hasAgents && !prevHasAgentsRef.current) {
      inputHistory.resetHistoryNav();
    }
    prevHasAgentsRef.current = hasAgents;
  }, [hasAgents, inputHistory]);

  // History-restored input should not immediately open completion menus and
  // steal Up/Down from continued history navigation. Editing the text clears
  // this marker and lets completions appear again.
  useEffect(() => {
    if (historyRestoredText === null) {
      return;
    }

    if (buffer.text === historyRestoredText) {
      resetCompletionState();
      resetReverseSearchCompletionState();
      resetCommandSearchCompletionState();
      setExpandedSuggestionIndex(-1);
      return;
    }

    setHistoryRestoredText(null);
  }, [
    historyRestoredText,
    buffer.text,
    resetCompletionState,
    resetReverseSearchCompletionState,
    resetCommandSearchCompletionState,
  ]);

  // Handle clipboard image pasting with Ctrl+V
  const handleClipboardImage = useCallback(async (validated = false) => {
    try {
      const hasImage = validated || (await clipboardHasImage());
      if (hasImage) {
        const imagePath = await saveClipboardImage(Storage.getGlobalTempDir());
        if (imagePath) {
          // Clean up old images
          cleanupOldClipboardImages(Storage.getGlobalTempDir()).catch(() => {
            // Ignore cleanup errors
          });

          // Add as attachment instead of inserting @reference into text
          const filename = path.basename(imagePath);
          const newAttachment: Attachment = {
            id: String(Date.now()),
            path: imagePath,
            filename,
          };
          setAttachments((prev) => [...prev, newAttachment]);
        }
      }
    } catch (error) {
      debugLogger.error('Error handling clipboard image:', error);
    }
  }, []);

  // Handle deletion of an attachment from the list
  const handleAttachmentDelete = useCallback((index: number) => {
    setAttachments((prev) => {
      const newList = prev.filter((_, i) => i !== index);
      if (newList.length === 0) {
        setIsAttachmentMode(false);
        setSelectedAttachmentIndex(-1);
      } else {
        setSelectedAttachmentIndex(Math.min(index, newList.length - 1));
      }
      return newList;
    });
  }, []);

  // Down from an empty composer (bottom edge, history exhausted), in visual
  // top→bottom order: live agent panel (if bg sub-agents) → tab bar (if
  // Arena) → stay put. Always consumes the key.
  const descendFromComposer = useCallback((): boolean => {
    if (getVisibleBgAgents().length > 0) {
      setLivePanelFocused(true);
    } else if (hasAgents) {
      setAgentTabBarFocused(true);
    }
    return true;
  }, [
    getVisibleBgAgents,
    hasAgents,
    setLivePanelFocused,
    setAgentTabBarFocused,
  ]);

  const handleInput = useCallback(
    (key: Key): boolean => {
      // When the Arena tab bar or background pill has focus, block
      // non-printable keys so arrow keys and shortcuts don't interfere.
      // Printable characters fall through to BaseTextInput's default
      // handler so the first keystroke appears in the input immediately
      // (each surface's own handler releases focus on the same event).
      // LiveAgentPanel keyboard navigation: ↓/↑ move selection,
      // Enter opens dialog for selected agent, Esc/↑-at-top returns
      // focus to composer. Printable chars type through (auto-unfocus).
      if (livePanelFocused) {
        const visibleBgAgents = getVisibleBgAgents();
        if (visibleBgAgents.length === 0) {
          setLivePanelFocused(false);
          if (
            key.sequence &&
            key.sequence.length === 1 &&
            !key.ctrl &&
            !key.meta
          ) {
            return false;
          }
          return descendFromComposer();
        }
        if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
          const maxIdx = visibleBgAgents.length; // 0=main, 1..N=agents
          if (livePanelSelectedIndex < maxIdx) {
            setLivePanelSelectedIndex(livePanelSelectedIndex + 1);
          } else if (hasAgents) {
            // Bottom of the panel → descend to the tab bar below it
            // (only rendered when Arena agents exist).
            setLivePanelFocused(false);
            setAgentTabBarFocused(true);
          } else {
            // No tab bar below → release focus back to the composer instead
            // of silently consuming the key.
            setLivePanelFocused(false);
          }
          return true;
        }
        if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
          if (livePanelSelectedIndex <= 0) {
            setLivePanelFocused(false);
          } else {
            setLivePanelSelectedIndex(livePanelSelectedIndex - 1);
          }
          return true;
        }
        if (key.name === 'return') {
          if (livePanelSelectedIndex === 0) {
            setLivePanelFocused(false);
          } else {
            const agentIdx = livePanelSelectedIndex - 1;
            const entry = visibleBgAgents[agentIdx];
            const entryIdx = entry
              ? bgEntries.findIndex(
                  (e) => e.kind === 'agent' && e.agentId === entry.agentId,
                )
              : -1;
            if (entryIdx >= 0) {
              setBgSelectedIndex(entryIdx);
              enterBgDetailFromPanel();
            }
            setLivePanelFocused(false);
          }
          return true;
        }
        if (key.name === 'escape') {
          setLivePanelFocused(false);
          return true;
        }
        if (
          key.sequence &&
          key.sequence.length === 1 &&
          !key.ctrl &&
          !key.meta
        ) {
          setLivePanelFocused(false);
          return false;
        }
        return true;
      }

      if (agentTabBarFocused || bgPillFocused) {
        if (
          key.sequence &&
          key.sequence.length === 1 &&
          !key.ctrl &&
          !key.meta
        ) {
          return false; // let BaseTextInput type the character
        }
        return true; // consume non-printable keys
      }

      // When the Background tasks dialog is open, swallow every key so
      // nothing reaches the composer buffer — the dialog's own keypress
      // handler owns selection, open/close, and stop actions. Unlike
      // the tab bar we do NOT let printable chars type through, because
      // the dialog doesn't auto-close on printable input and users
      // would leak text into the hidden composer.
      if (bgDialogOpen) {
        return true;
      }

      // TODO(jacobr): this special case is likely not needed anymore.
      // We should probably stop supporting paste if the InputPrompt is not
      // focused.
      /// We want to handle paste even when not focused to support drag and drop.
      if (!focus && !key.paste) {
        return true;
      }

      if (key.paste) {
        // Dismiss follow-up suggestion when user starts typing/pasting
        if (buffer.text.length === 0 && followup.state.isVisible) {
          followup.dismiss();
          onPromptSuggestionDismiss?.();
        }

        // Record paste time to prevent accidental auto-submission
        setRecentPasteTime(Date.now());

        // Clear any existing paste timeout
        if (pasteTimeoutRef.current) {
          clearTimeout(pasteTimeoutRef.current);
        }

        // Clear the paste protection after a safe delay
        pasteTimeoutRef.current = setTimeout(() => {
          setRecentPasteTime(null);
          pasteTimeoutRef.current = null;
        }, 500);

        // Handle large pastes by showing a placeholder
        const pasted = key.sequence.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const charCount = [...pasted].length; // Proper Unicode char count
        const lineCount = pasted.split('\n').length;

        // Ensure we never accidentally interpret paste as regular input.
        if (key.pasteImage) {
          handleClipboardImage(true);
        } else if (
          charCount > LARGE_PASTE_CHAR_THRESHOLD ||
          lineCount > LARGE_PASTE_LINE_THRESHOLD
        ) {
          const placeholder = nextLargePastePlaceholder(charCount);
          setPendingPastes((prev) => {
            const next = new Map(prev);
            next.set(placeholder, pasted);
            return next;
          });
          // Insert the placeholder as regular text
          buffer.insert(placeholder, { paste: false });
        } else {
          // Normal paste handling for small content
          buffer.handleInput(key);
        }
        return true;
      }

      if (vimHandleInput && vimHandleInput(key)) {
        return true;
      }

      // Handle feedback dialog keyboard interactions when dialog is open
      if (uiState.isFeedbackDialogOpen) {
        // If it's one of the feedback option keys (1-4), let FeedbackDialog handle it
        if ((FEEDBACK_DIALOG_KEYS as readonly string[]).includes(key.name)) {
          return true;
        } else {
          // For any other key, close feedback dialog temporarily and continue with normal processing
          uiActions.temporaryCloseFeedbackDialog();
          // Continue processing the key for normal input handling
        }
      }

      // Helper: pop all queued messages into the input buffer,
      // preserving cursor position relative to existing text.
      const popQueueIntoInput = (): boolean => {
        const popped = uiActions.popAllQueuedMessages();
        if (!popped) return false;
        const currentText = buffer.text;
        if (currentText) {
          const currentCursorOffset = logicalPosToOffset(
            buffer.lines,
            buffer.cursor[0],
            buffer.cursor[1],
          );
          buffer.setText(`${popped}\n${currentText}`);
          buffer.moveToOffset(popped.length + 1 + currentCursorOffset);
        } else {
          buffer.setText(popped);
        }
        return true;
      };

      // Reset ESC count and hide prompt on any non-ESC key
      if (key.name !== 'escape') {
        if (escPressCount > 0 || showEscapePrompt) {
          resetEscapeState();
        }
      }

      if (
        key.sequence === '!' &&
        buffer.text === '' &&
        !showCompletionSuggestions
      ) {
        // Hide shortcuts when toggling shell mode
        if (showShortcuts && onToggleShortcuts) {
          onToggleShortcuts();
        }
        setShellModeActive(!shellModeActive);
        buffer.setText(''); // Clear the '!' from input
        return true;
      }

      // Toggle keyboard shortcuts display with "?" when buffer is empty
      if (
        key.sequence === '?' &&
        buffer.text === '' &&
        !showCompletionSuggestions &&
        onToggleShortcuts
      ) {
        onToggleShortcuts();
        return true;
      }

      // Hide shortcuts on any other key press
      if (showShortcuts && onToggleShortcuts) {
        onToggleShortcuts();
      }

      if (keyMatchers[Command.ESCAPE](key)) {
        exportCompletion.reset();
        const cancelSearch = (
          setActive: (active: boolean) => void,
          resetCompletion: () => void,
        ) => {
          setActive(false);
          resetCompletion();
          buffer.setText(textBeforeReverseSearch);
          const offset = logicalPosToOffset(
            buffer.lines,
            cursorPosition[0],
            cursorPosition[1],
          );
          buffer.moveToOffset(offset);
          setExpandedSuggestionIndex(-1);
        };

        if (reverseSearchActive) {
          cancelSearch(
            setReverseSearchActive,
            reverseSearchCompletion.resetCompletionState,
          );
          return true;
        }
        if (commandSearchActive) {
          cancelSearch(
            setCommandSearchActive,
            commandSearchCompletion.resetCompletionState,
          );
          return true;
        }

        if (shellModeActive) {
          setShellModeActive(false);
          resetEscapeState();
          return true;
        }

        if (showCompletionSuggestions) {
          completion.resetCompletionState();
          setExpandedSuggestionIndex(-1);
          resetEscapeState();
          return true;
        }

        // Pop queued messages into input on ESC (before double-ESC clear)
        if (!isAttachmentMode && uiState.messageQueue.length > 0) {
          if (popQueueIntoInput()) {
            resetEscapeState();
            return true;
          }
          // returned false (queue already cleared) — fall through
        }

        // Handle double ESC for clearing input
        if (escPressCount === 0) {
          if (buffer.text === '') {
            return true;
          }
          setEscPressCount(1);
          setShowEscapePrompt(true);
          if (escapeTimerRef.current) {
            clearTimeout(escapeTimerRef.current);
          }
          escapeTimerRef.current = setTimeout(() => {
            resetEscapeState();
          }, 500);
        } else {
          // clear input and immediately reset state
          buffer.setText('');
          resetCompletionState();
          resetEscapeState();
        }
        return true;
      }

      // Ctrl+Y: Retry the last failed request.
      // This shortcut is available when:
      // - There is a failed request in the current session
      // - The stream is not currently responding or waiting for confirmation
      // If no failed request exists, a message will be shown to the user.
      if (keyMatchers[Command.RETRY_LAST](key)) {
        uiActions.handleRetryLastPrompt();
        return true;
      }

      if (shellModeActive && keyMatchers[Command.REVERSE_SEARCH](key)) {
        setReverseSearchActive(true);
        setTextBeforeReverseSearch(buffer.text);
        setCursorPosition(buffer.cursor);
        return true;
      }

      if (keyMatchers[Command.CLEAR_SCREEN](key)) {
        onClearScreen();
        return true;
      }

      if (reverseSearchActive || commandSearchActive) {
        const isCommandSearch = commandSearchActive;

        const sc = isCommandSearch
          ? commandSearchCompletion
          : reverseSearchCompletion;

        const {
          activeSuggestionIndex,
          navigateUp,
          navigateDown,
          showSuggestions,
          suggestions,
        } = sc;
        const setActive = isCommandSearch
          ? setCommandSearchActive
          : setReverseSearchActive;
        const resetState = sc.resetCompletionState;

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
            if (suggestions[activeSuggestionIndex].value.length >= MAX_WIDTH) {
              setExpandedSuggestionIndex(-1);
              return true;
            }
          }
          if (keyMatchers[Command.EXPAND_SUGGESTION](key)) {
            if (suggestions[activeSuggestionIndex].value.length >= MAX_WIDTH) {
              setExpandedSuggestionIndex(activeSuggestionIndex);
              return true;
            }
          }
          if (keyMatchers[Command.ACCEPT_SUGGESTION_REVERSE_SEARCH](key)) {
            sc.handleAutocomplete(activeSuggestionIndex);
            resetState();
            setActive(false);
            return true;
          }
        }

        if (keyMatchers[Command.SUBMIT_REVERSE_SEARCH](key)) {
          const textToSubmit =
            showSuggestions && activeSuggestionIndex > -1
              ? suggestions[activeSuggestionIndex].value
              : buffer.text;
          handleSubmitAndClear(textToSubmit);
          resetState();
          setActive(false);
          return true;
        }

        // Prevent up/down from falling through to regular history navigation
        if (
          keyMatchers[Command.NAVIGATION_UP](key) ||
          keyMatchers[Command.NAVIGATION_DOWN](key) ||
          keyMatchers[Command.HISTORY_UP](key) ||
          keyMatchers[Command.HISTORY_DOWN](key)
        ) {
          return true;
        }
      }

      // Export-specific arrow/Tab/Enter handling (Phase 1 + Phase 2).
      if (
        !isHistoryRestoredText &&
        exportCompletion.handleExportInput(key, completion)
      ) {
        return true;
      }

      const acceptActiveCompletionSuggestion = () => {
        if (completion.suggestions.length === 0) {
          return false;
        }

        const targetIndex =
          completion.activeSuggestionIndex === -1
            ? 0
            : completion.activeSuggestionIndex;
        if (targetIndex >= completion.suggestions.length) {
          return false;
        }

        completion.handleAutocomplete(targetIndex);
        exportCompletion.navigatedRef.current = false;
        setExpandedSuggestionIndex(-1);
        return true;
      };

      // If the command is a perfect match, pressing enter should execute it.
      if (completion.isPerfectMatch && keyMatchers[Command.RETURN](key)) {
        if (
          showCompletionSuggestions &&
          exportCompletion.navigatedRef.current &&
          exportCompletion.navigatedTextRef.current === buffer.text &&
          acceptActiveCompletionSuggestion()
        ) {
          return true;
        }

        handleSubmitAndClear(buffer.text);
        return true;
      }

      // Handle Tab for prompt suggestions (when buffer is empty and no completion/search active)
      // Use explicit key.name === 'tab' instead of ACCEPT_SUGGESTION matcher,
      // because ACCEPT_SUGGESTION also matches Enter which must fall through to SUBMIT.
      if (
        key.name === 'tab' &&
        !key.paste &&
        !key.shift &&
        buffer.text.length === 0 &&
        !showCompletionSuggestions &&
        !reverseSearchActive &&
        !commandSearchActive &&
        followup.state.isVisible &&
        followup.state.suggestion
      ) {
        followup.accept('tab');
        return true;
      }

      // Right arrow fills suggestion into input without submitting
      if (
        key.name === 'right' &&
        !key.ctrl &&
        !key.meta &&
        buffer.text.length === 0 &&
        followup.state.isVisible &&
        followup.state.suggestion
      ) {
        followup.accept('right');
        return true;
      }

      if (showCompletionSuggestions) {
        if (completion.suggestions.length > 1) {
          const isCompletionUpKey = keyMatchers[Command.COMPLETION_UP](key);
          const isCompletionDownKey = keyMatchers[Command.COMPLETION_DOWN](key);
          if (isCompletionUpKey) {
            completion.navigateUp();
            exportCompletion.navigatedRef.current = true;
            exportCompletion.navigatedTextRef.current = buffer.text;
            setExpandedSuggestionIndex(-1);
            return true;
          }
          if (isCompletionDownKey) {
            completion.navigateDown();
            exportCompletion.navigatedRef.current = true;
            exportCompletion.navigatedTextRef.current = buffer.text;
            setExpandedSuggestionIndex(-1);
            return true;
          }
        }

        if (keyMatchers[Command.ACCEPT_SUGGESTION](key) && !key.paste) {
          // Capture the suggestion BEFORE acceptActiveCompletionSuggestion
          // mutates the buffer/index. When the suggestion's command opted
          // into `submitOnAccept` (a leaf command whose bare action takes
          // no further arg, e.g. `/skills`), submit `/<value>` directly
          // instead of just filling the buffer and waiting for a second
          // Enter. This makes `/skil<Enter>` land in the dialog in one
          // keystroke.
          const targetIndex =
            completion.activeSuggestionIndex === -1
              ? 0
              : completion.activeSuggestionIndex;
          const accepted =
            targetIndex >= 0 && targetIndex < completion.suggestions.length
              ? completion.suggestions[targetIndex]
              : undefined;
          acceptActiveCompletionSuggestion();
          // Only auto-submit on Enter — `Command.ACCEPT_SUGGESTION`
          // matches BOTH Tab and Enter (see keyBindings.ts and the
          // identical caveat at lines 861-862). Without the
          // `key.name === 'return'` gate, `/skil<Tab>` would auto-submit
          // and open the dialog, breaking the standard shell convention
          // where Tab means "complete without executing." The implicit
          // contract `submitOnAccept` was designed for is "press Enter on
          // the highlighted suggestion, no second Enter needed."
          if (accepted?.submitOnAccept && key.name === 'return') {
            handleSubmitAndClear(`/${accepted.value}`);
          }
          return true;
        }
      }

      // Accept mid-input ghost text with Tab (when no dropdown is visible)
      if (
        key.name === 'tab' &&
        !key.paste &&
        !key.shift &&
        !showCompletionSuggestions &&
        midInputGhostTextRef.current?.acceptText
      ) {
        buffer.insert(midInputGhostTextRef.current.acceptText);
        return true;
      }

      // Attachment mode handling - process before history navigation
      if (isAttachmentMode && attachments.length > 0) {
        if (key.name === 'left') {
          setSelectedAttachmentIndex((i) => Math.max(0, i - 1));
          return true;
        }
        if (key.name === 'right') {
          setSelectedAttachmentIndex((i) =>
            Math.min(attachments.length - 1, i + 1),
          );
          return true;
        }
        if (keyMatchers[Command.NAVIGATION_DOWN](key)) {
          // Exit attachment mode and return to input
          setIsAttachmentMode(false);
          setSelectedAttachmentIndex(-1);
          return true;
        }
        if (key.name === 'backspace' || key.name === 'delete') {
          handleAttachmentDelete(selectedAttachmentIndex);
          return true;
        }
        if (key.name === 'return' || key.name === 'escape') {
          setIsAttachmentMode(false);
          setSelectedAttachmentIndex(-1);
          return true;
        }
        // For other keys, exit attachment mode and let input handle them
        setIsAttachmentMode(false);
        setSelectedAttachmentIndex(-1);
        // Continue to process the key in input
      }

      // Enter attachment mode when pressing up at the first line with attachments
      if (
        !isAttachmentMode &&
        attachments.length > 0 &&
        !shellModeActive &&
        !reverseSearchActive &&
        !commandSearchActive &&
        buffer.visualCursor[0] === 0 &&
        buffer.visualScrollRow === 0 &&
        keyMatchers[Command.NAVIGATION_UP](key)
      ) {
        setIsAttachmentMode(true);
        setSelectedAttachmentIndex(attachments.length - 1);
        return true;
      }

      if (!shellModeActive) {
        if (keyMatchers[Command.REVERSE_SEARCH](key)) {
          setCommandSearchActive(true);
          setTextBeforeReverseSearch(buffer.text);
          setCursorPosition(buffer.cursor);
          return true;
        }

        if (
          hasActiveToolConfirmation &&
          (keyMatchers[Command.HISTORY_UP](key) ||
            keyMatchers[Command.HISTORY_DOWN](key) ||
            keyMatchers[Command.NAVIGATION_UP](key) ||
            keyMatchers[Command.NAVIGATION_DOWN](key))
        ) {
          return true;
        }

        // Pop all queued messages into input when pressing Up arrow at top of input
        if (
          !isAttachmentMode &&
          uiState.messageQueue.length > 0 &&
          keyMatchers[Command.NAVIGATION_UP](key) &&
          (buffer.allVisualLines.length === 1 ||
            (buffer.visualCursor[0] === 0 && buffer.visualScrollRow === 0))
        ) {
          if (popQueueIntoInput()) return true;
          // returned false (queue already cleared) — fall through to history
        }

        if (keyMatchers[Command.HISTORY_UP](key)) {
          // Two-step edge transition (matches Claude Code):
          // 1. If not on first visual row → move cursor up one row
          // 2. Else if cursor not at col 0 → snap to col 0 (no history change)
          // 3. Else → navigate to older history; cursor lands at offset 0
          const onFirstRow =
            buffer.visualCursor[0] === 0 && buffer.visualScrollRow === 0;
          if (!onFirstRow) {
            buffer.move('up');
            return true;
          }
          if (buffer.visualCursor[1] > 0) {
            buffer.move('home');
            return true;
          }
          if (inputHistory.navigateUp()) {
            buffer.moveToOffset(0);
          }
          return true;
        }
        if (keyMatchers[Command.HISTORY_DOWN](key)) {
          // Two-step edge transition (matches Claude Code):
          // 1. If not on last visual row → move cursor down one row
          // 2. Else if cursor not at end of line → snap to end (no history change)
          // 3. Else → navigate to newer history; cursor lands at end (setText default)
          const lastRowIdx = buffer.allVisualLines.length - 1;
          const onLastRow = buffer.visualCursor[0] === lastRowIdx;
          if (!onLastRow) {
            buffer.move('down');
            return true;
          }
          const lastRowLen = cpLen(buffer.allVisualLines[lastRowIdx] ?? '');
          if (buffer.visualCursor[1] < lastRowLen) {
            buffer.move('end');
            return true;
          }
          if (inputHistory.navigateDown()) {
            return true;
          }
          return descendFromComposer();
        }
        // Handle arrow-up/down for history on single-line or at edges
        if (
          keyMatchers[Command.NAVIGATION_UP](key) &&
          (buffer.allVisualLines.length === 1 ||
            (buffer.visualCursor[0] === 0 && buffer.visualScrollRow === 0))
        ) {
          // Two-step edge transition: snap cursor to col 0 before triggering history
          if (buffer.visualCursor[1] > 0) {
            buffer.move('home');
            return true;
          }
          if (inputHistory.navigateUp()) {
            buffer.moveToOffset(0);
          }
          return true;
        }
        if (
          keyMatchers[Command.NAVIGATION_DOWN](key) &&
          (buffer.allVisualLines.length === 1 ||
            buffer.visualCursor[0] === buffer.allVisualLines.length - 1)
        ) {
          // Two-step edge transition: snap cursor to end of line before triggering history
          const lastRowIdx = buffer.allVisualLines.length - 1;
          const lastRowLen = cpLen(buffer.allVisualLines[lastRowIdx] ?? '');
          if (buffer.visualCursor[1] < lastRowLen) {
            buffer.move('end');
            return true;
          }
          if (inputHistory.navigateDown()) {
            return true;
          }
          return descendFromComposer();
        }
      } else {
        // Shell History Navigation
        if (keyMatchers[Command.NAVIGATION_UP](key)) {
          const prevCommand = shellHistory.getPreviousCommand();
          if (prevCommand !== null) buffer.setText(prevCommand);
          return true;
        }
        if (keyMatchers[Command.NAVIGATION_DOWN](key)) {
          const nextCommand = shellHistory.getNextCommand();
          if (nextCommand !== null) buffer.setText(nextCommand);
          return true;
        }
      }

      if (keyMatchers[Command.SUBMIT](key)) {
        // Accept and submit prompt suggestion on Enter when input is truly empty
        if (
          buffer.text.length === 0 &&
          followup.state.isVisible &&
          followup.state.suggestion
        ) {
          const text = followup.state.suggestion;
          // Skip onAccept (buffer.insert) — we pass the text directly to
          // handleSubmitAndClear which clears the buffer synchronously.
          // Without skipOnAccept the microtask in accept() would re-insert
          // the suggestion into the buffer after it was already cleared.
          followup.accept('enter', { skipOnAccept: true });
          handleSubmitAndClear(text);
          return true;
        }
        if (buffer.text.trim()) {
          // Check if a paste operation occurred recently to prevent accidental auto-submission.
          // Only applies when pasteWorkaround is enabled (Windows or Node < 20), where bracketed
          // paste markers may not work reliably and Enter key events can leak from pasted text.
          if (pasteWorkaround && recentPasteTime !== null) {
            // Paste occurred recently, ignore this submit to prevent auto-execution
            return true;
          }

          const [row, col] = buffer.cursor;
          const line = buffer.lines[row];
          const charBefore = col > 0 ? cpSlice(line, col - 1, col) : '';
          if (charBefore === '\\') {
            buffer.backspace();
            buffer.newline();
          } else {
            handleSubmitAndClear(buffer.text);
          }
        }
        return true;
      }

      // Ctrl+V for clipboard image paste
      if (keyMatchers[Command.PASTE_CLIPBOARD_IMAGE](key)) {
        handleClipboardImage();
        return true;
      }

      // Handle backspace with placeholder-aware deletion
      if (
        pendingPastes.size > 0 &&
        (key.name === 'backspace' ||
          key.sequence === '\x7f' ||
          (key.ctrl && key.name === 'h'))
      ) {
        const text = buffer.text;
        const [row, col] = buffer.cursor;

        // Calculate the offset where the cursor is
        let offset = 0;
        for (let i = 0; i < row; i++) {
          offset += buffer.lines[i].length + 1; // +1 for newline
        }
        offset += col;

        // Check if we're at the end of any placeholder
        for (const placeholder of pendingPastes.keys()) {
          const placeholderStart = offset - placeholder.length;
          if (
            placeholderStart >= 0 &&
            text.slice(placeholderStart, offset) === placeholder
          ) {
            // Delete the entire placeholder
            buffer.replaceRangeByOffset(placeholderStart, offset, '');
            // Remove from pendingPastes and free the ID for reuse
            setPendingPastes((prev) => {
              const next = new Map(prev);
              next.delete(placeholder);
              return next;
            });
            const parsed = parsePlaceholder(placeholder);
            if (parsed) {
              freePlaceholderId(parsed.charCount, parsed.id);
            }
            return true;
          }
        }
        // No placeholder matched — fall through to BaseTextInput's default backspace
      }

      // Ctrl+U (clear-line) — reset export cycling state so a subsequent
      // manual typing of "/export <fmt>" doesn't mistakenly show the
      // persistent suggestion panel as if the user had cycled.
      if (key.ctrl && key.name === 'u') {
        exportCompletion.reset();
      }

      // Ctrl+C with completion active — also reset completion state
      if (keyMatchers[Command.CLEAR_INPUT](key)) {
        exportCompletion.reset();
        if (buffer.text.length > 0) {
          resetCompletionState();
        }
        // Fall through to BaseTextInput's default CLEAR_INPUT handler
      }

      // All remaining keys (readline shortcuts, text input) handled by BaseTextInput
      // Dismiss follow-up suggestion only on printable character input
      if (
        buffer.text.length === 0 &&
        followup.state.isVisible &&
        key.sequence &&
        key.sequence.length === 1 &&
        !key.ctrl &&
        !key.meta
      ) {
        followup.recordKeystroke();
        followup.dismiss();
        onPromptSuggestionDismiss?.();
      }

      if (
        !key.ctrl &&
        !key.meta &&
        !key.paste &&
        ((key.sequence && key.sequence.length === 1) ||
          key.name === 'backspace' ||
          key.name === 'delete')
      ) {
        exportCompletion.markNextTextChangeAsUserInput();
      }
      // NOTE: the former unconditional
      //   `exportCompletion.reset();`
      // at this fallthrough was removed — the phase-2 buffer-text guard above
      // already prevents stale state from affecting non-/export input, and
      // the blanket reset was wiping selection on cursor-only keys such as
      // Home / End / Ctrl+A.
      return false;
    },
    [
      focus,
      buffer,
      completion,
      shellModeActive,
      setShellModeActive,
      onClearScreen,
      inputHistory,
      handleSubmitAndClear,
      shellHistory,
      reverseSearchCompletion,
      handleClipboardImage,
      resetCompletionState,
      escPressCount,
      showEscapePrompt,
      resetEscapeState,
      vimHandleInput,
      reverseSearchActive,
      textBeforeReverseSearch,
      cursorPosition,
      recentPasteTime,
      commandSearchActive,
      commandSearchCompletion,
      onToggleShortcuts,
      showShortcuts,
      uiState,
      isAttachmentMode,
      attachments,
      selectedAttachmentIndex,
      handleAttachmentDelete,
      uiActions,
      pasteWorkaround,
      nextLargePastePlaceholder,
      pendingPastes,
      parsePlaceholder,
      freePlaceholderId,
      agentTabBarFocused,
      bgDialogOpen,
      bgPillFocused,
      hasAgents,
      hasActiveToolConfirmation,
      setAgentTabBarFocused,
      setLivePanelFocused,
      setLivePanelSelectedIndex,
      livePanelFocused,
      livePanelSelectedIndex,
      bgEntries,
      getVisibleBgAgents,
      descendFromComposer,
      enterBgDetailFromPanel,
      setBgSelectedIndex,
      followup,
      onPromptSuggestionDismiss,
      exportCompletion,
      isHistoryRestoredText,
      showCompletionSuggestions,
    ],
  );

  const renderLineWithHighlighting = useCallback(
    (opts: RenderLineOptions): React.ReactNode => {
      const {
        lineText,
        isOnCursorLine,
        cursorCol: cursorVisualColAbsolute,
        showCursor: showCursorOpt,
        absoluteVisualIndex,
        buffer: buf,
      } = opts;
      const mapEntry = buf.visualToLogicalMap[absoluteVisualIndex];
      const [logicalLineIdx, logicalStartCol] = mapEntry;
      const logicalLine = buf.lines[logicalLineIdx] || '';
      const tokens = parseInputForHighlighting(
        logicalLine,
        logicalLineIdx,
        slashCommands,
      );

      const visualStart = logicalStartCol;
      const visualEnd = logicalStartCol + cpLen(lineText);
      const segments = buildSegmentsForVisualSlice(
        tokens,
        visualStart,
        visualEnd,
      );

      const renderedLine: React.ReactNode[] = [];
      let charCount = 0;
      segments.forEach((seg, segIdx) => {
        const segLen = cpLen(seg.text);
        let display = seg.text;

        if (isOnCursorLine) {
          const segStart = charCount;
          const segEnd = segStart + segLen;
          if (
            cursorVisualColAbsolute >= segStart &&
            cursorVisualColAbsolute < segEnd
          ) {
            const charToHighlight = cpSlice(
              seg.text,
              cursorVisualColAbsolute - segStart,
              cursorVisualColAbsolute - segStart + 1,
            );
            const highlighted = showCursorOpt
              ? chalk.inverse(charToHighlight)
              : charToHighlight;
            display =
              cpSlice(seg.text, 0, cursorVisualColAbsolute - segStart) +
              highlighted +
              cpSlice(seg.text, cursorVisualColAbsolute - segStart + 1);
          }
          charCount = segEnd;
        }

        const color =
          seg.type === 'command' || seg.type === 'file'
            ? theme.text.accent
            : theme.text.primary;

        renderedLine.push(
          <Text key={`token-${segIdx}`} color={color}>
            {display}
          </Text>,
        );
      });

      if (isOnCursorLine && cursorVisualColAbsolute === cpLen(lineText)) {
        // Check for mid-input ghost text (only renders when cursor is at end of input)
        const ghostText = midInputGhostTextRef.current;
        if (ghostText && showCursorOpt && ghostText.text.length > 0) {
          if (ghostText.showCursorBeforeText) {
            renderedLine.push(
              <Text key="ghost-cursor">{chalk.inverse(' ')}</Text>,
            );
            renderedLine.push(
              <Text key="ghost-rest" color={theme.text.secondary}>
                {ghostText.text}
              </Text>,
            );
          } else {
            // First ghost char: inverted (as cursor). Rest: dimmed gray.
            const firstChar = ghostText.text[0]!;
            const rest = ghostText.text.slice(firstChar.length);
            renderedLine.push(
              <Text key="ghost-cursor">{chalk.inverse(firstChar)}</Text>,
            );
            if (rest.length > 0) {
              renderedLine.push(
                <Text key="ghost-rest" color={theme.text.secondary}>
                  {rest}
                </Text>,
              );
            }
          }
          renderedLine.push(<Text key="ghost-zwsp">{`\u200B`}</Text>);
        } else {
          // Add zero-width space after cursor to prevent Ink from trimming trailing whitespace
          renderedLine.push(
            <Text key={`cursor-end-${cursorVisualColAbsolute}`}>
              {showCursorOpt ? chalk.inverse(' ') + '\u200B' : ' \u200B'}
            </Text>,
          );
        }
      }

      return <Text>{renderedLine}</Text>;
    },
    [slashCommands],
  );

  const getActiveCompletion = () => {
    if (commandSearchActive) return commandSearchCompletion;
    if (reverseSearchActive) return reverseSearchCompletion;
    return completion;
  };

  const activeCompletion = getActiveCompletion();
  const shouldUseExportSuggestions =
    !commandSearchActive && !reverseSearchActive && !isHistoryRestoredText;
  const suggestionDisplayProps =
    shouldUseExportSuggestions && exportCompletion.suggestionDisplayProps
      ? exportCompletion.suggestionDisplayProps
      : {
          suggestions: activeCompletion.suggestions,
          activeIndex: activeCompletion.activeSuggestionIndex,
          isLoading: activeCompletion.isLoadingSuggestions,
          scrollOffset: activeCompletion.visibleStartIndex,
        };
  const shouldShowSuggestions =
    (shouldUseExportSuggestions && exportCompletion.shouldShowSuggestions) ||
    (!isHistoryRestoredText || commandSearchActive || reverseSearchActive
      ? activeCompletion.showSuggestions
      : false);

  // Whether any input-side handler would consume a Tab keystroke. AppContainer
  // feeds this into useAutoAcceptIndicator's `shouldBlockTab` so the
  // Windows-only "bare Tab cycles approval mode" fallback doesn't double-fire
  // alongside an input-area Tab handler. See issue #4171.
  //
  // Note on reverse/command-search: when those overlays have matches, their
  // `showSuggestions` flag flows into `shouldShowSuggestions` above and Tab IS
  // consumed (ACCEPT_SUGGESTION_REVERSE_SEARCH). When they are active with no
  // matches, Tab is not consumed — so the bare `reverseSearchActive` /
  // `commandSearchActive` flags are intentionally NOT included here.
  const hasTabConsumer =
    shouldShowSuggestions ||
    (followup.state.isVisible && Boolean(followup.state.suggestion)) ||
    Boolean(completion.midInputGhostText?.acceptText);

  // Narrow signal — autocomplete dropdown only. Composer hides Footer /
  // KeyboardShortcuts when this is true because the dropdown competes for
  // the same vertical space. Followup / ghost text are inline within the
  // input box and must NOT hide the Footer (#4308 review).
  useEffect(() => {
    onSuggestionsVisibilityChange?.(shouldShowSuggestions);
  }, [shouldShowSuggestions, onSuggestionsVisibilityChange]);

  // Broad signal — any Tab consumer. Reset to false on unmount (e.g. when
  // InputPrompt unmounts during streaming) so AppContainer's stale
  // `hasTabConsumer` doesn't keep blocking Windows Tab approval-mode cycling
  // while there is no input area to consume the keystroke.
  useEffect(() => {
    onTabConsumerChange?.(hasTabConsumer);
    return () => onTabConsumerChange?.(false);
  }, [hasTabConsumer, onTabConsumerChange]);

  // Trigger prompt suggestion when prop changes
  useEffect(() => {
    followup.setSuggestion(promptSuggestion ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on prop change
  }, [promptSuggestion]);

  const approvalModePromptStyle = !shellModeActive
    ? getApprovalModePromptStyle(approvalMode)
    : undefined;

  let statusColor: string | undefined;
  let statusText = '';
  if (shellModeActive) {
    statusColor = theme.ui.symbol;
    statusText = t('Shell mode');
  } else if (approvalModePromptStyle?.color) {
    statusColor = approvalModePromptStyle.color;
    if (approvalMode === ApprovalMode.YOLO) {
      statusText = t('YOLO mode');
    } else if (approvalMode === ApprovalMode.AUTO_EDIT) {
      statusText = t('Accepting edits');
    } else if (approvalMode === ApprovalMode.AUTO) {
      statusText = t('Auto mode');
    }
  }

  const borderColor =
    isShellFocused && !isEmbeddedShellFocused && !agentTabBarFocused
      ? (statusColor ?? theme.border.focused)
      : theme.border.default;

  const prefixNode = (
    <Text
      color={statusColor ?? theme.text.accent}
      aria-label={statusText || undefined}
    >
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
      ) : approvalModePromptStyle ? (
        approvalModePromptStyle.prefix
      ) : (
        '>'
      )}{' '}
    </Text>
  );

  return (
    <>
      {attachments.length > 0 && (
        <Box marginLeft={2} marginBottom={0}>
          <Text color={theme.text.secondary}>{t('Attachments: ')}</Text>
          {attachments.map((att, idx) => (
            <Text
              key={att.id}
              color={
                isAttachmentMode && idx === selectedAttachmentIndex
                  ? theme.status.success
                  : theme.text.secondary
              }
            >
              [{att.filename}]{idx < attachments.length - 1 ? ' ' : ''}
            </Text>
          ))}
        </Box>
      )}
      <BaseTextInput
        buffer={buffer}
        onSubmit={handleSubmitAndClear}
        onKeypress={handleInput}
        showCursor={showCursor}
        placeholder={
          followup.state.isVisible && followup.state.suggestion
            ? followup.state.suggestion
            : placeholder
        }
        prefix={prefixNode}
        borderColor={borderColor}
        topRightLabel={uiState.sessionName || undefined}
        isActive={!isEmbeddedShellFocused}
        renderLine={renderLineWithHighlighting}
      />
      {shouldShowSuggestions && (
        <Box marginLeft={2} marginRight={2}>
          <SuggestionsDisplay
            suggestions={suggestionDisplayProps.suggestions}
            activeIndex={suggestionDisplayProps.activeIndex}
            isLoading={suggestionDisplayProps.isLoading}
            width={suggestionsWidth}
            scrollOffset={suggestionDisplayProps.scrollOffset}
            userInput={buffer.text}
            mode={
              buffer.text.startsWith('/') &&
              !reverseSearchActive &&
              !commandSearchActive
                ? 'slash'
                : 'reverse'
            }
            expandedIndex={expandedSuggestionIndex}
          />
        </Box>
      )}
      {/* Attachment hints - show when there are attachments and no suggestions visible */}
      {attachments.length > 0 && !shouldShowSuggestions && (
        <Box marginLeft={2} marginRight={2}>
          <Text color={theme.text.secondary}>
            {isAttachmentMode
              ? t('← → select, Delete to remove, ↓ to exit')
              : t('↑ to manage attachments')}
          </Text>
        </Box>
      )}
    </>
  );
};
