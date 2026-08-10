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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { KeyEvent, TextareaRenderable } from '@opentui/core';
import {
  FileSearchFactory,
  ApprovalMode,
  type Config,
  type FileSearch,
} from '@qwen-code/qwen-code-core';
import type { SlashCommand } from '../commands/types.js';
import type { Suggestion } from '../utils/suggestions.js';
import { C } from './theme.js';
import { InputHistory } from './input-history.js';
import { loadInteractiveCommands } from './slash-dispatch.js';
import {
  CompletionMode,
  EscapeClearModel,
  MAX_SUGGESTIONS_TO_SHOW,
  applyCompletion,
  decideSubmit,
  detectCompletionTarget,
  fileSearchToSuggestions,
  historyDownDecision,
  historyUpDecision,
  slashSuggestions,
  suggestionWindow,
} from './input-prompt-model.js';

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
  onSubmit: (text: string) => void;
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
  } = props;

  const { width } = useTerminalDimensions();
  const editorRef = useRef<TextareaRenderable | null>(null);
  const userMessagesRef = useRef(userMessages);
  userMessagesRef.current = userMessages;

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
  const completionModeRef = useRef<CompletionMode>(CompletionMode.IDLE);
  // History-restored text suppresses re-opening the dropdown, like the
  // original's isHistoryRestoredText.
  const historyRestoredTextRef = useRef<string | null>(null);
  const dismissedUntilChangeRef = useRef<string | null>(null);
  const fileSearchRef = useRef<FileSearch | null>(null);
  const fileSearchReadyRef = useRef<Promise<void> | null>(null);
  const atSearchSeqRef = useRef(0);
  const commandsRef = useRef<readonly SlashCommand[]>([]);

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
      cursor.col,
      text,
      cursor.offset,
    );

    const restored = historyRestoredTextRef.current;
    const suppressedByHistory = restored !== null && text === restored;
    const dismissed =
      dismissedUntilChangeRef.current !== null &&
      dismissedUntilChangeRef.current === text;

    if (!target || suppressedByHistory || dismissed) {
      completionModeRef.current = CompletionMode.IDLE;
      setSuggestions([]);
      setActiveIndex(0);
      setLoadingSuggestions(false);
      return;
    }

    completionModeRef.current = target.mode;

    if (target.mode === CompletionMode.SLASH) {
      const results = slashSuggestions(target.query, [...commandsRef.current]);
      setSuggestions(results);
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
  }, [ensureFileSearch]);

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

  const applyTextToEditor = useCallback((line: string, cursorCol?: number) => {
    const el = editorRef.current;
    if (!el) return;
    const cursor = el.logicalCursor;
    const lines = el.plainText.split('\n');
    lines[cursor.row] = line;
    el.setText(lines.join('\n'));
    if (cursorCol !== undefined) {
      el.setCursor(cursor.row, cursorCol);
    } else {
      el.setCursor(cursor.row, line.length);
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
        cursor.col,
        text,
        cursor.offset,
      );
      if (!target) return;
      const applied = applyCompletion(
        lines[cursor.row] ?? '',
        target,
        suggestion,
        viaEnter,
      );
      if (applied.submitNow) {
        el.clear();
        historyRef.current?.reset();
        historyRestoredTextRef.current = null;
        setSuggestions([]);
        onSubmit(applied.submitNow);
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
    [suggestions, applyTextToEditor, onSubmit],
  );

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
      const text = el.plainText.trim();
      if (text) {
        el.clear();
        setTextVersion((v) => v + 1);
        onSubmit(text);
        key.preventDefault();
      }
      return;
    }
    if (
      !key.ctrl &&
      !key.meta &&
      key.sequence &&
      key.sequence.length >= 1 &&
      !key.sequence.startsWith('\x1b')
    ) {
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

    if (showing && key.name === 'return' && !key.ctrl && !key.shift) {
      key.preventDefault();
      acceptSuggestion(activeIndex, true);
      return;
    }

    if (navigationUp) {
      const cursor = el.logicalCursor;
      const decision = historyUpDecision(
        historyRef.current!,
        el.plainText,
        el.lineCount,
        cursor.row,
        cursor.col,
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
        cursor.col,
        lastLine.length,
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
    const decision = decideSubmit(text, el.cursorOffset);
    if (decision.kind === 'noop') return;
    if (decision.kind === 'newline-continuation') {
      el.deleteCharBackward();
      el.newLine();
      setTextVersion((v) => v + 1);
      return;
    }
    el.clear();
    setTextVersion((v) => v + 1);
    historyRef.current?.reset();
    historyRestoredTextRef.current = null;
    setSuggestions([]);
    setLoadingSuggestions(false);
    onSubmit(decision.text.trim());
  }, [onSubmit]);

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
      <text fg={borderColor}>{dashLine}</text>
      <box border={['bottom']} borderStyle="single" borderColor={borderColor}>
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
          cursorColor={C.text}
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
              <box key={`${suggestion.value}-${originalIndex}`}>
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
