/* eslint-disable react/no-unknown-property */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/** @jsxImportSource @opentui/react */

/**
 * The real InputPrompt, ported from the ink composer
 * (packages/cli/src/ui/components/InputPrompt.tsx + BaseTextInput.tsx) onto
 * OpenTUI. Ink owns text, logical caret and undo; the native textarea renders
 * that buffer and supplies mouse/selection geometry. Everything the original
 * adds on top is ported here:
 *
 *  - appearance: the BaseTextInput chrome — a full-width top border line, a
 *    bottom border only, the approval-mode `>`/`*` prefix in its status
 *    color (theme.text.accent otherwise), the dim placeholder
 *    ("Type your message or @path/to/file"), and the SuggestionsDisplay
 *    dropdown below the box;
 *  - history: ↑/↓ (and Ctrl+P/N) walk the submitted prompts through the
 *    ported InputHistory with the original two-step edge transition;
 *  - completions: `/command` suggestions from the real interactive command
 *    registry and `@` suggestions from ink's own useAtCompletion — files,
 *    prior sessions, MCP references and extensions behind a category tab bar —
 *    with the original accept rules (Tab/Enter, trailing space, directory
 *    drill-in);
 *  - Esc: double-Esc clears the buffer (footer-style "Press Esc again to
 *    clear." hint surfaced via onEscapeArmedChange); while streaming Esc
 *    interrupts instead (in shell mode it exits the mode first, and also
 *    interrupts a live turn);
 *  - Enter submits to the parent (real client wiring), `\`+Enter continues
 *    the line, Shift+Enter inserts a newline.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from '@opentui/react';
import {
  handleEditorKey,
  isDeleteWordBackwardSequence,
  isPrintableKeyInput,
  isUnmodifiedBackspaceSequence,
} from './input-prompt-key.js';
import type { KeyEvent, PasteEvent, TextareaRenderable } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import { ApprovalMode, Storage, type Config } from '@qwen-code/qwen-code-core';
import {
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages,
  readClipboardText,
} from '../utils/clipboardUtils.js';
import path from 'node:path';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { classifyPastedImagePaths } from '../utils/pasted-image-paths.js';
import { isSlashCommand } from '../utils/commandUtils.js';
import {
  framePasteExpansion,
  unframeClipboardPastes,
} from '../utils/paste-placeholders.js';
import { editTextInExternalEditor } from '../utils/external-editor.js';
import type { Key } from '../hooks/useKeypress.js';
import { useDoublePress } from '../hooks/useDoublePress.js';
import type { VimBuffer } from '../hooks/vim.js';
import {
  useTextBuffer,
  logicalPosToOffset,
  handleTextBufferInput,
} from '../components/shared/text-buffer.js';
import {
  projectTextBuffer,
  nativeOffsetToCodePoint,
  replaceNativeSelection,
} from './text-buffer-view.js';
import { createVimBuffer } from './vim-buffer.js';
import { useShellHistory } from '../hooks/useShellHistory.js';
import { useReverseSearchCompletion } from '../hooks/useReverseSearchCompletion.js';
import {
  allowEditorTypeInSandbox,
  isValidEditorType,
} from '@qwen-code/qwen-code-core/utils/editor.js';
import {
  restoreInputSubmissions,
  type OpenTuiRestoredDraft,
  type OpenTuiInputSubmission,
  type OpenTuiCancelSettled,
  type OpenTuiComposerHandle,
} from './input-submission.js';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import type { RecentSlashCommand } from '../hooks/useSlashCompletion.js';
import {
  MAX_SUGGESTION_LABEL_WIDTH,
  normalizeDescription,
  prepareSuggestionLabel,
  type Suggestion,
} from '../utils/suggestions.js';
import {
  clipToWidth,
  cpLen,
  getCachedStringWidth,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  stripUnsafeCharacters,
  toCodePoints,
  truncateToWidth,
} from '../utils/textUtils.js';
import { C } from './theme.js';
import { useBatchSafeCursor, useBatchSafeState } from './batch-cursor.js';
import { useFollowupSuggestionsCLI } from '../hooks/useFollowupSuggestions.js';
import { useAtCompletion } from '../hooks/useAtCompletion.js';
import { categoryLabel } from '../components/SuggestionsDisplay.js';
import { t } from '../../i18n/index.js';
import { InputHistory } from './input-history.js';
import {
  usePromptVoiceInput,
  type PromptVoiceInputOptions,
} from '../hooks/use-prompt-voice-input.js';
import { OpenTuiVoiceIndicator } from './OpenTuiVoiceIndicator.js';
import { Command, matchesCommand, toOriginalKey } from './key-map.js';
import { loadInteractiveCommands } from './slash-dispatch.js';
import {
  CompletionMode,
  EscapeClearModel,
  MAX_SUGGESTIONS_TO_SHOW,
  applyCompletion,
  atCategoryTabs,
  commandCompletionItemsToSuggestions,
  decideSubmit,
  detectCompletionTarget,
  expandPendingPastePlaceholders,
  filterByCategory,
  freePastePlaceholderId,
  isLargePaste,
  isPerfectMatchForTarget,
  nextCategory,
  nextLargePastePlaceholder,
  normalizePastedText,
  parsePastePlaceholder,
  parseSlashCommandQuery,
  slashCommandPool,
  slashCompletionPositions,
  subcommandSuggestions,
  suggestionWindow,
  type CompletionCategory,
} from './input-prompt-model.js';

/**
 * Minimal CommandContext for argument completion (`command.completion`).
 * Same shape as the dispatcher's context; completion functions read
 * `services.config` (or nothing) and never drive UI.
 */
function buildCompletionContext(
  config: Config | null,
  invocation: { raw: string; name: string; args: string },
): CommandContext {
  return {
    executionMode: 'interactive',
    invocation,
    services: { config, settings: null, logger: null },
    ui: {
      history: [],
      addItem: () => 0,
      clear: () => {},
      setDebugMessage: () => {},
      pendingItem: null,
      setPendingItem: () => {},
      btwItem: null,
      setBtwItem: () => {},
      cancelBtw: () => {},
      btwAbortControllerRef: { current: null },
      isIdleRef: { current: true },
      loadHistory: () => {},
      refreshStatic: () => {},
      toggleVimEnabled: async () => false,
      setGeminiMdFileCount: () => {},
      reloadCommands: () => {},
      setSessionName: () => {},
      extensionsUpdateState: new Map(),
      dispatchExtensionStateUpdate: () => {},
      addConfirmUpdateExtensionRequest: () => {},
    },
    session: {
      stats: {
        sessionId: '',
        sessionStartTime: new Date(),
        metrics: {},
        lastPromptTokenCount: 0,
        promptCount: 0,
      },
      sessionShellAllowlist: new Set<string>(),
    },
  } as unknown as CommandContext;
}

const DEFAULT_PLACEHOLDER = '  Type your message or @path/to/file';
const ESCAPE_ARM_HINT = 'Press Esc again to clear.';
const noPathInference = () => false;
/** Floor a described `@` row keeps for its description (ink parity). */
const MIN_DESCRIPTION_WIDTH = 12;

/** Approval-mode chrome exactly like InputPrompt's statusColor/prefix. */
function promptChrome(approvalMode: ApprovalMode | undefined): {
  prefix: string;
  color?: string;
} {
  switch (approvalMode) {
    case ApprovalMode.AUTO_EDIT:
      return { prefix: '>', color: C.warningDim };
    case ApprovalMode.AUTO:
      return { prefix: '>', color: C.purple };
    case ApprovalMode.YOLO:
      return { prefix: '*', color: C.errorDim };
    case ApprovalMode.PLAN:
    case ApprovalMode.DEFAULT:
      return { prefix: '>' };
    default:
      return { prefix: '>' };
  }
}

type Attachment = { id: string; path: string; filename: string };
type Draft = {
  attachments: Attachment[];
  pending: Promise<void> | null;
  fallback: string[];
  valid: boolean;
};
const newDraft = (): Draft => ({
  attachments: [],
  pending: null,
  fallback: [],
  valid: true,
});

export interface InputPromptProps {
  onSubmit: (
    text: string,
    imagePaths?: readonly string[],
    options?: Omit<OpenTuiInputSubmission, 'text' | 'imagePaths'>,
  ) => boolean | Promise<boolean>;
  onNotice?: (text: string) => void;
  preferredEditor?: string;
  voice?: Omit<PromptVoiceInputOptions, 'config' | 'buffer' | 'onSubmit'>;
  vim?: {
    buffer: RefObject<VimBuffer | null>;
    handleInput: (key: Key) => boolean;
    enabled: boolean;
  };
  /** Submitted prompts (chronological) feeding history navigation. */
  userMessages: readonly string[];
  config?: Config;
  /** Live agent turn in flight: Esc interrupts instead of clearing. */
  streaming?: boolean;
  /** Esc-while-streaming hook (aborts the live turn in the parent). */
  onInterrupt?: (onSettled?: OpenTuiCancelSettled) => void;
  onCancelCommand?: () => boolean;
  onShellKey?: (key: KeyEvent) => boolean;
  onShellPaste?: (text: string) => boolean;
  onRetry?: () => void;
  onRewind?: () => void;
  approvalMode?: ApprovalMode;
  placeholder?: string;
  topRightLabel?: string;
  focus?: boolean;
  /** Reports the double-Esc armed state (the footer hint). */
  onEscapeArmedChange?: (armed: boolean) => void;
  /** Lets the parent read/clear the composer buffer (Ctrl+Q queue). */
  composerHandle?: {
    current: OpenTuiComposerHandle | null;
  };
  /** Queued prompts awaiting the next turn (drives Esc/↑ pop-back parity). */
  queueLength?: number;
  /** Returns editable queued payloads with their attachments and source. */
  onPopQueue?: () => OpenTuiInputSubmission | null;
  /** Recently used slash commands feeding recency-weighted ranking. */
  recentSlashCommands?: ReadonlyMap<string, RecentSlashCommand>;
  /** U-7: finished follow-up suggestion published by the entry layer. */
  promptSuggestion?: string | null;
  /** U-7: clears the published suggestion (accept/typing/submit). */
  onPromptSuggestionDismiss?: () => void;
  /**
   * U-7/R2-2: aborts the suggestion without clearing it — typing over the
   * ghost keeps it restorable after type-then-delete (ink parity).
   */
  onPromptSuggestionAbort?: () => void;
  /** U-33: `!` shell mode is active (ink shellModeActive chrome parity). */
  shellModeActive?: boolean;
  /** U-33: toggles shell mode (empty-buffer `!`, ink InputPrompt parity). */
  onToggleShellMode?: () => void;
  /**
   * Completion-dropdown visibility, lifted for the shell: ink's Composer hides
   * the footer while the suggestion list is open, and here the footer is a
   * sibling of the composer rather than a child of it.
   */
  onSuggestionsVisibilityChange?: (visible: boolean) => void;
  /**
   * Cycles the approval mode (ink `useAutoAcceptIndicator`). The shell owns
   * Shift+Tab itself, so this is only the Windows bare-Tab fallback — the one
   * route that has to stay here, because the composer is the only place that
   * knows whether Tab was already spent on a completion.
   */
  onCycleApprovalMode?: () => void;
}

