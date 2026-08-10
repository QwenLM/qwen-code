/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * InputPrompt behavior model for the OpenTUI composer (PR1 slice: real
 * InputPrompt port).
 *
 * Framework-neutral port of the decision logic inside the original ink
 * `InputPrompt` (packages/cli/src/ui/components/InputPrompt.tsx) and its
 * completion hooks, so the OpenTUI renderer reproduces the same behavior:
 *
 *  - completion-mode detection (AT `@path`, line-led SLASH `/cmd`, mid-input
 *    `/cmd`) — mirrors useCommandCompletion's cursor-line scan exactly,
 *    including the backslash-escaped-space boundary rule;
 *  - slash suggestions ranked like useSlashCompletion's prefix fallback
 *    (exact > prefix, name beats alias, registration order);
 *  - suggestion acceptance with the original trailing-space rule
 *    (directories keep the caret adjacent so `@dir/` can be continued);
 *  - submit decisions (trim guard, trailing-`\` becomes a newline);
 *  - the double-Esc clear state machine (arm → 500ms window → clear);
 *  - history edge decisions feeding the ported InputHistory.
 *
 * The OpenTUI component owns the edit buffer (opentui EditBufferRenderable)
 * and the keyboard; it delegates every decision here.
 */

import { escapePath } from '@qwen-code/qwen-code-core';
import type { Suggestion } from '../utils/suggestions.js';
import { MAX_SUGGESTIONS_TO_SHOW } from '../utils/suggestions.js';
import type { SlashCommand } from '../commands/types.js';
import {
  findMidInputSlashCommand,
  isSlashCommand,
} from '../utils/commandUtils.js';
import { getCommandDisplayName } from '../../services/commandMetadata.js';
import { toCodePoints } from '../utils/textUtils.js';
import type { InputHistory } from './input-history.js';

export { MAX_SUGGESTIONS_TO_SHOW };

export enum CompletionMode {
  IDLE = 'IDLE',
  AT = 'AT',
  SLASH = 'SLASH',
}

export interface CompletionTarget {
  mode: CompletionMode;
  /** The partial text being completed (path for AT, `/partial` for SLASH). */
  query: string;
  /** Code-point column on the cursor line where replacement begins. */
  start: number;
  /** Code-point column on the cursor line where replacement ends. */
  end: number;
}

/** Escape-aware space scan shared by the forward/backward AT scans. */
function isUnescapedSpace(codePoints: string[], index: number): boolean {
  if (codePoints[index] !== ' ') return false;
  let backslashCount = 0;
  for (let j = index - 1; j >= 0 && codePoints[j] === '\\'; j--) {
    backslashCount++;
  }
  return backslashCount % 2 === 0;
}

/**
 * Port of the completion-mode detection in useCommandCompletion.tsx: scan the
 * cursor line backward for an `@` reference first (so `@` after a slash
 * command still triggers file search), then the slash-command cases.
 * `cursorOffset` is the absolute code-point offset in `text` (for the
 * mid-input slash scan); `cursorCol` is the column within `lines[cursorRow]`.
 */
export function detectCompletionTarget(
  lines: readonly string[],
  cursorRow: number,
  cursorCol: number,
  text: string,
  cursorOffset: number,
): CompletionTarget | null {
  const currentLine = lines[cursorRow] || '';
  const codePoints = toCodePoints(currentLine);

  for (let i = cursorCol - 1; i >= 0; i--) {
    const char = codePoints[i];
    if (char === ' ') {
      if (isUnescapedSpace(codePoints, i)) break;
    } else if (
      char === '@' &&
      (i === 0 || /\s/.test(codePoints[i - 1] ?? ''))
    ) {
      let end = codePoints.length;
      for (let k = cursorCol; k < codePoints.length; k++) {
        if (isUnescapedSpace(codePoints, k)) {
          end = k;
          break;
        }
      }
      const pathStart = i + 1;
      return {
        mode: CompletionMode.AT,
        query: currentLine.substring(pathStart, end),
        start: pathStart,
        end,
      };
    }
  }

  // Mid-input slash token (preceded by whitespace, cursor at the token end).
  const midCmd = findMidInputSlashCommand(text, cursorOffset);
  if (midCmd) {
    const lineStartOffset = toCodePoints(
      lines.slice(0, cursorRow).join('\n'),
    ).length;
    const startOnLine =
      midCmd.startPos - (cursorRow === 0 ? 0 : lineStartOffset + 1);
    if (startOnLine >= 0) {
      return {
        mode: CompletionMode.SLASH,
        query: midCmd.token,
        start: startOnLine,
        end: startOnLine + midCmd.token.length,
      };
    }
  }

  // Line-led slash command: only on the first line, like the original
  // (isSlashCommand — '/' led, not '//' or '/*', not a bare path).
  if (cursorRow === 0 && isSlashCommand(currentLine.trim())) {
    return {
      mode: CompletionMode.SLASH,
      query: currentLine,
      start: 0,
      end: codePoints.length,
    };
  }

  return null;
}

/**
 * Ranking strength mirroring useSlashCompletion's CommandMatchStrength for
 * the prefix-matching path (the deterministic fallback the original always
 * exercises for prefix queries).
 */
const enum MatchStrength {
  PREFIX = 2,
  EXACT = 3,
}

interface RankedMatch {
  command: SlashCommand;
  strength: MatchStrength;
  isAliasMatch: boolean;
  score: number;
  itemLength: number;
  originalIndex: number;
  matchedAlias?: string;
}

function compareRankedMatches(left: RankedMatch, right: RankedMatch): number {
  const leftIsName = left.matchedAlias === undefined ? 1 : 0;
  const rightIsName = right.matchedAlias === undefined ? 1 : 0;
  return (
    right.strength - left.strength ||
    right.score - left.score ||
    rightIsName - leftIsName ||
    left.itemLength - right.itemLength ||
    left.originalIndex - right.originalIndex
  );
}

/**
 * Port of useSlashCompletion's prefix suggestion builder: matches the partial
 * against every visible command's name AND altNames, keeps the best match per
 * command, and orders exact matches first. An empty partial lists every
 * visible command (the original's "no query yet" case).
 */
export function slashSuggestions(
  query: string,
  commands: readonly SlashCommand[],
): Suggestion[] {
  // `/name args` — top-level completion stops once the command name is done
  // (argument completion needs per-command context the composer doesn't own).
  const path = query.startsWith('/') ? query.slice(1) : query;
  const partial = path.split(/\s/)[0] ?? '';
  if (path.includes(' ')) return [];

  const visible = commands.filter((cmd) => cmd.description && !cmd.hidden);

  if (partial === '') {
    return visible.map((command) =>
      toCommandSuggestion(command, undefined, true),
    );
  }

  const lowerPartial = partial.toLowerCase();
  const ranked: RankedMatch[] = [];
  visible.forEach((cmd, originalIndex) => {
    const matchedValues = [cmd.name, ...(cmd.altNames ?? [])].filter((value) =>
      value.toLowerCase().startsWith(lowerPartial),
    );
    if (matchedValues.length === 0) return;
    const best = matchedValues
      .map((matchedValue): RankedMatch => {
        const exact = matchedValue.toLowerCase() === lowerPartial;
        const isAliasMatch = matchedValue !== cmd.name;
        return {
          command: cmd,
          strength: exact ? MatchStrength.EXACT : MatchStrength.PREFIX,
          isAliasMatch,
          score: exact ? 100 : 80,
          itemLength: matchedValue.length,
          originalIndex,
          matchedAlias: isAliasMatch ? matchedValue : undefined,
        };
      })
      .sort(compareRankedMatches)[0];
    if (best) ranked.push(best);
  });

  return ranked
    .sort(compareRankedMatches)
    .map((match) =>
      toCommandSuggestion(match.command, match.matchedAlias, false),
    );
}

function toCommandSuggestion(
  command: SlashCommand,
  matchedAlias?: string,
  includeAliases = false,
): Suggestion {
  return {
    label: getCommandDisplayName(command, { matchedAlias, includeAliases }),
    value: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    matchedAlias,
    submitOnAccept: command.submitOnAccept,
  };
}

/** Result of accepting one suggestion into the cursor line. */
export interface AppliedCompletion {
  /** The new cursor-line text. */
  line: string;
  /** Code-point column the caret lands on. */
  cursorCol: number;
  /**
   * Set when the original would auto-submit on Enter-accept (leaf commands
   * with submitOnAccept): the `/name` text to submit instead of inserting.
   */
  submitNow?: string;
}

/**
 * Port of useCommandCompletion.handleAutocomplete's replacement rules for the
 * cursor line: replace [start, end) with the suggestion value, prepend a
 * space for mid-input inserts glued to prior text, and append a trailing
 * space unless one follows already — with the directory exception that keeps
 * tab-completing deeper possible.
 */
export function applyCompletion(
  currentLine: string,
  target: CompletionTarget,
  suggestion: Suggestion,
  viaEnter: boolean,
): AppliedCompletion {
  const lineCodePoints = toCodePoints(currentLine);
  const { start, end } = target;

  let suggestionText = suggestion.value;
  if (target.mode === CompletionMode.SLASH) {
    if (
      start === end &&
      start > 1 &&
      lineCodePoints[start - 1] !== ' ' &&
      lineCodePoints[start - 1] !== '/'
    ) {
      suggestionText = ` ${suggestionText}`;
    }
    suggestionText = suggestionText.startsWith('/')
      ? suggestionText
      : `/${suggestionText}`;
  }

  const charAfterCompletion = lineCodePoints[end];
  const isDirectory = suggestion.isDirectory;
  if (
    charAfterCompletion !== ' ' &&
    !(isDirectory && charAfterCompletion === undefined)
  ) {
    suggestionText += ' ';
  }

  const before = lineCodePoints.slice(0, start).join('');
  const after = lineCodePoints.slice(end).join('');
  const line = before + suggestionText + after;

  const submitNow =
    viaEnter && suggestion.submitOnAccept ? `/${suggestion.value}` : undefined;

  return {
    line,
    cursorCol: start + toCodePoints(suggestionText).length,
    submitNow,
  };
}

/**
 * Maps core FileSearch results onto @-completion suggestions, mirroring
 * useAtCompletion's mapping (directories keep their trailing '/', the value
 * is the shell-escaped path).
 */
export function fileSearchToSuggestions(paths: string[]): Suggestion[] {
  return paths.map((p) => ({
    label: p,
    value: escapePath(p),
    isDirectory: p.endsWith('/'),
    category: 'file' as const,
  }));
}

/** What the view should show in the suggestion window. */
export function suggestionWindow(
  suggestions: readonly Suggestion[],
  activeIndex: number,
): {
  visible: readonly Suggestion[];
  startIndex: number;
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
} {
  const startIndex = Math.max(
    0,
    Math.min(
      activeIndex <= 0 ? 0 : activeIndex - MAX_SUGGESTIONS_TO_SHOW + 1,
      Math.max(0, suggestions.length - MAX_SUGGESTIONS_TO_SHOW),
    ),
  );
  const visible = suggestions.slice(
    startIndex,
    startIndex + MAX_SUGGESTIONS_TO_SHOW,
  );
  return {
    visible,
    startIndex,
    hasMoreAbove: startIndex > 0,
    hasMoreBelow: startIndex + visible.length < suggestions.length,
  };
}

export type SubmitDecision =
  | { kind: 'noop' }
  | { kind: 'submit'; text: string }
  | { kind: 'newline-continuation' };

/**
 * Enter decision from the original SUBMIT handler: whitespace-only input is a
 * no-op; a `\` right before the caret becomes a newline (the backslash is
 * removed by the caller); otherwise submit the whole buffer.
 */
export function decideSubmit(
  text: string,
  cursorOffset: number,
): SubmitDecision {
  if (!text.trim()) return { kind: 'noop' };
  const codePoints = toCodePoints(text);
  if (cursorOffset > 0 && codePoints[cursorOffset - 1] === '\\') {
    return { kind: 'newline-continuation' };
  }
  return { kind: 'submit', text };
}

/** The double-Esc clear state machine (500ms arm window). */
export class EscapeClearModel {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly armWindowMs = 500) {}

  get armed(): boolean {
    return this.timer !== null;
  }

  /**
   * Returns the effect for one Esc press: 'clear' empties the buffer,
   * 'arm' awaits a second press, 'noop' ignores (empty buffer).
   */
  handleEscape(text: string): 'noop' | 'arm' | 'clear' {
    if (!this.armed) {
      if (text.length === 0) return 'noop';
      this.arm();
      return 'arm';
    }
    this.disarm();
    return 'clear';
  }

  /** Any non-Esc key resets the pending double-press, like the original. */
  disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
    }, this.armWindowMs);
    this.timer.unref?.();
  }
}

/**
 * History edge decisions for the composer: the original walks history only
 * at the buffer edges, snapping the caret to the edge column on the first
 * press (the "two-step edge transition").
 */
export type HistoryEdgeDecision =
  | { kind: 'passthrough' } // caret not at the edge → let the editor move it
  | { kind: 'snap-edge' } // at edge row but not edge column → snap only
  | { kind: 'history'; text: string }; // navigate → replace buffer text

export function historyUpDecision(
  history: InputHistory,
  currentText: string,
  lineCount: number,
  cursorLine: number,
  cursorCol: number,
): HistoryEdgeDecision {
  if (cursorLine > 0) return { kind: 'passthrough' };
  if (cursorCol > 0) return { kind: 'snap-edge' };
  const text = history.navigateUp(currentText);
  return text === null ? { kind: 'snap-edge' } : { kind: 'history', text };
}

export function historyDownDecision(
  history: InputHistory,
  lineCount: number,
  cursorLine: number,
  cursorCol: number,
  lastLineLength: number,
): HistoryEdgeDecision {
  if (cursorLine < lineCount - 1) return { kind: 'passthrough' };
  if (cursorCol < lastLineLength) return { kind: 'snap-edge' };
  const text = history.navigateDown();
  return text === null ? { kind: 'snap-edge' } : { kind: 'history', text };
}
