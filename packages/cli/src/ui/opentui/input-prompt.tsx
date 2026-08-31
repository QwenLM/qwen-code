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
 * OpenTUI. The opentui textarea (EditBufferRenderable) provides the multiline
 * edit buffer, caret, and readline-style bindings; everything the original
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
 *    registry and `@file` suggestions from core's FileSearch, with the
 *    original accept rules (Tab/Enter, trailing space, directory drill-in);
 *  - Esc: double-Esc clears the buffer (footer-style "Press Esc again to
 *    clear." hint surfaced via onEscapeArmedChange); while streaming Esc
 *    interrupts instead;
 *  - Enter submits to the parent (real client wiring), `\`+Enter continues
 *    the line, Shift+Enter inserts a newline.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from '@opentui/react';
import {
  isDeleteWordBackwardSequence,
  isPrintableKeyInput,
  isUnmodifiedBackspaceSequence,
} from './input-prompt-key.js';
import type { KeyEvent, PasteEvent, TextareaRenderable } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import {
  FileSearchFactory,
  ApprovalMode,
  Storage,
  type Config,
  type FileSearch,
} from '@qwen-code/qwen-code-core';
import {
  clipboardHasImage,
  saveClipboardImage,
  cleanupOldClipboardImages,
} from '../utils/clipboardUtils.js';
import path from 'node:path';
import type { CommandContext, SlashCommand } from '../commands/types.js';
import type { RecentSlashCommand } from '../hooks/useSlashCompletion.js';
import type { Suggestion } from '../utils/suggestions.js';
import { cpLen, toCodePoints } from '../utils/textUtils.js';
import { C } from './theme.js';
import { InputHistory } from './input-history.js';
import { loadInteractiveCommands } from './slash-dispatch.js';
import {
  CompletionMode,
  EscapeClearModel,
  MAX_SUGGESTIONS_TO_SHOW,
  applyCompletion,
  codePointIndexToDisplayCol,
  codePointIndexToDisplayOffset,
  commandCompletionItemsToSuggestions,
  decideSubmit,
  detectCompletionTarget,
  displayColToCodePointIndex,
  displayOffsetToCodePointIndex,
  expandPendingPastePlaceholders,
  fileSearchToSuggestions,
  freePastePlaceholderId,
  historyDownDecision,
  historyUpDecision,
  isLargePaste,
  isPerfectSlashMatch,
  nextLargePastePlaceholder,
  normalizePastedText,
  parsePastePlaceholder,
  parseSlashCommandQuery,
  slashCommandPool,
  slashCompletionPositions,
  subcommandSuggestions,
  suggestionWindow,
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

/** Approval-mode chrome exactly like InputPrompt's statusColor/statusText. */
function promptChrome(approvalMode: ApprovalMode | undefined): {
  prefix: string;
  color?: string;
  statusText?: string;
} {
  switch (approvalMode) {
    case ApprovalMode.AUTO_EDIT:
      return { prefix: '>', color: C.yellow, statusText: 'Accepting edits' };
    case ApprovalMode.AUTO:
      return { prefix: '>', color: C.accent, statusText: 'Auto mode' };
    case ApprovalMode.YOLO:
      return { prefix: '*', color: C.red, statusText: 'YOLO mode' };
    case ApprovalMode.PLAN:
    case ApprovalMode.DEFAULT:
      return { prefix: '>' };
    default:
      return { prefix: '>' };
  }
}

export interface InputPromptProps {
  onSubmit: (text: string, imagePaths?: string[]) => void;
  /** Submitted prompts (chronological) feeding history navigation. */
  userMessages: readonly string[];
  config?: Config;
  /** Live agent turn in flight: Esc interrupts instead of clearing. */
  streaming?: boolean;
  /** Esc-while-streaming hook (aborts the live turn in the parent). */
  onInterrupt?: () => void;
  approvalMode?: ApprovalMode;
  placeholder?: string;
  focus?: boolean;
  /** Reports the double-Esc armed state (the footer hint). */
  onEscapeArmedChange?: (armed: boolean) => void;
  /** Lets the parent read/clear the composer buffer (Ctrl+Q queue). */
  composerHandle?: {
    current: { getText: () => string; setText: (t: string) => void } | null;
  };
  /** Queued prompts awaiting the next turn (drives Esc/↑ pop-back parity). */
  queueLength?: number;
  /** Pops all queued prompts into the composer (returns joined text). */
  onPopQueue?: () => string | null;
  /** Recently used slash commands feeding recency-weighted ranking. */
  recentSlashCommands?: ReadonlyMap<string, RecentSlashCommand>;
}

export function OpenTuiInputPrompt(props: InputPromptProps) {
  const {
    onSubmit,
    userMessages,
    config,
    streaming = false,
    onInterrupt,
    approvalMode,
    placeholder = DEFAULT_PLACEHOLDER,
    focus = true,
    onEscapeArmedChange,
    queueLength = 0,
    onPopQueue,
    recentSlashCommands,
  } = props;

  const { width } = useTerminalDimensions();
  const renderer = useRenderer();
  const editorRef = useRef<TextareaRenderable | null>(null);
  useEffect(() => {
    if (!props.composerHandle) return;
    props.composerHandle.current = {
      getText: () => editorRef.current?.plainText ?? '',
      setText: (t: string) => {
        editorRef.current?.setText(t);
      },
    };
    return () => {
      if (props.composerHandle) props.composerHandle.current = null;
    };
  }, [props.composerHandle]);
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
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [escapeArmed, setEscapeArmed] = useState(false);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; path: string; filename: string }>
  >([]);
  const completionModeRef = useRef<CompletionMode>(CompletionMode.IDLE);
  // History-restored text suppresses re-opening the dropdown, like the
  // original's isHistoryRestoredText.
  const historyRestoredTextRef = useRef<string | null>(null);
  const dismissedUntilChangeRef = useRef<string | null>(null);
  const fileSearchRef = useRef<FileSearch | null>(null);
  const fileSearchReadyRef = useRef<Promise<void> | null>(null);
  const atSearchSeqRef = useRef(0);
  const commandsRef = useRef<readonly SlashCommand[]>([]);
  // SLASH-completion state for the current buffer: the query-relative
  // replacement range and whether the input already names a runnable command
  // exactly (Enter then submits instead of accepting a suggestion).
  const slashStateRef = useRef<{
    range: { start: number; end: number };
    perfect: boolean;
  } | null>(null);
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

  const chrome = promptChrome(approvalMode);
  const borderColor = chrome.color ?? C.accent;

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

  // ── @-completion file index (core FileSearch, like useAtCompletion) ─────
  const projectRoot = config?.getTargetDir() ?? process.cwd();
  const ensureFileSearch = useCallback((): Promise<void> => {
    if (fileSearchReadyRef.current) return fileSearchReadyRef.current;
    const searcher = FileSearchFactory.create({
      projectRoot,
      ignoreDirs: [],
      useGitignore: config?.getFileFilteringOptions()?.respectGitIgnore ?? true,
      useQwenignore:
        config?.getFileFilteringOptions()?.respectQwenIgnore ?? true,
      customIgnoreFiles: config?.getFileFilteringOptions()?.customIgnoreFiles,
      cache: true,
      cacheTtl: 30,
      enableRecursiveFileSearch: config?.getEnableRecursiveFileSearch() ?? true,
      enableFuzzySearch: config?.getFileFilteringEnableFuzzySearch() !== false,
    });
    fileSearchReadyRef.current = searcher
      .initialize()
      .then(() => {
        fileSearchRef.current = searcher;
      })
      .catch(() => {
        fileSearchReadyRef.current = null;
      });
    return fileSearchReadyRef.current;
  }, [config, projectRoot]);

  useEffect(
    () => () => {
      void fileSearchRef.current?.dispose?.();
      fileSearchRef.current = null;
      fileSearchReadyRef.current = null;
    },
    [],
  );

  // ── completion recomputation on every buffer/cursor change ──────────────
  const refreshCompletion = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.plainText;
    const cursor = el.logicalCursor;
    const lines = text.split('\n');
    const target = detectCompletionTarget(
      lines,
      cursor.row,
      displayColToCodePointIndex(lines[cursor.row] ?? '', cursor.col),
      text,
      displayOffsetToCodePointIndex(text, cursor.offset),
      commandsRef.current,
    );

    const restored = historyRestoredTextRef.current;
    const suppressedByHistory = restored !== null && text === restored;
    const dismissed =
      dismissedUntilChangeRef.current !== null &&
      dismissedUntilChangeRef.current === text;

    if (!target || suppressedByHistory || dismissed) {
      completionModeRef.current = CompletionMode.IDLE;
      slashStateRef.current = null;
      suggestionNavigatedRef.current = false;
      setSuggestions([]);
      setActiveIndex(0);
      setLoadingSuggestions(false);
      return;
    }

    completionModeRef.current = target.mode;
    // Any buffer change invalidates dropdown navigation (ink resets
    // navigatedRef when the query changes).
    suggestionNavigatedRef.current = false;

    if (target.mode === CompletionMode.SLASH) {
      // Mid-input / stacked-skill tokens complete against the filtered pool
      // (ink slashCommandsForCompletion parity); line-led commands see the
      // full registry.
      const pool = slashCommandPool(target, commandsRef.current);
      const parsed = parseSlashCommandQuery(target.query, pool);
      slashStateRef.current = {
        range: slashCompletionPositions(target.query, parsed),
        perfect: isPerfectSlashMatch(parsed),
      };

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
            setSuggestions(commandCompletionItemsToSuggestions(results ?? []));
            setActiveIndex(0);
          })
          .catch(() => {
            if (slashSearchSeqRef.current === seq) setSuggestions([]);
          })
          .finally(() => {
            if (slashSearchSeqRef.current === seq) setLoadingSuggestions(false);
          });
        return;
      }

      // Sub-command level: ranked candidates from the parsed command tree
      // (`/cmd ` → its subCommands, `/dir ad` → `add`), recency-weighted.
      slashSearchSeqRef.current++;
      setSuggestions(
        subcommandSuggestions(parsed, recentSlashCommandsRef.current),
      );
      setActiveIndex(0);
      setLoadingSuggestions(false);
      return;
    }

    // AT: async file search; a sequence guard drops stale results.
    const seq = ++atSearchSeqRef.current;
    setLoadingSuggestions(true);
    void ensureFileSearch().then(async () => {
      if (atSearchSeqRef.current !== seq) return;
      const searcher = fileSearchRef.current;
      if (!searcher) {
        setLoadingSuggestions(false);
        return;
      }
      try {
        const results = await searcher.search(target.query, {
          maxResults: MAX_SUGGESTIONS_TO_SHOW * 3,
        });
        if (atSearchSeqRef.current !== seq) return;
        setSuggestions(fileSearchToSuggestions(results));
        setActiveIndex(0);
      } catch {
        if (atSearchSeqRef.current === seq) setSuggestions([]);
      } finally {
        if (atSearchSeqRef.current === seq) setLoadingSuggestions(false);
      }
    });
  }, [ensureFileSearch, config]);

  useEffect(() => {
    const el = editorRef.current;
    if (!el || textVersion === 0) return;
    // Any real edit that moves away from a restored history entry re-enables
    // completions, mirroring the original's historyRestoredText handling.
    if (
      historyRestoredTextRef.current !== null &&
      el.plainText !== historyRestoredTextRef.current
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

  const applyTextToEditor = useCallback((line: string, cursorCol?: number) => {
    const el = editorRef.current;
    if (!el) return;
    const cursor = el.logicalCursor;
    const lines = el.plainText.split('\n');
    lines[cursor.row] = line;
    el.setText(lines.join('\n'));
    if (cursorCol !== undefined) {
      el.setCursor(cursor.row, codePointIndexToDisplayCol(line, cursorCol));
    } else {
      el.setCursor(cursor.row, codePointIndexToDisplayCol(line, cpLen(line)));
    }
    setTextVersion((v) => v + 1);
  }, []);

  const acceptSuggestion = useCallback(
    (index: number, viaEnter: boolean): void => {
      const el = editorRef.current;
      const suggestion = suggestions[index];
      if (!el || !suggestion) return;
      const text = el.plainText;
      const cursor = el.logicalCursor;
      const lines = text.split('\n');
      const target = detectCompletionTarget(
        lines,
        cursor.row,
        displayColToCodePointIndex(lines[cursor.row] ?? '', cursor.col),
        text,
        displayOffsetToCodePointIndex(text, cursor.offset),
        commandsRef.current,
      );
      if (!target) return;
      suggestionNavigatedRef.current = false;
      const applied = applyCompletion(
        lines[cursor.row] ?? '',
        target,
        suggestion,
        viaEnter,
        target.mode === CompletionMode.SLASH
          ? (slashStateRef.current?.range ?? undefined)
          : undefined,
      );
      if (applied.submitNow) {
        // Same cleanup as the real submit path (handleSubmit): expand pending
        // paste placeholders, collect attachments, then clear everything —
        // an accepted completion must not leave placeholders or chips behind.
        let finalText = applied.submitNow;
        if (pendingPastesRef.current.size > 0) {
          finalText = expandPendingPastePlaceholders(
            finalText,
            pendingPastesRef.current,
          );
          pendingPastesRef.current.clear();
          activePlaceholderIdsRef.current.clear();
        }
        const images = attachments.map((a) => a.path);
        el.clear();
        setTextVersion((v) => v + 1);
        historyRef.current?.reset();
        historyRestoredTextRef.current = null;
        setSuggestions([]);
        setAttachments([]);
        onSubmit(finalText, images.length > 0 ? images : undefined);
        return;
      }
      // Directory accepts keep the dropdown closed until the query changes
      // (dismissCompletion), like the original.
      const apply = () => {
        applyTextToEditor(applied.line, applied.cursorCol);
        if (suggestion.isDirectory && target.mode === CompletionMode.AT) {
          dismissedUntilChangeRef.current =
            editorRef.current?.plainText ?? null;
        }
      };
      apply();
    },
    [suggestions, applyTextToEditor, onSubmit, attachments],
  );

  // ── Ctrl+V / Cmd+V: clipboard image → temp file → attachment chip ──────
  const handleClipboardImage = useCallback(async () => {
    try {
      if (!(await clipboardHasImage())) return;
      const imagePath = await saveClipboardImage(Storage.getGlobalTempDir());
      if (!imagePath) return;
      cleanupOldClipboardImages(Storage.getGlobalTempDir()).catch(() => {});
      setAttachments((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${prev.length}`,
          path: imagePath,
          filename: path.basename(imagePath),
        },
      ]);
    } catch {
      // Native clipboard module unavailable: leave the paste as plain text.
    }
  }, []);

  // ── raw Backspace: consumed before parsed-key dispatch so legacy DEL/BS
  //    and unmodified kitty encodings delete exactly once via the editor API
  //    and never double-fire through the focused editor. Also owns the raw
  //    DELETE_WORD_BACKWARD byte (\x1f, MinTTY/legacy Ctrl+Backspace) and
  //    placeholder-aware backspace for collapsed large pastes ──────────────
  useLayoutEffect(() => {
    const onRawInput = (sequence: string): boolean => {
      if (!focus) return false;
      if (isDeleteWordBackwardSequence(sequence)) {
        const el = editorRef.current;
        if (!el) return false;
        el.deleteWordBackward();
        setTextVersion((v) => v + 1);
        return true;
      }
      if (!isUnmodifiedBackspaceSequence(sequence)) return false;
      const el = editorRef.current;
      if (!el) return false;
      // Placeholder-aware deletion (ink parity): backspace at the end of a
      // collapsed-paste placeholder removes the whole placeholder, not one
      // character.
      if (pendingPastesRef.current.size > 0) {
        const cursor = el.logicalCursor;
        const plainText = el.plainText;
        const codePoints = toCodePoints(plainText);
        const cursorCpOffset = displayOffsetToCodePointIndex(
          plainText,
          cursor.offset,
        );
        for (const placeholder of pendingPastesRef.current.keys()) {
          const placeholderStart = cursorCpOffset - placeholder.length;
          if (
            placeholderStart >= 0 &&
            codePoints.slice(placeholderStart, cursorCpOffset).join('') ===
              placeholder
          ) {
            const nextText =
              codePoints.slice(0, placeholderStart).join('') +
              codePoints.slice(cursorCpOffset).join('');
            el.setText(nextText);
            el.cursorOffset = codePointIndexToDisplayOffset(
              nextText,
              placeholderStart,
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
            setTextVersion((v) => v + 1);
            return true;
          }
        }
      }
      el.deleteCharBackward();
      setTextVersion((v) => v + 1);
      return true;
    };
    renderer.addInputHandler(onRawInput);
    return () => renderer.removeInputHandler(onRawInput);
  }, [renderer, focus]);

  // ── large-paste collapsing: bracketed pastes over the thresholds fold
  //    into a `[Pasted Content N chars]` placeholder (ink useBracketedPaste
  //    parity). Global keyInput paste listeners run BEFORE the focused
  //    editor's handler; preventDefault stops the raw insertion ───────────
  useLayoutEffect(() => {
    const onPaste = (event: PasteEvent): void => {
      if (!focus) return;
      const el = editorRef.current;
      if (!el) return;
      const pasted = normalizePastedText(decodePasteBytes(event.bytes));
      if (!isLargePaste(pasted)) return; // small pastes insert verbatim
      event.preventDefault();
      const charCount = [...pasted].length;
      const placeholder = nextLargePastePlaceholder(
        charCount,
        activePlaceholderIdsRef.current,
      );
      pendingPastesRef.current.set(placeholder, pasted);
      el.insertText(placeholder);
      setTextVersion((v) => v + 1);
    };
    renderer.keyInput.on('paste', onPaste);
    return () => {
      renderer.keyInput.off('paste', onPaste);
    };
  }, [renderer, focus]);

  // ── keyboard: global handlers run BEFORE the focused editor, so
  //    preventDefault here keeps the editor from double-handling a key ─────
  useKeyboard((key: KeyEvent) => {
    if (!focus) return;
    const el = editorRef.current;

    // Any non-Esc key disarms the double-Esc clear window.
    if (key.name !== 'escape' && escapeRef.current?.armed) {
      escapeRef.current.disarm();
      setEscapeArmed(false);
      onEscapeArmedChange?.(false);
    }

    if (!el) return;

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
        el.newLine();
        setTextVersion((v) => v + 1);
        key.preventDefault();
        return;
      }

      // Completion dropdown open: Enter accepts the highlighted suggestion
      // into the input instead of submitting the partial text (ink parity —
      // prevents submitting half-typed commands like `/he`). Only a perfect
      // command match submits directly; if the user navigated away from the
      // highlighted default, Enter fills the navigated suggestion instead.
      const showing = suggestions.length > 0;
      const isPerfectMatch =
        completionModeRef.current === CompletionMode.SLASH &&
        (slashStateRef.current?.perfect ?? false);
      if (showing && (!isPerfectMatch || suggestionNavigatedRef.current)) {
        key.preventDefault();
        acceptSuggestion(activeIndex, true);
        return;
      }

      // decideSubmit owns the whitespace guard and the `\`+Enter
      // continuation: a trailing backslash before the caret is removed and
      // becomes a newline instead of submitting (ink InputPrompt parity).
      const decision = decideSubmit(
        el.plainText,
        displayOffsetToCodePointIndex(el.plainText, el.cursorOffset),
      );
      if (decision.kind === 'noop') {
        key.preventDefault();
        return;
      }
      if (decision.kind === 'newline-continuation') {
        el.deleteCharBackward();
        el.newLine();
        setTextVersion((v) => v + 1);
        key.preventDefault();
        return;
      }

      let finalText = decision.text.trim();
      if (pendingPastesRef.current.size > 0) {
        finalText = expandPendingPastePlaceholders(
          finalText,
          pendingPastesRef.current,
        );
        pendingPastesRef.current.clear();
        activePlaceholderIdsRef.current.clear();
      }
      const images = attachments.map((a) => a.path);
      el.clear();
      setTextVersion((v) => v + 1);
      setAttachments([]);
      historyRef.current?.reset();
      historyRestoredTextRef.current = null;
      setSuggestions([]);
      setLoadingSuggestions(false);
      onSubmit(finalText, images.length > 0 ? images : undefined);
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
      (key.ctrl || key.super || key.meta || key.option) &&
      key.eventType !== 'release'
    ) {
      // DELETE_WORD_BACKWARD parity (keyBindings.ts: ctrl/command+backspace;
      // the legacy \x1f byte is consumed on the raw-input path). Kitty
      // encodings (CSI 127;5u …) parse into this modified-backspace key.
      el.deleteWordBackward();
      setTextVersion((v) => v + 1);
      key.preventDefault();
      return;
    }
    if (isPrintableKeyInput(key)) {
      el.insertText(key.sequence);
      setTextVersion((v) => v + 1);
      key.preventDefault();
      return;
    }

    if (key.name === 'c' && key.ctrl) {
      // Parity with CLEAR_INPUT: a non-empty buffer is cleared first; the
      // app-level quit only fires on an empty prompt.
      if (el.plainText.length > 0) {
        el.clear();
        setTextVersion((v) => v + 1);
        key.preventDefault();
      }
      return;
    }

    if (key.name === 'escape') {
      key.preventDefault();
      if (streaming) {
        onInterrupt?.();
        return;
      }
      if (completionModeRef.current !== CompletionMode.IDLE) {
        completionModeRef.current = CompletionMode.IDLE;
        setSuggestions([]);
        setLoadingSuggestions(false);
        // Invalidate in-flight searches: an async resolution landing after
        // the Esc would otherwise re-populate the dismissed dropdown and
        // turn the next Enter into an accidental suggestion insert.
        atSearchSeqRef.current++;
        slashSearchSeqRef.current++;
        return;
      }
      // Pop queued prompts back into the composer before the double-Esc
      // clear (original parity; the streaming branch above already guards
      // the respond-cancel case).
      if (queueLength > 0) {
        const popped = onPopQueue?.();
        if (popped) {
          const current = el.plainText;
          el.setText(current ? `${popped}\n${current}` : popped);
          setTextVersion((v) => v + 1);
        }
        return;
      }
      const effect = escapeRef.current!.handleEscape(el.plainText);
      if (effect === 'arm') {
        setEscapeArmed(true);
        onEscapeArmedChange?.(true);
      } else if (effect === 'clear') {
        el.clear();
        setTextVersion((v) => v + 1);
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

    const showing = suggestions.length > 0;

    if (showing && (navigationUp || navigationDown)) {
      key.preventDefault();
      // Navigation marks the dropdown as user-driven: with a perfect command
      // match, Enter then accepts the highlighted suggestion instead of
      // submitting the typed text (ink navigatedRef parity).
      suggestionNavigatedRef.current = true;
      setActiveIndex((prev) => {
        if (navigationUp) {
          return prev <= 0 ? suggestions.length - 1 : prev - 1;
        }
        return prev >= suggestions.length - 1 ? 0 : prev + 1;
      });
      return;
    }

    if (showing && key.name === 'tab' && !key.shift) {
      key.preventDefault();
      acceptSuggestion(activeIndex, false);
      return;
    }

    // Enter with the dropdown open is owned by the force-captured Enter
    // branch above (accept-unless-perfect-match); there is no separate path.

    // Up at the top edge pops queued prompts into the composer (original).
    if (navigationUp && queueLength > 0) {
      const topCursor = el.logicalCursor;
      if (topCursor.row === 0 && topCursor.col === 0) {
        const popped = onPopQueue?.();
        if (popped) {
          const current = el.plainText;
          el.setText(current ? `${popped}\n${current}` : popped);
          setTextVersion((v) => v + 1);
          key.preventDefault();
          return;
        }
      }
    }

    if (navigationUp) {
      const cursor = el.logicalCursor;
      const decision = historyUpDecision(
        historyRef.current!,
        el.plainText,
        el.lineCount,
        cursor.row,
        displayColToCodePointIndex(
          el.plainText.split('\n')[cursor.row] ?? '',
          cursor.col,
        ),
      );
      if (decision.kind === 'passthrough') return; // caret moves inside text
      key.preventDefault();
      if (decision.kind === 'snap-edge') {
        el.setCursor(0, 0);
        return;
      }
      historyRestoredTextRef.current = decision.text;
      el.setText(decision.text);
      el.setCursor(0, 0);
      setTextVersion((v) => v + 1);
      return;
    }

    if (navigationDown) {
      const cursor = el.logicalCursor;
      const lastLine = el.plainText.split('\n').pop() ?? '';
      const decision = historyDownDecision(
        historyRef.current!,
        el.lineCount,
        cursor.row,
        displayColToCodePointIndex(
          el.plainText.split('\n')[cursor.row] ?? '',
          cursor.col,
        ),
        cpLen(lastLine),
      );
      if (decision.kind === 'passthrough') return;
      key.preventDefault();
      if (decision.kind === 'snap-edge') {
        el.gotoLineEnd();
        return;
      }
      historyRestoredTextRef.current = decision.text;
      el.setText(decision.text);
      setTextVersion((v) => v + 1);
      return;
    }
  });

  const handleSubmit = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.plainText;
    const decision = decideSubmit(
      text,
      displayOffsetToCodePointIndex(text, el.cursorOffset),
    );
    if (decision.kind === 'noop') return;
    if (decision.kind === 'newline-continuation') {
      el.deleteCharBackward();
      el.newLine();
      setTextVersion((v) => v + 1);
      return;
    }
    let finalText = decision.text.trim();
    if (pendingPastesRef.current.size > 0) {
      finalText = expandPendingPastePlaceholders(
        finalText,
        pendingPastesRef.current,
      );
      pendingPastesRef.current.clear();
      activePlaceholderIdsRef.current.clear();
    }
    const images = attachments.map((a) => a.path);
    el.clear();
    setTextVersion((v) => v + 1);
    historyRef.current?.reset();
    historyRestoredTextRef.current = null;
    setSuggestions([]);
    setLoadingSuggestions(false);
    setAttachments([]);
    onSubmit(finalText, images.length > 0 ? images : undefined);
  }, [onSubmit, attachments]);

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

  const columns = Math.max(width - 2, 1);
  const dashLine = '─'.repeat(columns);
  const { visible, startIndex, hasMoreAbove, hasMoreBelow } = suggestionWindow(
    suggestions,
    activeIndex,
  );
  const showDropdown =
    loadingSuggestions || (suggestions.length > 0 && visible.length > 0);

  // Slash-mode labels share one half-width command column, exactly like the
  // ink SuggestionsDisplay.
  const labelColumnWidth = Math.min(
    Math.max(
      ...suggestions.map(
        (s) =>
          (s.label ?? s.value).length +
          (s.argumentHint ? 1 + s.argumentHint.length : 0),
      ),
      0,
    ),
    Math.floor(columns * 0.5),
  );

  return (
    <box flexDirection="column" marginLeft={1} marginRight={1}>
      {attachments.length > 0 && (
        <box flexDirection="column" paddingLeft={1}>
          {attachments.map((a) => (
            <text key={a.id} fg={C.purple}>{`📎 ${a.filename}`}</text>
          ))}
        </box>
      )}
      <text fg={borderColor}>{dashLine}</text>
      <box
        flexDirection="row"
        border={['bottom']}
        borderStyle="single"
        borderColor={borderColor}
      >
        <text fg={chrome.color ?? C.purple}>{chrome.prefix} </text>
        <textarea
          ref={(el) => {
            editorRef.current = el as TextareaRenderable | null;
          }}
          focused={focus}
          flexGrow={1}
          minHeight={1}
          maxHeight={8}
          placeholder={placeholder}
          placeholderColor={C.dim}
          textColor={C.text}
          cursorColor={C.accent}
          selectionBg={C.selectionBg}
          selectionFg={C.selectionFg}
          wrapMode="char"
          onSubmit={handleSubmit}
          onContentChange={() => setTextVersion((v) => v + 1)}
          onCursorChange={() => setTextVersion((v) => v + 1)}
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
        <box flexDirection="column" marginLeft={1} marginRight={1}>
          {loadingSuggestions && <text fg={C.dim}>Loading suggestions...</text>}
          {hasMoreAbove && <text fg={C.text}>▲</text>}
          {visible.map((suggestion, index) => {
            const originalIndex = startIndex + index;
            const isActive = originalIndex === activeIndex;
            const color = isActive ? C.accent : C.dim;
            const label = suggestion.label ?? suggestion.value;
            return (
              <box
                key={`${suggestion.value}-${originalIndex}`}
                flexDirection="row"
              >
                <box width={2} flexShrink={0}>
                  <text fg={color}>{isActive ? '> ' : '  '}</text>
                </box>
                <box width={labelColumnWidth} flexShrink={0}>
                  <text fg={color} attributes={isActive ? 1 : 0}>
                    {label}
                    {suggestion.argumentHint
                      ? ` ${suggestion.argumentHint}`
                      : ''}
                  </text>
                </box>
                {suggestion.description && (
                  <box paddingLeft={2} flexGrow={1}>
                    <text fg={color}>{suggestion.description}</text>
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
    </box>
  );
}