export function OpenTuiInputPrompt(props: InputPromptProps) {
  const {
    onSubmit,
    onNotice,
    userMessages,
    config,
    streaming = false,
    onInterrupt,
    onCancelCommand,
    approvalMode,
    placeholder = DEFAULT_PLACEHOLDER,
    topRightLabel,
    focus = true,
    onEscapeArmedChange,
    queueLength = 0,
    onPopQueue,
    recentSlashCommands,
    promptSuggestion,
    onPromptSuggestionDismiss,
    onPromptSuggestionAbort,
    shellModeActive = false,
    onToggleShellMode,
    onSuggestionsVisibilityChange,
    onCycleApprovalMode,
  } = props;

  const { width } = useTerminalDimensions();
  const renderer = useRenderer();
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const shellModeRef = useRef(shellModeActive);
  shellModeRef.current = shellModeActive;
  const editorRef = useRef<TextareaRenderable | null>(null);
  const scrollCursorBefore = useRef<number | null>(null);
  const vimModeEnabled = props.vim?.enabled ?? false;
  const userMessagesRef = useRef(userMessages);
  userMessagesRef.current = userMessages;
  // Read through a ref inside refreshCompletion so recency updates never
  // widen the callback's dependency list (it stays keyed to config only).
  const recentSlashCommandsRef = useRef(recentSlashCommands);
  recentSlashCommandsRef.current = recentSlashCommands;

  const historyRef = useRef<InputHistory | null>(null);
  if (!historyRef.current) {
    historyRef.current = new InputHistory(() => userMessagesRef.current);
  }
  const escapeRef = useRef<EscapeClearModel | null>(null);
  if (!escapeRef.current) {
    escapeRef.current = new EscapeClearModel();
  }

  const [textVersion, setTextVersion] = useState(0);
  const onBufferChange = useCallback(() => setTextVersion((v) => v + 1), []);
  const buffer = useTextBuffer({
    viewport: {
      width: editorRef.current?.width || Math.max(1, width - 2),
      height: 8,
    },
    onChange: onBufferChange,
    pasteHistory: {
      capture: () => pendingPastesRef.current,
      restore: (snapshot) => restorePasteMap(snapshot),
    },
    isValidPath: noPathInference,
    shellModeActive,
  });
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const [logicalRow, logicalCol] = buffer.cursor;
  useEffect(() => {
    onBufferChange();
  }, [logicalRow, logicalCol, onBufferChange]);
  const replaceText = useCallback((text: string) => {
    editorRef.current?.clearSelection();
    bufferRef.current.setText(text);
  }, []);
  const insertText = useCallback((value: string) => {
    const text = stripUnsafeCharacters(value.replace(/\r\n?/g, '\n'));
    const editor = editorRef.current;
    if (!editor || !replaceNativeSelection(editor, bufferRef.current, text)) {
      bufferRef.current.insert(text);
    }
  }, []);
  const backspace = useCallback(() => {
    const editor = editorRef.current;
    if (editor && replaceNativeSelection(editor, bufferRef.current, '')) return;
    if (pendingPastesRef.current.size > 0) {
      const plainText = bufferRef.current.text;
      const codePoints = toCodePoints(plainText);
      const cursorCpOffset = logicalPosToOffset(
        bufferRef.current.lines,
        ...bufferRef.current.cursor,
      );
      for (const placeholder of pendingPastesRef.current.keys()) {
        const placeholderStart = cursorCpOffset - placeholder.length;
        if (
          placeholderStart >= 0 &&
          codePoints.slice(placeholderStart, cursorCpOffset).join('') ===
            placeholder
        ) {
          bufferRef.current.replaceRangeByOffset(
            placeholderStart,
            cursorCpOffset,
            '',
          );
          pendingPastesRef.current.delete(placeholder);
          const parsedPlaceholder = parsePastePlaceholder(placeholder);
          if (parsedPlaceholder) {
            freePastePlaceholderId(
              activePlaceholderIdsRef.current,
              parsedPlaceholder.charCount,
              parsedPlaceholder.id,
            );
          }
          return;
        }
      }
    }
    bufferRef.current.backspace();
  }, []);
  const vimBuffer = useMemo(() => {
    const forwarding = createVimBuffer(() => bufferRef.current);
    forwarding.handleInput = (key) =>
      handleTextBufferInput(key, {
        insert: insertText,
        newline: () => insertText('\n'),
        backspace,
        del: () => {
          const editor = editorRef.current;
          if (!editor || !replaceNativeSelection(editor, bufferRef.current, ''))
            bufferRef.current.del();
        },
        move: (direction) => {
          editorRef.current?.clearSelection();
          bufferRef.current.move(direction);
        },
        deleteWordLeft: () => bufferRef.current.deleteWordLeft(),
        deleteWordRight: () => bufferRef.current.deleteWordRight(),
        undo: () => {
          editorRef.current?.clearSelection();
          bufferRef.current.undo();
        },
        redo: () => {
          editorRef.current?.clearSelection();
          bufferRef.current.redo();
        },
      });
    return forwarding;
  }, [insertText, backspace]);
  useLayoutEffect(() => {
    if (props.vim) props.vim.buffer.current = vimBuffer;
    const editor = editorRef.current;
    if (editor) projectTextBuffer(editor, buffer, renderer.widthMethod);
    return () => {
      if (props.vim) props.vim.buffer.current = null;
    };
  }, [buffer, vimBuffer, props.vim, renderer]);
  const shellHistory = useShellHistory(
    config?.getProjectRoot?.() ?? process.cwd(),
  );
  const { addCommandToHistory } = shellHistory;
  const {
    value: searchActive,
    ref: searchActiveRef,
    setValue: setSearchActive,
  } = useBatchSafeState(false);
  const [expandedSearchIndex, setExpandedSearchIndex] = useState(-1);
  const commandHistory = useMemo(
    () => [...userMessages].reverse(),
    [userMessages],
  );
  const setSearchText = useCallback(
    (text: string) => {
      replaceText(shellModeActive ? text : unframeClipboardPastes(text));
      setTextVersion((v) => v + 1);
    },
    [replaceText, shellModeActive],
  );
  const search = useReverseSearchCompletion(
    { text: bufferRef.current.text, setText: setSearchText },
    shellModeActive ? shellHistory.history : commandHistory,
    searchActive,
  );
  const { resetCompletionState: resetSearchCompletion } = search;
  // Raw producer output. `suggestions` below is this list filtered to the
  // active `@` category tab, so navigation, acceptance and the visible window
  // all index the same rows the user sees (ink useCompletion).
  const [rawSuggestions, setRawSuggestions] = useState<readonly Suggestion[]>(
    [],
  );
  const {
    value: activeCategory,
    ref: activeCategoryRef,
    setValue: setActiveCategory,
  } = useBatchSafeState<CompletionCategory>('all');
  const categoryTabs = searchActive ? [] : atCategoryTabs(rawSuggestions);
  // Derived rather than corrected in an effect: a tab that a newer result set
  // no longer contains reads as 'all' for this render, which is ink's fallback.
  const atCategory = categoryTabs.includes(activeCategory)
    ? activeCategory
    : 'all';
  const suggestions = searchActive
    ? search.suggestions
    : filterByCategory(rawSuggestions, atCategory);
  const {
    cursor: completionIndex,
    cursorRef: activeIndexRef,
    setCursor: setActiveIndex,
  } = useBatchSafeCursor();
  const activeIndex = searchActive
    ? search.activeSuggestionIndex
    : completionIndex;
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [escapeArmed, setEscapeArmed] = useState(false);
  const [rewindArmed, setRewindArmed] = useState(false);
  const rewindPress = useDoublePress(() => props.onRewind?.(), setRewindArmed);
  const draftRef = useRef<Draft>(newDraft());
  const claimedDraftRef = useRef<Draft | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const {
    value: selectedAttachment,
    ref: selectedAttachmentRef,
    setValue: setSelectedAttachment,
  } = useBatchSafeState(-1);
  const restoredProvenanceRef = useRef<{
    text: string;
    submittedPrompt: string;
  } | null>(null);
  const clipboardUnavailableShownRef = useRef(false);
  const showAttachments = useCallback(
    () => setAttachments([...draftRef.current.attachments]),
    [],
  );
  const completionModeRef = useRef<CompletionMode>(CompletionMode.IDLE);
  // History-restored text suppresses re-opening the dropdown, like the
  // original's isHistoryRestoredText.
  const historyRestoredTextRef = useRef<string | null>(null);
  const unknownHistoryInputRef = useRef(false);
  const restoredQueueDraftRef = useRef<OpenTuiRestoredDraft | null>(null);
  const dismissedUntilChangeRef = useRef<string | null>(null);
  const commandsRef = useRef<readonly SlashCommand[]>([]);
  // Query-relative replacement range for the current buffer's SLASH target.
  // The perfect-match verdict is deliberately not cached alongside it: Enter
  // recomputes that one from the buffer (see the Enter branch below).
  const slashRangeRef = useRef<{ start: number; end: number } | null>(null);
  // Sequence guard for async argument completion (drops stale results).
  const slashSearchSeqRef = useRef(0);
  // The user navigated the dropdown with ↑/↓ (reset on recompute/accept):
  // with a perfect match AND navigation, Enter accepts the highlighted
  // suggestion instead of submitting the typed text (ink navigatedRef).
  const suggestionNavigatedRef = useRef(false);
  // Large-paste collapsing: placeholder → full pasted text, restored on
  // submit (ink pendingPastes).
  const pendingPastesRef = useRef<Map<string, string>>(new Map());
  const activePlaceholderIdsRef = useRef<Map<number, Set<number>>>(new Map());
  const searchSnapshot = useRef({
    text: '',
    offset: 0,
    provenance: restoredProvenanceRef.current,
    restoredDraft: restoredQueueDraftRef.current,
    unknownInput: false,
    historyText: historyRestoredTextRef.current,
    pasteExpansions: new Map<string, string>(),
    placeholderIds: new Map<number, Set<number>>(),
  });
  const invalidateImportedInput = useCallback(() => {
    restoredProvenanceRef.current = null;
    restoredQueueDraftRef.current = null;
    unknownHistoryInputRef.current = true;
  }, []);
  useLayoutEffect(
    () => () => {
      restoredQueueDraftRef.current = null;
    },
    [],
  );

  // U-7: follow-up suggestion lifecycle, shared with ink via the
  // renderer-neutral controller hook. Acceptance inserts into the composer
  // buffer (never submits — /clear must not fire on Enter).
  const {
    state: followupState,
    accept: acceptFollowup,
    dismiss: dismissFollowup,
    recordKeystroke: recordFollowupKeystroke,
    setSuggestion: setFollowupSuggestion,
  } = useFollowupSuggestionsCLI({
    config,
    isFocused: focus,
    onAccept: (suggestion) => {
      const el = editorRef.current;
      if (!el) return;
      insertText(suggestion);
      setTextVersion((v) => v + 1);
    },
  });
  useEffect(() => {
    setFollowupSuggestion(promptSuggestion ?? null);
  }, [setFollowupSuggestion, promptSuggestion]);
  // Single source of truth for "is there a suggestion the user can accept
  // right now" (ink availableSuggestion): the live controller suggestion if
  // visible, otherwise the persisted prop (pre-show delay / type-then-delete).
  const availableSuggestion: string | null =
    followupState.isVisible || promptSuggestion
      ? (followupState.suggestion ?? promptSuggestion ?? null)
      : null;

  const restorePasteMap = useCallback(
    (snapshot: ReadonlyMap<string, string>) => {
      const restored = new Map(snapshot);
      pendingPastesRef.current.clear();
      for (const [placeholder, body] of restored) {
        pendingPastesRef.current.set(placeholder, body);
      }
      activePlaceholderIdsRef.current.clear();
      for (const placeholder of restored.keys()) {
        const parsed = parsePastePlaceholder(placeholder);
        if (!parsed) continue;
        const ids =
          activePlaceholderIdsRef.current.get(parsed.charCount) ??
          new Set<number>();
        ids.add(parsed.id);
        activePlaceholderIdsRef.current.set(parsed.charCount, ids);
      }
    },
    [],
  );
  const restoreQueuedDraft = useCallback(
    (draft: OpenTuiRestoredDraft) => {
      restorePasteMap(draft.pasteExpansions ?? new Map());
      unknownHistoryInputRef.current = draft.hasUnknownInput;
      restoredQueueDraftRef.current = draft;
    },
    [restorePasteMap],
  );

  // Shell mode overrides the approval chrome (ink InputPrompt order: `!` wins
  // over the approval-mode prefix). The label itself lives in the footer, as
  // ink's ShellModeIndicator does.
  const chrome = searchActive
    ? { prefix: '(r:)', color: C.accent }
    : shellModeActive
      ? { prefix: '!', color: C.symbol }
      : promptChrome(approvalMode);
  const borderColor = focus
    ? (chrome.color ?? C.borderFocused)
    : C.borderDefault;

  // ── real command registry feeding /-completion ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    loadInteractiveCommands(config ?? null)
      .then((commands) => {
        if (!cancelled) commandsRef.current = commands;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [config]);

  // ── @-completion sources (files, sessions, MCP, extensions) ──────────────
  // ink's own hook, reused verbatim: it owns the FileSearch lifecycle and the
  // merge order (mcp → file → session). `refreshCompletion` publishes the
  // query; null disables the hook.
  const projectRoot = config?.getTargetDir() ?? process.cwd();
  const [atQuery, setAtQuery] = useState<string | null>(null);
  // Both callbacks are gated on the mode ref: leaving AT makes the hook
  // dispatch RESET, and that flush lands after the render in which
  // refreshCompletion already published the slash list for the same keystroke.
  const onAtSuggestions = useCallback(
    (next: Suggestion[]) => {
      if (completionModeRef.current !== CompletionMode.AT) return;
      setRawSuggestions(next);
      setActiveIndex(0);
    },
    [setActiveIndex],
  );
  const onAtLoading = useCallback((loading: boolean) => {
    if (completionModeRef.current !== CompletionMode.AT) return;
    setLoadingSuggestions(loading);
  }, []);
  useAtCompletion({
    enabled: atQuery !== null,
    pattern: atQuery ?? '',
    config: config ?? undefined,
    cwd: projectRoot,
    setSuggestions: onAtSuggestions,
    setIsLoadingSuggestions: onAtLoading,
  });

  // The completion target for the buffer as it stands right now. Read from the
  // editor, never from published state, so a key that lands before the
  // completion effect flushes still sees the text the user typed.
  const currentCompletionTarget = useCallback(() => {
    const el = editorRef.current;
    if (!el) return null;
    const text = bufferRef.current.text;
    const [row, col] = bufferRef.current.cursor;
    const lines = bufferRef.current.lines;
    return detectCompletionTarget(
      lines,
      row,
      col,
      text,
      logicalPosToOffset(lines, row, col),
      commandsRef.current,
    );
  }, []);

  // ── completion recomputation on every buffer/cursor change ──────────────
  const refreshCompletion = useCallback(() => {
    if (searchActiveRef.current) return;
    const el = editorRef.current;
    if (!el) return;
    const text = bufferRef.current.text;
    const target = currentCompletionTarget();

    const restored = historyRestoredTextRef.current;
    const suppressedByHistory = restored !== null && text === restored;
    const dismissed =
      dismissedUntilChangeRef.current !== null &&
      dismissedUntilChangeRef.current === text;

    if (!target || suppressedByHistory || dismissed) {
      completionModeRef.current = CompletionMode.IDLE;
      slashRangeRef.current = null;
      suggestionNavigatedRef.current = false;
      setAtQuery(null);
      setActiveCategory('all');
      setRawSuggestions([]);
      setActiveIndex(0);
      setLoadingSuggestions(false);
      return;
    }

    completionModeRef.current = target.mode;
    // Publishing the query is the whole AT branch: the hook does the search.
    setAtQuery(target.mode === CompletionMode.AT ? target.query : null);
    // Any buffer change invalidates dropdown navigation (ink resets
    // navigatedRef when the query changes).
    suggestionNavigatedRef.current = false;

    if (target.mode === CompletionMode.SLASH) {
      // Mid-input / stacked-skill tokens complete against the filtered pool
      // (ink slashCommandsForCompletion parity); line-led commands see the
      // full registry.
      const pool = slashCommandPool(target, commandsRef.current);
      const parsed = parseSlashCommandQuery(target.query, pool);
      slashRangeRef.current = slashCompletionPositions(target.query, parsed);

      // Argument completion: the leaf command's async completion() supplies
      // the candidates (ink useCommandSuggestions), e.g. `/cd <path>`,
      // `/model <id>`, `/curator pin <dir>`.
      const leaf = parsed.leafCommand;
      const complete = leaf?.completion;
      if (parsed.isArgumentCompletion && leaf && complete) {
        const seq = ++slashSearchSeqRef.current;
        setLoadingSuggestions(true);
        const context = buildCompletionContext(config ?? null, {
          raw: parsed.invocationRaw,
          name: leaf.name,
          args: parsed.argumentString,
        });
        void complete(context, parsed.argumentString)
          .then((results) => {
            if (slashSearchSeqRef.current !== seq) return;
            setRawSuggestions(
              commandCompletionItemsToSuggestions(results ?? []),
            );
            setActiveIndex(0);
          })
          .catch(() => {
            if (slashSearchSeqRef.current === seq) setRawSuggestions([]);
          })
          .finally(() => {
            if (slashSearchSeqRef.current === seq) setLoadingSuggestions(false);
          });
        return;
      }

      // Sub-command level: ranked candidates from the parsed command tree
      // (`/cmd ` → its subCommands, `/dir ad` → `add`), recency-weighted.
      slashSearchSeqRef.current++;
      setRawSuggestions(
        subcommandSuggestions(parsed, recentSlashCommandsRef.current),
      );
      setActiveIndex(0);
      setLoadingSuggestions(false);
    }
  }, [
    config,
    currentCompletionTarget,
    setActiveCategory,
    setActiveIndex,
    searchActiveRef,
  ]);

  useEffect(() => {
    const el = editorRef.current;
    if (!el || textVersion === 0) return;
    if (bufferRef.current.text.length === 0) {
      unknownHistoryInputRef.current = false;
      restoredQueueDraftRef.current = null;
      pendingPastesRef.current.clear();
      activePlaceholderIdsRef.current.clear();
    }
    // Any real edit that moves away from a restored history entry re-enables
    // completions, mirroring the original's historyRestoredText handling.
    if (
      historyRestoredTextRef.current !== null &&
      bufferRef.current.text !== historyRestoredTextRef.current
    ) {
      historyRestoredTextRef.current = null;
    }
    refreshCompletion();
  }, [textVersion, refreshCompletion]);

  // A finished command flips the recency map; re-rank an open dropdown the
  // way useCommandSuggestions re-runs when its recentCommands dep changes.
  useEffect(() => {
    refreshCompletion();
  }, [recentSlashCommands, refreshCompletion]);

  const applyTextToEditor = useCallback(
    (line: string, cursorCol?: number) => {
      const el = editorRef.current;
      if (!el) return;
      const [row] = bufferRef.current.cursor;
      const lines = [...bufferRef.current.lines];
      lines[row] = line;
      replaceText(lines.join('\n'));
      bufferRef.current.moveToOffset(
        logicalPosToOffset(lines, row, cursorCol ?? cpLen(line)),
      );
      setTextVersion((v) => v + 1);
    },
    [replaceText],
  );

  const clearDraft = useCallback(() => {
    setSearchActive(false);
    resetSearchCompletion();
    draftRef.current.valid = false;
    draftRef.current = newDraft();
    replaceText('');
    unknownHistoryInputRef.current = false;
    restoredQueueDraftRef.current = null;
    pendingPastesRef.current.clear();
    activePlaceholderIdsRef.current.clear();
    restoredProvenanceRef.current = null;
    setSelectedAttachment(-1);
    showAttachments();
    setTextVersion((v) => v + 1);
  }, [
    showAttachments,
    setSelectedAttachment,
    setSearchActive,
    resetSearchCompletion,
    replaceText,
  ]);

  const sessionId = config?.getSessionId?.();
  const sessionRef = useRef(sessionId);
  const cancelPendingRef = useRef(false);
  useLayoutEffect(() => {
    if (sessionRef.current !== sessionId) {
      // Session rotation invalidates asynchronous owners, while the mounted
      // editor keeps its visible text and its matching paste/source snapshot.
      draftRef.current = newDraft();
      setSelectedAttachment(-1);
      showAttachments();
      cancelPendingRef.current = false;
      sessionRef.current = sessionId;
    }
    draftRef.current.valid = true;
    return () => {
      draftRef.current.valid = false;
      if (claimedDraftRef.current) claimedDraftRef.current.valid = false;
    };
  }, [sessionId, showAttachments, setSelectedAttachment]);

  const restoreSubmission = useCallback(
    (submission: OpenTuiInputSubmission, separator = '\n\n') => {
      const el = editorRef.current;
      if (!el) return;
      const current = bufferRef.current.text;
      const expandedCurrent = expandPendingPastePlaceholders(
        current,
        pendingPastesRef.current,
      );
      const restored = restoreInputSubmissions(
        [
          submission,
          ...(current
            ? [
                {
                  text:
                    shellModeRef.current ||
                    (draftRef.current.attachments.length +
                      (submission.imagePaths?.length ?? 0) ===
                      0 &&
                      isSlashCommand(current.trim()))
                      ? expandedCurrent
                      : framePasteExpansion(current, pendingPastesRef.current),
                  displayText: current,
                  submittedPrompt:
                    restoredProvenanceRef.current?.text === current
                      ? restoredProvenanceRef.current.submittedPrompt
                      : current,
                  humanInput: unknownHistoryInputRef.current
                    ? undefined
                    : { text: expandedCurrent },
                  hasUnknownInput: unknownHistoryInputRef.current,
                  pasteExpansions: new Map(pendingPastesRef.current),
                  restoredDraft: restoredQueueDraftRef.current ?? undefined,
                },
              ]
            : []),
        ],
        separator,
        pendingPastesRef.current,
      );
      const text = restored.text;
      replaceText(text);
      restoreQueuedDraft(restored.restoredDraft!);
      bufferRef.current.moveToOffset(cpLen(bufferRef.current.text));
      draftRef.current.attachments.unshift(
        ...(submission.imagePaths ?? []).map((imagePath) => ({
          id: randomUUID(),
          path: imagePath,
          filename: path.basename(imagePath),
        })),
      );
      restoredProvenanceRef.current =
        !current && submission.submittedPrompt !== undefined
          ? { text, submittedPrompt: submission.submittedPrompt }
          : null;
      showAttachments();
      setTextVersion((v) => v + 1);
    },
    [showAttachments, restoreQueuedDraft, replaceText],
  );

  const cancelTurn = useCallback(() => {
    if (!onInterrupt || cancelPendingRef.current) return;
    const draft = draftRef.current;
    const empty =
      !bufferRef.current.text &&
      !draft.attachments.length &&
      !draft.pending &&
      !claimedDraftRef.current;
    const session = sessionRef.current;
    cancelPendingRef.current = true;
    onInterrupt((settlement) => {
      if (session !== sessionRef.current || !draftRef.current.valid)
        return undefined;
      cancelPendingRef.current = false;
      if (settlement.kind === 'reset') return undefined;
      const { queued, prompt } = settlement;
      const popped = onPopQueue?.();
      const pending = [queued, popped].filter((entry) => entry != null);
      if (pending.length) {
        restoreSubmission(restoreInputSubmissions(pending), '\n');
      } else if (
        empty &&
        prompt &&
        draft === draftRef.current &&
        draft.valid &&
        !bufferRef.current.text &&
        !draft.attachments.length &&
        !draft.pending &&
        !claimedDraftRef.current
      ) {
        restoreSubmission(prompt);
        return true;
      }
      return undefined;
    });
  }, [onInterrupt, onPopQueue, restoreSubmission]);

  const submitDraft = useCallback(
    async (
      raw: string,
      deferUntilIdle = false,
      pastes = pendingPastesRef.current,
    ) => {
      const el = editorRef.current;
      if (!el || !raw.trim() || claimedDraftRef.current) return;
      const draft = draftRef.current;
      claimedDraftRef.current = draft;
      const submittedPrompt =
        restoredProvenanceRef.current?.text === raw
          ? restoredProvenanceRef.current.submittedPrompt
          : raw;
      const hasUnknownInput = unknownHistoryInputRef.current;
      const restoredDraft = restoredQueueDraftRef.current ?? undefined;
      draftRef.current = newDraft();
      replaceText('');
      unknownHistoryInputRef.current = false;
      restoredQueueDraftRef.current = null;
      pendingPastesRef.current = new Map();
      activePlaceholderIdsRef.current = new Map();
      restoredProvenanceRef.current = null;
      setSelectedAttachment(-1);
      showAttachments();
      historyRef.current?.reset();
      setSearchActive(false);
      resetSearchCompletion();
      historyRestoredTextRef.current = null;
      setRawSuggestions([]);
      setLoadingSuggestions(false);
      setTextVersion((v) => v + 1);
      dismissFollowup();
      onPromptSuggestionDismiss?.();
      let submission: OpenTuiInputSubmission | undefined;
      try {
        if (draft.pending) await draft.pending;
        if (!draft.valid) return;
        const displayText = [raw.trim(), ...draft.fallback]
          .filter(Boolean)
          .join('\n\n');
        const pasteExpansions = new Map(pastes);
        const humanText = expandPendingPastePlaceholders(displayText, pastes);
        const modelText =
          shellModeActive ||
          (draft.attachments.length === 0 && isSlashCommand(displayText.trim()))
            ? humanText
            : framePasteExpansion(displayText, pastes);
        submission = {
          text: modelText,
          imagePaths: draft.attachments.map((attachment) => attachment.path),
          submittedPrompt: [submittedPrompt, ...draft.fallback]
            .filter(Boolean)
            .join('\n\n'),
          deferUntilIdle,
          displayText,
          humanInput: hasUnknownInput
            ? undefined
            : {
                text: humanText,
              },
          hasUnknownInput,
          ...(pasteExpansions.size ? { pasteExpansions } : {}),
          ...(restoredDraft ? { restoredDraft } : {}),
        };
        if (shellModeActive && submission.imagePaths?.length === 0) {
          addCommandToHistory(submission.text);
        }
        const accepted = await onSubmit(
          submission.text,
          submission.imagePaths?.length ? submission.imagePaths : undefined,
          {
            submittedPrompt: submission.submittedPrompt,
            deferUntilIdle,
            displayText: submission.displayText,
            humanInput: submission.humanInput,
            hasUnknownInput: submission.hasUnknownInput,
            pasteExpansions: submission.pasteExpansions,
            restoredDraft: submission.restoredDraft,
          },
        );
        if (!accepted && draft.valid) restoreSubmission(submission);
      } catch (error) {
        if (draft.valid) {
          if (submission) restoreSubmission(submission);
          onNotice?.(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (claimedDraftRef.current === draft) claimedDraftRef.current = null;
      }
    },
    [
      onSubmit,
      onNotice,
      restoreSubmission,
      showAttachments,
      setSelectedAttachment,
      dismissFollowup,
      onPromptSuggestionDismiss,
      shellModeActive,
      addCommandToHistory,
      setSearchActive,
      resetSearchCompletion,
      replaceText,
    ],
  );

  useEffect(() => {
    if (!props.composerHandle) return;
    props.composerHandle.current = {
      getText: () => bufferRef.current.text,
      setText: (text) => {
        replaceText(text);
      },
      cancelTurn,
      submitDraft,
      invalidateImportedInput,
    };
    return () => {
      if (props.composerHandle) props.composerHandle.current = null;
    };
  }, [
    props.composerHandle,
    cancelTurn,
    submitDraft,
    invalidateImportedInput,
    replaceText,
  ]);

  const acceptSuggestion = useCallback(
    (index: number, viaEnter: boolean): void => {
      const el = editorRef.current;
      const suggestion = suggestions[index];
      if (!el || !suggestion) return;
      const target = currentCompletionTarget();
      if (!target) return;
      const [cursorRow] = bufferRef.current.cursor;
      const lines = bufferRef.current.lines;
      suggestionNavigatedRef.current = false;
      const applied = applyCompletion(
        lines[cursorRow] ?? '',
        target,
        suggestion,
        viaEnter,
        target.mode === CompletionMode.SLASH
          ? (slashRangeRef.current ?? undefined)
          : undefined,
      );
      if (applied.submitNow) {
        void submitDraft(applied.submitNow);
        return;
      }
      // Directory accepts keep the dropdown closed until the query changes
      // (dismissCompletion), like the original.
      const apply = () => {
        applyTextToEditor(applied.line, applied.cursorCol);
        if (suggestion.isDirectory && target.mode === CompletionMode.AT) {
          dismissedUntilChangeRef.current = bufferRef.current.text;
        }
      };
      apply();
    },
    [suggestions, applyTextToEditor, submitDraft, currentCompletionTarget],
  );

  const collapsePastedText = useCallback(
    (
      text: string,
      pastes: Map<string, string>,
      ids: Map<number, Set<number>>,
    ): string => {
      const normalized = normalizePastedText(text);
      if (!isLargePaste(normalized)) return normalized;
      const placeholder = nextLargePastePlaceholder(cpLen(normalized), ids);
      pastes.set(placeholder, normalized);
      return placeholder;
    },
    [],
  );

  const queuePaste = useCallback(
    (
      operation: (
        notify: (text: string) => void,
        isCurrent: () => boolean,
      ) => Promise<{ paths: string[]; fallback?: string }>,
    ) => {
      const draft = draftRef.current;
      const pastes = pendingPastesRef.current;
      const ids = activePlaceholderIdsRef.current;
      const notify = (text: string) => {
        if (draft.valid) onNotice?.(text);
      };
      const result = operation(notify, () => draft.valid).catch(
        (error: unknown) => {
          if (draft.valid)
            onNotice?.(error instanceof Error ? error.message : String(error));
          return { paths: [] };
        },
      );
      const pending = (draft.pending ?? Promise.resolve()).then(async () => {
        const pasted = await result;
        if (!draft.valid) return;
        draft.attachments.push(
          ...pasted.paths.map((imagePath) => ({
            id: randomUUID(),
            path: imagePath,
            filename: path.basename(imagePath),
          })),
        );
        if ('fallback' in pasted && pasted.fallback) {
          const text = collapsePastedText(pasted.fallback, pastes, ids);
          if (draftRef.current === draft) {
            insertText(text);
            setTextVersion((v) => v + 1);
          } else draft.fallback.push(text);
        }
        if (draftRef.current === draft) showAttachments();
      });
      draft.pending = pending;
      void pending.finally(() => {
        if (draft.pending === pending) draft.pending = null;
      });
    },
    [onNotice, showAttachments, insertText, collapsePastedText],
  );

  const handleClipboardImage = useCallback(() => {
    queuePaste(async (notify, isCurrent) => {
      const reportUnavailable = () => {
        if (clipboardUnavailableShownRef.current) return;
        clipboardUnavailableShownRef.current = true;
        notify(
          t(
            process.platform === 'linux'
              ? 'Clipboard image paste is unavailable: no supported clipboard tool was reached. On Linux, install `wl-clipboard` (Wayland) or `xclip` (X11), or set DISPLAY/WAYLAND_DISPLAY if running headless.'
              : 'Clipboard image paste is unavailable because the native clipboard module could not be loaded. Reinstall Qwen Code or use the npm installation method.',
          ),
        );
      };
      const hasImage = await clipboardHasImage(reportUnavailable);
      if (!isCurrent()) return { paths: [] };
      if (hasImage) {
        const imagePath = await saveClipboardImage(Storage.getGlobalTempDir());
        if (imagePath) {
          cleanupOldClipboardImages(Storage.getGlobalTempDir()).catch(() => {});
          return { paths: [imagePath] };
        }
        notify('Could not save clipboard image. Paste the image again.');
      }
      if (!isCurrent()) return { paths: [] };
      const text = await readClipboardText();
      return { paths: [], ...(text ? { fallback: text } : {}) };
    });
  }, [queuePaste]);

  const promoteImagePaths = useCallback(
    (paths: string[], original: string) => {
      queuePaste(async (notify) => {
        const copied: string[] = [];
        try {
          const directory = path.join(Storage.getGlobalTempDir(), 'clipboard');
          await mkdir(directory, { recursive: true });
          for (const imagePath of paths) {
            const source = path.resolve(
              config?.getTargetDir() ?? process.cwd(),
              imagePath,
            );
            if (!(await stat(source)).isFile())
              throw new Error(`Not an image file: ${imagePath}`);
            const destination = path.join(
              directory,
              `clipboard-${randomUUID()}${path.extname(source)}`,
            );
            await copyFile(source, destination);
            copied.push(destination);
          }
          cleanupOldClipboardImages(Storage.getGlobalTempDir()).catch(() => {});
          return { paths: copied };
        } catch (error) {
          await Promise.all(copied.map((file) => unlink(file).catch(() => {})));
          notify(
            `Could not attach images; original paths kept: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { paths: [], fallback: original };
        }
      });
    },
    [config, queuePaste],
  );

  const deleteSelectedAttachment = useCallback(() => {
    const selected = selectedAttachmentRef.current;
    if (selected < 0) return false;
    draftRef.current.attachments.splice(selected, 1);
    setSelectedAttachment(
      Math.min(selected, draftRef.current.attachments.length - 1),
    );
    showAttachments();
    return true;
  }, [selectedAttachmentRef, setSelectedAttachment, showAttachments]);

  // ── raw Backspace: consumed before parsed-key dispatch so legacy DEL/BS
  //    and unmodified kitty encodings delete exactly once via the editor API
  //    and never double-fire through the focused editor. Also owns the raw
  //    DELETE_WORD_BACKWARD byte (\x1f, MinTTY/legacy Ctrl+Backspace) and
  //    placeholder-aware backspace for collapsed large pastes ──────────────
  useLayoutEffect(() => {
    const onRawInput = (sequence: string): boolean => {
      if (!focus || vimModeEnabled) return false;
      if (isDeleteWordBackwardSequence(sequence)) {
        const el = editorRef.current;
        if (!el) return false;
        if (!replaceNativeSelection(el, bufferRef.current, ''))
          bufferRef.current.deleteWordLeft();
        setTextVersion((v) => v + 1);
        return true;
      }
      if (!isUnmodifiedBackspaceSequence(sequence)) return false;
      if (deleteSelectedAttachment()) return true;
      const el = editorRef.current;
      if (!el) return false;
      backspace();
      setTextVersion((v) => v + 1);
      return true;
    };
    renderer.addInputHandler(onRawInput);
    return () => renderer.removeInputHandler(onRawInput);
  }, [renderer, focus, deleteSelectedAttachment, vimModeEnabled, backspace]);

  // ── large-paste collapsing: bracketed pastes over the thresholds fold
  //    into a `[Pasted Content N chars]` placeholder (ink useBracketedPaste
  //    parity). Global keyInput paste listeners run BEFORE the focused
  //    editor's handler; preventDefault stops the raw insertion ───────────
  const onShellPaste = props.onShellPaste;
  useLayoutEffect(() => {
    const onPaste = (event: PasteEvent): void => {
      if (onShellPaste?.(decodePasteBytes(event.bytes))) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!focus) return;
      const el = editorRef.current;
      if (!el) return;
      const pasted = normalizePastedText(decodePasteBytes(event.bytes));
      // Ink dismisses the follow-up ghost on paste too (key.paste, no
      // keystroke record): a paste into an empty buffer must not leave the
      // suggestion acceptable behind the inserted content.
      if (bufferRef.current.text.length === 0 && availableSuggestion) {
        dismissFollowup();
        onPromptSuggestionDismiss?.();
      }
      const classification = classifyPastedImagePaths(pasted);
      if (!shellModeActive && classification.allImages) {
        event.preventDefault();
        promoteImagePaths(classification.imagePaths, pasted);
        return;
      }
      event.preventDefault();
      insertText(
        collapsePastedText(
          pasted,
          pendingPastesRef.current,
          activePlaceholderIdsRef.current,
        ),
      );
      setTextVersion((v) => v + 1);
    };
    renderer.keyInput.on('paste', onPaste);
    return () => {
      renderer.keyInput.off('paste', onPaste);
    };
  }, [
    renderer,
    focus,
    // availableSuggestion/dismissFollowup/onPromptSuggestionDismiss are read
    // in the handler: resubscribe when they change or the closure goes stale.
    availableSuggestion,
    dismissFollowup,
    onPromptSuggestionDismiss,
    promoteImagePaths,
    insertText,
    collapsePastedText,
    shellModeActive,
    onShellPaste,
  ]);

  const editorRequestRef = useRef<Draft | null>(null);
  const openExternalEditor = useCallback(async () => {
    if (editorRequestRef.current) return;
    const draft = draftRef.current;
    editorRequestRef.current = draft;
    let suspended = false;
    try {
      while (draft.pending) await draft.pending;
      const el = editorRef.current;
      if (
        !el ||
        !focusRef.current ||
        !draft.valid ||
        draftRef.current !== draft
      )
        return;
      const before = expandPendingPastePlaceholders(
        bufferRef.current.text,
        pendingPastesRef.current,
      );
      const preferred = props.preferredEditor;
      const after = editTextInExternalEditor(before, {
        preferredEditor:
          preferred &&
          isValidEditorType(preferred) &&
          allowEditorTypeInSandbox(preferred)
            ? preferred
            : undefined,
        beforeLaunch: () => {
          suspended = true;
          renderer.suspend();
        },
      });
      if (
        draft.valid &&
        draftRef.current === draft &&
        editorRef.current === el &&
        after !== before
      ) {
        replaceText(after);
        bufferRef.current.moveToOffset(cpLen(bufferRef.current.text));
        restoredProvenanceRef.current = null;
        historyRestoredTextRef.current = null;
        setTextVersion((v) => v + 1);
      }
    } catch (error) {
      if (draft.valid && draftRef.current === draft) {
        onNotice?.(
          `Could not open external editor: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      if (editorRequestRef.current === draft) editorRequestRef.current = null;
      if (suspended) {
        try {
          renderer.resume();
        } catch (error) {
          onNotice?.(
            `Could not resume terminal: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }, [props.preferredEditor, renderer, onNotice, replaceText]);

  const voiceInput = usePromptVoiceInput({
    ...props.voice,
    config,
    buffer,
    onSubmit: (text) => {
      invalidateImportedInput();
      void submitDraft(text);
    },
  });

  // ── keyboard: global handlers run BEFORE the focused editor, so
  //    preventDefault here keeps the editor from double-handling a key ─────
  useKeyboard((key: KeyEvent) => {
    if (!focus || key.eventType === 'release') return;
    if (props.onShellKey?.(key)) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    const el = editorRef.current;

    // Any non-Esc key disarms the double-Esc clear window.
    if (key.name !== 'escape' && escapeRef.current?.armed) {
      escapeRef.current.disarm();
      setEscapeArmed(false);
      onEscapeArmedChange?.(false);
    }

    if (!el) return;
    if (voiceInput.status !== 'idle') {
      if (voiceInput.handleKeypress(toOriginalKey(key))) {
        key.preventDefault();
      } else if (matchesCommand(Command.SUBMIT, key)) {
        key.preventDefault();
        void submitDraft(bufferRef.current.text);
      } else if (matchesCommand(Command.NEWLINE, key)) {
        key.preventDefault();
        bufferRef.current.newline();
        setTextVersion((v) => v + 1);
      } else if (handleEditorKey(el, bufferRef.current, key, true)) {
        setTextVersion((v) => v + 1);
      } else if (isPrintableKeyInput(key)) {
        insertText(key.sequence);
        setTextVersion((v) => v + 1);
        key.preventDefault();
      }
      return;
    }
    projectTextBuffer(el, bufferRef.current, renderer.widthMethod);
    // The visible category tabs own the bare arrows while they are up, exactly
    // as in ink — modifiers pinned false so Alt+arrow word movement and any
    // Ctrl+arrow terminal binding still reach the buffer.
    if (
      suggestions.length > 0 &&
      categoryTabs.length > 2 &&
      (key.name === 'left' || key.name === 'right') &&
      !key.shift &&
      !key.ctrl &&
      !key.meta
    ) {
      key.preventDefault();
      // From the raw state, not the derived tab: when a newer result set dropped
      // the active category, ink's step finds no index and lands on 'all'.
      setActiveCategory(
        nextCategory(
          categoryTabs,
          activeCategoryRef.current,
          key.name === 'right' ? 1 : -1,
        ),
      );
      setActiveIndex(0);
      return;
    }

    const beforeVim = bufferRef.current.text;
    if (props.vim?.handleInput(toOriginalKey(key))) {
      el.clearSelection();
      if (bufferRef.current.text !== beforeVim)
        restoredProvenanceRef.current = null;
      key.preventDefault();
      setTextVersion((v) => v + 1);
      return;
    }
    if (
      !shellModeActive &&
      !searchActive &&
      suggestions.length === 0 &&
      selectedAttachmentRef.current < 0 &&
      bufferRef.current.text.length === 0 &&
      voiceInput.handleKeypress(toOriginalKey(key))
    ) {
      invalidateImportedInput();
      key.preventDefault();
      return;
    }
    if (matchesCommand(Command.RETRY_LAST, key)) {
      key.preventDefault();
      props.onRetry?.();
      return;
    }
    if (key.name === 'r' && key.ctrl) {
      key.preventDefault();
      if (!searchActiveRef.current || shellModeActive) {
        searchSnapshot.current = {
          text: bufferRef.current.text,
          offset: logicalPosToOffset(
            bufferRef.current.lines,
            ...bufferRef.current.cursor,
          ),
          provenance: restoredProvenanceRef.current,
          restoredDraft: restoredQueueDraftRef.current,
          unknownInput: unknownHistoryInputRef.current,
          historyText: historyRestoredTextRef.current,
          pasteExpansions: new Map(pendingPastesRef.current),
          placeholderIds: new Map(
            [...activePlaceholderIdsRef.current].map(([count, ids]) => [
              count,
              new Set(ids),
            ]),
          ),
        };
      }
      if (!searchActiveRef.current) {
        setSearchActive(true);
        setSelectedAttachment(-1);
        setExpandedSearchIndex(-1);
        completionModeRef.current = CompletionMode.IDLE;
        slashSearchSeqRef.current++;
        setAtQuery(null);
        setRawSuggestions([]);
        setLoadingSuggestions(false);
      }
      return;
    }
    if (searchActiveRef.current) {
      const item = search.suggestions[search.activeSuggestionIndex];
      if (key.name === 'escape') {
        key.preventDefault();
        setSearchActive(false);
        search.resetCompletionState();
        const snapshot = searchSnapshot.current;
        replaceText(snapshot.text);
        bufferRef.current.moveToOffset(snapshot.offset);
        restoredProvenanceRef.current = snapshot.provenance;
        restoredQueueDraftRef.current = snapshot.restoredDraft;
        unknownHistoryInputRef.current = snapshot.unknownInput;
        historyRestoredTextRef.current = snapshot.historyText;
        restorePasteMap(snapshot.pasteExpansions);
        activePlaceholderIdsRef.current.clear();
        for (const [count, ids] of snapshot.placeholderIds) {
          activePlaceholderIdsRef.current.set(count, new Set(ids));
        }
        dismissedUntilChangeRef.current = bufferRef.current.text;
        setTextVersion((v) => v + 1);
        return;
      }
      if (
        matchesCommand(Command.NAVIGATION_UP, key) ||
        matchesCommand(Command.NAVIGATION_DOWN, key)
      ) {
        key.preventDefault();
        if (matchesCommand(Command.NAVIGATION_UP, key)) search.navigateUp();
        else search.navigateDown();
        setExpandedSearchIndex(-1);
        return;
      }
      if (
        (matchesCommand(Command.COLLAPSE_SUGGESTION, key) ||
          matchesCommand(Command.EXPAND_SUGGESTION, key)) &&
        item &&
        item.value.length >= MAX_SUGGESTION_LABEL_WIDTH
      ) {
        key.preventDefault();
        setExpandedSearchIndex(
          matchesCommand(Command.EXPAND_SUGGESTION, key)
            ? search.activeSuggestionIndex
            : -1,
        );
        return;
      }
      const enter = matchesCommand(Command.SUBMIT_REVERSE_SEARCH, key);
      if (
        (matchesCommand(Command.ACCEPT_SUGGESTION_REVERSE_SEARCH, key) &&
          item) ||
        enter
      ) {
        key.preventDefault();
        const selected = item?.value ?? bufferRef.current.text;
        const value = shellModeActive
          ? selected
          : unframeClipboardPastes(selected);
        if (item) invalidateImportedInput();
        setSearchActive(false);
        search.resetCompletionState();
        if (enter) void submitDraft(value, false, item ? new Map() : undefined);
        else {
          replaceText(value);
          if (item) {
            pendingPastesRef.current.clear();
            activePlaceholderIdsRef.current.clear();
          }
          bufferRef.current.moveToOffset(cpLen(bufferRef.current.text));
          historyRestoredTextRef.current = value;
          setTextVersion((v) => v + 1);
        }
        return;
      }
      if (
        matchesCommand(Command.HISTORY_UP, key) ||
        matchesCommand(Command.HISTORY_DOWN, key)
      ) {
        key.preventDefault();
        return;
      }
    }
    if (key.ctrl && key.name === 'x') {
      setSelectedAttachment(-1);
      key.preventDefault();
      void openExternalEditor();
      return;
    }
    const selected = selectedAttachmentRef.current;
    if (selected >= 0) {
      let handled = true;
      if (key.name === 'left' || key.name === 'right') {
        setSelectedAttachment(
          Math.max(
            0,
            Math.min(
              draftRef.current.attachments.length - 1,
              selected + (key.name === 'right' ? 1 : -1),
            ),
          ),
        );
      } else if (key.name === 'delete' || key.name === 'backspace') {
        deleteSelectedAttachment();
      } else if (
        key.name === 'down' ||
        key.name === 'return' ||
        key.name === 'escape'
      ) {
        setSelectedAttachment(-1);
      } else {
        setSelectedAttachment(-1);
        handled = false;
      }
      if (handled) {
        key.preventDefault();
        return;
      }
    }
    if (handleEditorKey(el, bufferRef.current, key)) {
      setTextVersion((v) => v + 1);
      return;
    }
    if (key.name === 'q' && key.ctrl) {
      key.preventDefault();
      void submitDraft(bufferRef.current.text, true);
      return;
    }

    // Force-capture Enter + printable keys at the global level so input works
    // even when the editor's native capture doesn't fire (focus quirks).
    // preventDefault keeps the focused editor from double-handling the key.
    if (
      key.name === 'enter' ||
      key.name === 'return' ||
      key.name === 'kpenter'
    ) {
      // Original NEWLINE bindings: shift/ctrl/meta/cmd+enter insert a line
      // break instead of submitting.
      if (key.shift || key.ctrl || key.meta || key.super) {
        insertText('\n');
        setTextVersion((v) => v + 1);
        key.preventDefault();
        return;
      }

      // Completion dropdown open: Enter accepts the highlighted suggestion
      // into the input instead of submitting the partial text (ink parity —
      // prevents submitting half-typed commands like `/he`). Only a perfect
      // command match submits directly; if the user navigated away from the
      // highlighted default, Enter fills the navigated suggestion instead.
      //
      // The verdict is read from the buffer, never from the published
      // completion state: that state arrives from an effect one render behind
      // the keystrokes, and a streaming turn keeps the render loop busy enough
      // for Enter to land in the gap. Read stale, the accept path splices the
      // earlier prefix's highlighted row into the live buffer — `/quit` typed
      // mid-turn came out as `/model quit` and never quit. ink resolves the
      // same race in its InputPrompt; this is the OpenTUI half.
      const showing = !searchActiveRef.current && suggestions.length > 0;
      const liveTarget = currentCompletionTarget();
      const isPerfectMatch =
        liveTarget !== null &&
        isPerfectMatchForTarget(liveTarget, commandsRef.current);
      if (showing && (!isPerfectMatch || suggestionNavigatedRef.current)) {
        key.preventDefault();
        acceptSuggestion(activeIndexRef.current, true);
        return;
      }

      // Ghost follow-up: an empty buffer with an available suggestion fills
      // the composer instead of submitting — Enter on "/clear" must fill,
      // not execute (ink SUBMIT parity).
      if (bufferRef.current.text.length === 0 && availableSuggestion) {
        key.preventDefault();
        acceptFollowup('enter', {
          fallbackText: promptSuggestion ?? undefined,
        });
        onPromptSuggestionDismiss?.();
        return;
      }

      // decideSubmit owns the whitespace guard and the `\`+Enter
      // continuation: a trailing backslash before the caret is removed and
      // becomes a newline instead of submitting (ink InputPrompt parity).
      const decision = decideSubmit(
        bufferRef.current.text,
        logicalPosToOffset(
          bufferRef.current.lines,
          ...bufferRef.current.cursor,
        ),
      );
      if (decision.kind === 'noop') {
        key.preventDefault();
        return;
      }
      if (decision.kind === 'newline-continuation') {
        backspace();
        insertText('\n');
        setTextVersion((v) => v + 1);
        key.preventDefault();
        return;
      }

      void submitDraft(decision.text);
      key.preventDefault();
      return;
    }
    if (key.name === 'v' && (key.ctrl || key.super)) {
      // PASTE_CLIPBOARD_IMAGE parity (ctrl+v / cmd+v).
      key.preventDefault();
      void handleClipboardImage();
      return;
    }
    if (
      key.name === 'backspace' &&
      (key.ctrl || key.super || key.meta || key.option)
    ) {
      // DELETE_WORD_BACKWARD parity (keyBindings.ts: ctrl/command+backspace;
      // the legacy \x1f byte is consumed on the raw-input path). Kitty
      // encodings (CSI 127;5u …) parse into this modified-backspace key.
      if (!replaceNativeSelection(el, bufferRef.current, ''))
        bufferRef.current.deleteWordLeft();
      setTextVersion((v) => v + 1);
      key.preventDefault();
      return;
    }
    // U-33: an empty-buffer `!` toggles shell mode instead of inserting
    // (ink InputPrompt parity — the character still inserts in a non-empty
    // buffer, so `echo hi!` is unaffected). The `suggestions.length === 0`
    // clause is ink's `!showCompletionSuggestions`: `!` must not flip the
    // mode while a stale completion dropdown is open and would consume the
    // next Enter/Tab.
    if (
      key.sequence === '!' &&
      bufferRef.current.text.length === 0 &&
      suggestions.length === 0 &&
      onToggleShellMode
    ) {
      onToggleShellMode();
      key.preventDefault();
      return;
    }
    const printableKey =
      key.name === 'space' && !key.sequence ? { ...key, sequence: ' ' } : key;
    if (isPrintableKeyInput(printableKey)) {
      // Typing over a ghost suggestion aborts it (kills the in-flight publish,
      // keeps the suggestion restorable) but still inserts the character —
      // ink deliberately does NOT clear the persisted suggestion here.
      if (bufferRef.current.text.length === 0 && availableSuggestion) {
        recordFollowupKeystroke();
        dismissFollowup();
        onPromptSuggestionAbort?.();
      }
      insertText(printableKey.sequence);
      setTextVersion((v) => v + 1);
      key.preventDefault();
      return;
    }

    if (key.name === 'c' && key.ctrl) {
      // Parity with CLEAR_INPUT: a non-empty buffer is cleared first; the
      // app-level quit only fires on an empty prompt.
      if (
        bufferRef.current.text.length > 0 ||
        draftRef.current.attachments.length > 0 ||
        draftRef.current.pending
      ) {
        clearDraft();
        key.preventDefault();
      }
      return;
    }

    if (key.name === 'escape') {
      key.preventDefault();
      // Ink parity (InputPrompt exits the mode with no streaming gate;
      // AppContainer's broadcast handler cancels the request on the same
      // keypress): Esc in shell mode leaves the mode first, and when a turn
      // is streaming it interrupts too — one keypress does both.
      if (shellModeActive) {
        onToggleShellMode?.();
        if (streaming) cancelTurn();
        return;
      }
      if (streaming) {
        cancelTurn();
        return;
      }
      const commandCancelled = onCancelCommand?.() ?? false;
      if (commandCancelled) return;
      if (completionModeRef.current !== CompletionMode.IDLE) {
        completionModeRef.current = CompletionMode.IDLE;
        setRawSuggestions([]);
        setLoadingSuggestions(false);
        // Invalidate in-flight searches: an async resolution landing after
        // the Esc would otherwise re-populate the dismissed dropdown and
        // turn the next Enter into an accidental suggestion insert. The mode
        // ref flipped above is what drops the `@` ones — the shared hook's
        // callbacks are gated on it — and the counter covers slash argument
        // completion, which the port still drives itself.
        slashSearchSeqRef.current++;
        return;
      }
      // Pop queued prompts back into the composer before the double-Esc
      // clear (original parity; the streaming branch above already guards
      // the respond-cancel case).
      if (queueLength > 0) {
        const popped = onPopQueue?.();
        if (popped) {
          restoreSubmission(popped, '\n');
          return;
        }
      }
      if (!bufferRef.current.text && props.onRewind) {
        rewindPress();
        return;
      }
      const effect = escapeRef.current!.handleEscape(bufferRef.current.text);
      if (effect === 'arm') {
        setEscapeArmed(true);
        onEscapeArmedChange?.(true);
      } else if (effect === 'clear') {
        clearDraft();
        setEscapeArmed(false);
        onEscapeArmedChange?.(false);
      }
      return;
    }

    const navigationUp =
      (key.name === 'up' && !key.shift && !key.ctrl) ||
      (key.name === 'p' && !!key.ctrl);
    const navigationDown =
      (key.name === 'down' && !key.shift && !key.ctrl) ||
      (key.name === 'n' && !!key.ctrl);

    // Ink parity: shell mode owns Up/Down for shell-history recall, so the
    // prompt queue and chat history must stay untouched there — popping or
    // recalling would drop prompt context into a shell command line.
    const historyNavActive = !shellModeActive;

    const showing = !searchActiveRef.current && suggestions.length > 0;

    if (showing && suggestions.length > 1 && (navigationUp || navigationDown)) {
      key.preventDefault();
      // Navigation marks the dropdown as user-driven: with a perfect command
      // match, Enter then accepts the highlighted suggestion instead of
      // submitting the typed text (ink navigatedRef parity).
      suggestionNavigatedRef.current = true;
      const prev = activeIndexRef.current;
      const last = suggestions.length - 1;
      let next: number;
      if (navigationUp) {
        next = prev <= 0 ? last : prev - 1;
      } else {
        next = prev >= last ? 0 : prev + 1;
      }
      setActiveIndex(next);
      return;
    }

    if (
      selected < 0 &&
      !shellModeActive &&
      !searchActiveRef.current &&
      key.name === 'up' &&
      !key.ctrl &&
      !key.shift &&
      el.scrollY + el.visualCursor.visualRow === 0 &&
      draftRef.current.attachments.length > 0
    ) {
      setSelectedAttachment(draftRef.current.attachments.length - 1);
      key.preventDefault();
      return;
    }

    if (showing && key.name === 'tab' && !key.shift) {
      key.preventDefault();
      acceptSuggestion(activeIndexRef.current, false);
      return;
    }

    // Ghost follow-up accepts: Tab / Right fill an empty buffer without
    // submitting (ink parity — acceptance needs an explicit action, and
    // /clear or /quit must never execute by accident).
    if (
      !showing &&
      key.name === 'tab' &&
      !key.shift &&
      bufferRef.current.text.length === 0 &&
      availableSuggestion
    ) {
      key.preventDefault();
      acceptFollowup('tab', { fallbackText: promptSuggestion ?? undefined });
      onPromptSuggestionDismiss?.();
      return;
    }

    // Windows cannot tell Shift+Tab from a bare Tab in some terminals, so there
    // a free Tab cycles the mode too (ink useAutoAcceptIndicator, #4171). Both
    // Tab consumers above return, which is why this needs no shouldBlockTab
    // guard of its own. A real Shift+Tab belongs to the shell: it has to keep
    // cycling while a dialog or a confirmation has this composer unmounted.
    if (
      process.platform === 'win32' &&
      key.name === 'tab' &&
      !key.ctrl &&
      !key.meta &&
      !key.shift
    ) {
      key.preventDefault();
      onCycleApprovalMode?.();
      return;
    }

    if (
      key.name === 'right' &&
      !key.ctrl &&
      !key.meta &&
      bufferRef.current.text.length === 0 &&
      availableSuggestion
    ) {
      key.preventDefault();
      acceptFollowup('right', { fallbackText: promptSuggestion ?? undefined });
      onPromptSuggestionDismiss?.();
      return;
    }

    if (
      shellModeActive &&
      (key.name === 'up' || key.name === 'down') &&
      !key.ctrl &&
      !key.shift
    ) {
      key.preventDefault();
      const recalled =
        key.name === 'up'
          ? shellHistory.getPreviousCommand()
          : shellHistory.getNextCommand();
      if (recalled !== null) {
        replaceText(recalled);
        bufferRef.current.moveToOffset(cpLen(bufferRef.current.text));
        invalidateImportedInput();
        historyRestoredTextRef.current = recalled;
        setTextVersion((v) => v + 1);
      }
      return;
    }

    // Enter with the dropdown open is owned by the force-captured Enter
    // branch above (accept-unless-perfect-match); there is no separate path.

    // Up at the top edge pops queued prompts into the composer (original).
    if (historyNavActive && navigationUp && queueLength > 0) {
      const [row, col] = bufferRef.current.cursor;
      if (row === 0 && col === 0) {
        const popped = onPopQueue?.();
        if (popped) {
          restoreSubmission(popped, '\n');
          key.preventDefault();
          return;
        }
      }
    }

    if (historyNavActive && (navigationUp || navigationDown)) {
      key.preventDefault();
      const row = el.scrollY + el.visualCursor.visualRow;
      const lastRow = Math.max(0, el.editorView.getTotalVirtualLineCount() - 1);
      if (navigationUp && row > 0) {
        bufferRef.current.move('up');
        return;
      }
      if (navigationDown && row < lastRow) {
        bufferRef.current.move('down');
        return;
      }
      if (
        navigationUp &&
        logicalPosToOffset(
          bufferRef.current.lines,
          ...bufferRef.current.cursor,
        ) > 0
      ) {
        bufferRef.current.moveToOffset(0);
        return;
      }
      const end = cpLen(bufferRef.current.text);
      if (
        navigationDown &&
        logicalPosToOffset(
          bufferRef.current.lines,
          ...bufferRef.current.cursor,
        ) < end
      ) {
        bufferRef.current.moveToOffset(cpLen(bufferRef.current.text));
        return;
      }
      const historyValue = navigationUp
        ? historyRef.current!.navigateUp(bufferRef.current.text)
        : historyRef.current!.navigateDown();
      const recalled =
        historyValue === null || shellModeActive
          ? historyValue
          : unframeClipboardPastes(historyValue);
      if (recalled !== null) {
        restoredQueueDraftRef.current = null;
        unknownHistoryInputRef.current = recalled.length > 0;
        historyRestoredTextRef.current = recalled;
        restoredProvenanceRef.current = null;
        replaceText(recalled);
        if (navigationUp) bufferRef.current.moveToOffset(0);
        else bufferRef.current.moveToOffset(cpLen(bufferRef.current.text));
        setTextVersion((v) => v + 1);
      }
      return;
    }
    if (handleEditorKey(el, bufferRef.current, key, true)) {
      setTextVersion((v) => v + 1);
    } else if (
      !key.ctrl &&
      !key.meta &&
      !key.super &&
      !key.hyper &&
      (key.name === 'space' || key.sequence?.charCodeAt(0) >= 32)
    ) {
      // A payload rejected by the input classifier must not mutate the view.
      key.preventDefault();
    }
  });

  // Force the editor text color after mount (prop may not forward), max contrast.
  useEffect(() => {
    const el = editorRef.current as
      | (TextareaRenderable & { textColor?: string })
      | null;
    if (el) el.textColor = C.text;
  }, []);

  // Force Enter=submit after mount (override any default newline mapping).
  useEffect(() => {
    const el = editorRef.current as
      | (TextareaRenderable & { keyBindings?: unknown })
      | null;
    if (el) {
      el.keyBindings = [
        { name: 'return', action: 'submit' },
        { name: 'kpenter', action: 'submit' },
        { name: 'return', shift: true, action: 'newline' },
        { name: 'return', ctrl: true, action: 'newline' },
        { name: 'return', meta: true, action: 'newline' },
      ];
    }
  }, []);

  const voiceStatusLabel =
    voiceInput.status === 'recording'
      ? t('Voice: recording')
      : voiceInput.status === 'transcribing'
        ? t('Voice: transcribing')
        : voiceInput.status === 'refining'
          ? t('Voice: refining')
          : undefined;
  const columns = Math.max(width, 1);
  const renderedLabel = truncateToWidth(
    sanitizeTerminalLine(voiceStatusLabel ?? topRightLabel ?? ''),
    columns - 5,
  );
  const labelWidth = renderedLabel
    ? getCachedStringWidth(renderedLabel) + 4
    : 0;
  const dashLine = '─'.repeat(columns - labelWidth);
  const topBorderLine = renderedLabel
    ? `${dashLine} ${renderedLabel} ──`
    : dashLine;
  const { visible, startIndex, hasMoreAbove, hasMoreBelow } = suggestionWindow(
    suggestions,
    activeIndex,
  );
  const showDropdown = searchActive
    ? search.showSuggestions
    : loadingSuggestions || (suggestions.length > 0 && visible.length > 0);
  useEffect(() => {
    onSuggestionsVisibilityChange?.(showDropdown);
  }, [showDropdown, onSuggestionsVisibilityChange]);

  // Slash rows share one half-width command column so their descriptions line
  // up. `@` rows share a column only when they carry a description — sessions,
  // MCP servers/resources and extensions do, plain file paths do not — so a
  // long path still takes the whole width instead of wrapping inside a column
  // sized for a shorter reference. The badge counts toward the column: ink
  // measures label + argumentHint + sourceBadge, so a `[Skill]` row fits the
  // column it was sized for. completionModeRef only ever changes inside
  // refreshCompletion, alongside the setRawSuggestions that re-renders this
  // block.
  // The column is sized from the text as it will paint: sanitized (the rows
  // below sanitize the hint and badge) and measured in display columns — a
  // raw `.length` charges ANSI escape bytes as columns and under-counts CJK,
  // so the two halves of the row would disagree.
  const fullLabelWidth = (s: Suggestion) =>
    getCachedStringWidth(
      sanitizeTerminalLine(
        [s.label ?? s.value, s.argumentHint, s.sourceBadge]
          .filter(Boolean)
          .join(' '),
      ),
    );
  const slashColumn = completionModeRef.current === CompletionMode.SLASH;
  // The half-width cap applies to ink's `contentWidth` — the row after the
  // 2-column active marker — not to the terminal width.
  const contentWidth = Math.max(columns - 2, 1);
  const describedLabelWidths = suggestions
    .filter((s) => s.description)
    .map(fullLabelWidth);
  const labelColumnWidth = slashColumn
    ? Math.min(
        Math.max(...suggestions.map(fullLabelWidth), 0),
        Math.floor(contentWidth * 0.5),
      )
    : describedLabelWidths.length > 0
      ? Math.min(
          Math.max(...describedLabelWidths),
          Math.max(contentWidth - MIN_DESCRIPTION_WIDTH - 2, 1),
        )
      : 0;
  // What a row actually has left for description text: the dropdown box sits
  // two columns in on each side, the active marker takes 2, and the description
  // pays a 2-column gutter. Over-allocating here does not clip — it wraps the
  // tail onto a second row and doubles the height.
  const descriptionWidth = Math.max(columns - 8 - labelColumnWidth, 1);

  return (
    <box flexDirection="column">
      {attachments.length > 0 && (
        <box flexDirection="column" paddingLeft={2}>
          {attachments.map((a, index) => (
            <text
              key={a.id}
              fg={index === selectedAttachment ? C.accent : C.purple}
            >{`${index === selectedAttachment ? '>' : '📎'} ${a.filename}`}</text>
          ))}
        </box>
      )}
      <OpenTuiVoiceIndicator
        status={voiceInput.status}
        interimText={voiceInput.interimText}
        audioLevel={voiceInput.audioLevel}
      />
      <text fg={borderColor}>{topBorderLine}</text>
      <box
        flexDirection="row"
        border={['bottom']}
        borderStyle="single"
        borderColor={borderColor}
        onMouse={(event) => {
          const editor = editorRef.current;
          if (!focus || !editor || event.target !== editor) return;
          if (event.type === 'scroll') {
            // Bubble follows the textarea's native viewport/caret adjustment.
            const before = scrollCursorBefore.current;
            scrollCursorBefore.current = null;
            if (before === null || before === editor.cursorOffset) return;
          } else if (!['down', 'drag', 'up'].includes(event.type)) return;
          bufferRef.current.moveToOffset(
            nativeOffsetToCodePoint(editor, editor.cursorOffset),
          );
        }}
      >
        <text fg={chrome.color ?? C.accent}>{chrome.prefix} </text>
        <textarea
          ref={(el) => {
            editorRef.current = el as TextareaRenderable | null;
          }}
          focused={focus}
          flexGrow={1}
          minHeight={1}
          maxHeight={8}
          placeholder={
            availableSuggestion ??
            (vimModeEnabled
              ? '  ' + t("Press 'i' for INSERT mode and 'Esc' for NORMAL mode.")
              : placeholder)
          }
          placeholderColor={C.dim}
          textColor={C.text}
          cursorColor={C.accent}
          // The library default asks the terminal for a blinking block. ink
          // never emits DECSCUSR, and a caret the terminal blinks away reads as
          // a missing caret, so pin the shape and keep it steady.
          cursorStyle={{ style: 'block', blinking: false }}
          selectionOccupancy="boundary"
          selectionBg={C.selectionBg}
          selectionFg={C.selectionFg}
          wrapMode="char"
          onSizeChange={() => setTextVersion((v) => v + 1)}
          onMouse={(event) => {
            if (event.type === 'scroll')
              scrollCursorBefore.current =
                editorRef.current?.cursorOffset ?? null;
          }}
          keyBindings={[
            { name: 'return', action: 'submit' },
            { name: 'return', shift: true, action: 'newline' },
            { name: 'return', ctrl: true, action: 'newline' },
            // The original NEWLINE binding includes command+return.
            { name: 'return', meta: true, action: 'newline' },
            { name: 'linefeed', action: 'newline' },
            { name: 'kpenter', action: 'submit' },
          ]}
        />
      </box>
      {showDropdown && (
        <box flexDirection="column" marginLeft={2} marginRight={2}>
          {loadingSuggestions && <text fg={C.dim}>Loading suggestions...</text>}
          {categoryTabs.length > 2 && (
            <box flexDirection="row" marginBottom={1}>
              {categoryTabs.map((cat, i) => {
                const active = cat === atCategory;
                return (
                  <box key={cat} marginLeft={i === 0 ? 0 : 1}>
                    <text
                      fg={active ? C.hover : C.dim}
                      bg={active ? C.accent : undefined}
                    >
                      {` ${categoryLabel(cat)} `}
                    </text>
                  </box>
                );
              })}
              <box marginLeft={2}>
                <text fg={C.dim}>{t('(←/→ to switch)')}</text>
              </box>
            </box>
          )}
          {hasMoreAbove && <text fg={C.text}>▲</text>}
          {visible.map((suggestion, index) => {
            const originalIndex = startIndex + index;
            const isActive = originalIndex === activeIndex;
            const color = isActive ? C.accent : C.dim;
            if (searchActive) {
              const label = suggestion.label ?? suggestion.value;
              const expanded = expandedSearchIndex === originalIndex;
              const { before, match, after } = prepareSuggestionLabel(
                label,
                suggestion.matchedIndex,
                bufferRef.current.text,
                expanded,
              );
              return (
                <box
                  key={`${suggestion.value}-${originalIndex}`}
                  flexDirection="row"
                >
                  <box width={2} flexShrink={0}>
                    <text fg={color}>{isActive ? '> ' : '  '}</text>
                  </box>
                  <box flexShrink={1}>
                    <text fg={color} wrapMode="char">
                      {sanitizeTerminalText(before)}
                      {match ? (
                        <span fg={C.hover} bg={C.text}>
                          {sanitizeTerminalText(match)}
                        </span>
                      ) : null}
                      {sanitizeTerminalText(after)}
                    </text>
                  </box>
                  {isActive && label.length >= MAX_SUGGESTION_LABEL_WIDTH && (
                    <box width={3} flexShrink={0}>
                      <text fg={C.dim}>{expanded ? ' ← ' : ' → '}</text>
                    </box>
                  )}
                </box>
              );
            }
            // The row's one-physical-row charge covers the label too: like
            // the hint and badge, its bytes come from extensions/servers.
            const label = sanitizeTerminalLine(
              suggestion.label ?? suggestion.value,
            );
            const sharedColumn = slashColumn || !!suggestion.description;
            // ink truncates the hint and the badge (`wrap="truncate-end"`) in
            // the columns the label column leaves after the label. @opentui has
            // no truncate wrap mode, so an over-long hint wrapped onto a second
            // row and doubled the row height instead.
            // ink measures these with `string-width`, which reads an ANSI
            // sequence as zero-width in a whole string, and its terminal then
            // paints the colour. This renderer has no content-level ANSI
            // handling, so the same bytes would be charged against the budget
            // as five columns and cut mid-sequence; strip them instead.
            const hintText = suggestion.argumentHint
              ? ` ${sanitizeTerminalLine(suggestion.argumentHint)}`
              : '';
            const badgeText = suggestion.sourceBadge
              ? ` ${sanitizeTerminalLine(suggestion.sourceBadge)}`
              : '';
            // A row with no shared column has no description gutter to pay, so
            // its budget drops only the dropdown margins and the active marker:
            // columns - 6.
            const columnWidth = Math.max(
              0,
              sharedColumn ? labelColumnWidth : columns - 6,
            );
            // Yoga measures each tail item against the column, so an item
            // shrinks from a basis already capped at the column width rather
            // than from its full text width, and the overflow splits between
            // the two in proportion to those bases. Fitted against ink across 23
            // hint/badge/column combinations; shrinking from the uncapped width
            // hands the hint a larger share and eats the badge.
            const hintBasis = Math.min(
              getCachedStringWidth(hintText),
              columnWidth,
            );
            const badgeBasis = Math.min(
              getCachedStringWidth(badgeText),
              columnWidth,
            );
            const shrinkTotal = hintBasis + badgeBasis;
            const overflow =
              getCachedStringWidth(label) + shrinkTotal - columnWidth;
            const share = (basis: number) =>
              basis - (overflow * basis) / shrinkTotal;
            let hint = truncateToWidth(hintText, hintBasis);
            let badge = badgeText;
            if (overflow > 0 && shrinkTotal > 0) {
              // Yoga leaves both widths fractional and ink's renderer floors the
              // badge's start column, so the hint's own ellipsis is drawn one
              // column past the text it kept and the badge paints over it: what
              // survives is ceil(width - 1) plain columns. With no badge there
              // is nothing to paint over it and the ellipsis is its last column.
              hint = badgeText
                ? clipToWidth(hintText, Math.ceil(share(hintBasis) - 1))
                : truncateToWidth(hintText, Math.floor(share(hintBasis)));
              badge = truncateToWidth(badgeText, Math.ceil(share(badgeBasis)));
            }
            return (
              <box
                key={`${suggestion.value}-${originalIndex}`}
                flexDirection="row"
              >
                <box width={2} flexShrink={0}>
                  <text fg={color}>{isActive ? '> ' : '  '}</text>
                </box>
                <box
                  flexShrink={sharedColumn ? 0 : 1}
                  // `"auto"` rather than omitting the attribute: @opentui resets
                  // a removed prop by assigning null, which its width setter
                  // type-guards away, so the slash column would stay stuck on
                  // every `@` row after one slash completion.
                  width={sharedColumn ? labelColumnWidth : 'auto'}
                >
                  {/* Separate flex children, not one text: the label keeps its
                      own char wrap, matching ink's hard wrap-ansi. Word wrap
                      strands `[` on its own row. */}
                  <box flexDirection="row">
                    <box flexShrink={0}>
                      <text
                        fg={color}
                        attributes={isActive ? 1 : 0}
                        wrapMode="char"
                      >
                        {label}
                      </text>
                    </box>
                    {hint ? <text fg={C.dim}>{hint}</text> : null}
                    {badge ? (
                      <text fg={color} attributes={isActive ? 1 : 0}>
                        {badge}
                      </text>
                    ) : null}
                  </box>
                </box>
                {suggestion.description && (
                  <box paddingLeft={2} flexGrow={1}>
                    <text fg={color}>
                      {truncateToWidth(
                        normalizeDescription(
                          sanitizeTerminalLine(suggestion.description),
                        ),
                        descriptionWidth,
                      )}
                    </text>
                  </box>
                )}
              </box>
            );
          })}
          {hasMoreBelow && <text fg={C.text}>▼</text>}
          {suggestions.length > MAX_SUGGESTIONS_TO_SHOW && (
            <text fg={C.dim}>
              ({activeIndex + 1}/{suggestions.length})
            </text>
          )}
        </box>
      )}
      {escapeArmed && <text fg={C.dim}>{ESCAPE_ARM_HINT}</text>}
      {rewindArmed && <text fg={C.dim}>{t('Press Esc again to rewind')}</text>}
    </box>
  );
}
