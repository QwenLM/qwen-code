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
 *  - slash suggestions ranked like useSlashCompletion's fuzzy path (fzf
 *    v2 over names + altNames, strength/priority/recency-weighted ordering,
 *    prefix fallback when fzf cannot run);
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
import { Fzf, type FzfResultItem } from 'fzf';
import type { Suggestion } from '../utils/suggestions.js';
import { MAX_SUGGESTIONS_TO_SHOW } from '../utils/suggestions.js';
import {
  CommandKind,
  type CommandCompletionItem,
  type SlashCommand,
} from '../commands/types.js';
import {
  findMidInputSlashCommand,
  isMidInputCompletableCommand,
  isSlashCommand,
} from '../utils/commandUtils.js';
import {
  isStackedSkillCompletableCommand,
  isValidStackedSkillPrefix,
} from '../commands/commands.js';
import { getCommandDisplayName } from '../../services/commandMetadata.js';
import { toCodePoints } from '../utils/textUtils.js';
import type { InputHistory } from './input-history.js';
import type { RecentSlashCommands } from '../hooks/useSlashCompletion.js';

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
  /** SLASH-only completion surface (ink slashCompletionContext parity): a
   * mid-input token completes against a filtered command pool, a
   * stacked-skill continuation against another; line-led commands see the
   * full registry. */
  slashContext?: 'mid-input' | 'stacked-skill';
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
 * ink isExactMidInputModelInvocableCommand port (useCommandCompletion): a
 * canonical-name exact match routes through the ghost-text fallback instead
 * of the dropdown, so an altName still surfaces via fzf there.
 */
function isExactMidInputModelInvocableCommand(
  partialCommand: string,
  slashCommands: readonly SlashCommand[],
): boolean {
  const query = partialCommand.toLowerCase();
  return slashCommands.some(
    (cmd) =>
      isMidInputCompletableCommand(cmd) && cmd.name.toLowerCase() === query,
  );
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
  slashCommands: readonly SlashCommand[] = [],
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
  // ink gating (useCommandCompletion): the token completes only as a
  // stacked-skill continuation or regular mid-input text — not as the
  // line-led command itself and not as a slash argument — and an exact
  // model-invocable name suppresses the dropdown (ghost text owns it).
  const midCmd = findMidInputSlashCommand(text, cursorOffset);
  if (midCmd) {
    const lineStartOffset = toCodePoints(
      lines.slice(0, cursorRow).join('\n'),
    ).length;
    const startOnLine =
      midCmd.startPos - (cursorRow === 0 ? 0 : lineStartOffset + 1);
    if (startOnLine >= 0) {
      const beforeToken = codePoints.slice(0, startOnLine).join('');
      const isInitialCommandOnFirstLine =
        cursorRow === 0 &&
        isSlashCommand(currentLine.trim()) &&
        beforeToken.trim().length === 0;
      const prefix = toCodePoints(text).slice(0, midCmd.startPos).join('');
      const isStackedSkill =
        !isInitialCommandOnFirstLine &&
        isValidStackedSkillPrefix(prefix, slashCommands);
      const isSlashLedInput = isSlashCommand(prefix.trimStart());
      const isRegularMidInput =
        !isInitialCommandOnFirstLine && !isSlashLedInput;
      if (
        isStackedSkill ||
        (isRegularMidInput &&
          !isExactMidInputModelInvocableCommand(
            midCmd.partialCommand,
            slashCommands,
          ))
      ) {
        return {
          mode: CompletionMode.SLASH,
          query: midCmd.token,
          start: startOnLine,
          end: startOnLine + midCmd.token.length,
          slashContext: isStackedSkill ? 'stacked-skill' : 'mid-input',
        };
      }
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
 * Command pool for a SLASH target (ink slashCommandsForCompletion parity):
 * mid-input tokens see only model-invocable non-hidden commands,
 * stacked-skill continuations only stacked-skill commands, and line-led
 * commands the full registry.
 */
export function slashCommandPool(
  target: CompletionTarget,
  slashCommands: readonly SlashCommand[],
): readonly SlashCommand[] {
  if (target.slashContext === 'stacked-skill') {
    return slashCommands.filter(isStackedSkillCompletableCommand);
  }
  if (target.slashContext === 'mid-input') {
    return slashCommands.filter(isMidInputCompletableCommand);
  }
  return slashCommands;
}

/**
 * Ranking strength mirroring useSlashCompletion's CommandMatchStrength:
 * fuzzy hits rank below segment-boundary prefixes (`mcp-servers` for `se`),
 * which rank below plain prefixes, which rank below exact matches.
 */
const enum MatchStrength {
  FUZZY = 0,
  SEGMENT_PREFIX = 1,
  PREFIX = 2,
  EXACT = 3,
}

interface RankedMatch {
  command: SlashCommand;
  strength: MatchStrength;
  completionPriority: number;
  recentScore: number;
  isAliasMatch: boolean;
  score: number;
  start: number;
  itemLength: number;
  originalIndex: number;
  matchedAlias?: string;
}

const RECENT_DECAY_MS = 10 * 60 * 1000;

function isSegmentBoundary(value: string, start: number): boolean {
  if (start <= 0) {
    return false;
  }
  return ['-', '_', '/', ' '].includes(value[start - 1] ?? '');
}

/** useSlashCompletion's getCommandMatchStrength port (fzf `start` aware). */
function getMatchStrength(
  matchedValue: string,
  query: string,
  start: number,
): MatchStrength {
  const normalizedValue = matchedValue.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  if (normalizedValue === normalizedQuery) return MatchStrength.EXACT;
  if (normalizedValue.startsWith(normalizedQuery)) return MatchStrength.PREFIX;
  if (
    start > 0 &&
    normalizedValue.slice(start).startsWith(normalizedQuery) &&
    isSegmentBoundary(normalizedValue, start)
  ) {
    return MatchStrength.SEGMENT_PREFIX;
  }
  return MatchStrength.FUZZY;
}

/** useSlashCompletion's getRecentScore port (count × 10 + fresh-use bonus). */
function getRecentScore(
  command: SlashCommand,
  recentCommands?: RecentSlashCommands,
  now = Date.now(),
): number {
  const recent = recentCommands?.get(command.name);
  if (!recent) return 0;
  const ageMs = Math.max(0, now - recent.usedAt);
  return recent.count * 10 + 10 * Math.max(0, 1 - ageMs / RECENT_DECAY_MS);
}

function getMatchedAlias(
  command: SlashCommand,
  matchedValue: string,
): string | undefined {
  return command.altNames?.find(
    (altName) => altName.toLowerCase() === matchedValue.toLowerCase(),
  );
}

/**
 * useSlashCompletion's compareRankedCommandMatches port: match strength, then
 * completionPriority, then name-over-alias, then recency, then fzf score,
 * match position, item length, and registration order.
 */
function compareRankedMatches(left: RankedMatch, right: RankedMatch): number {
  const leftIsName = left.matchedAlias === undefined ? 1 : 0;
  const rightIsName = right.matchedAlias === undefined ? 1 : 0;
  return (
    right.strength - left.strength ||
    right.completionPriority - left.completionPriority ||
    rightIsName - leftIsName ||
    right.recentScore - left.recentScore ||
    right.score - left.score ||
    left.start - right.start ||
    left.itemLength - right.itemLength ||
    left.originalIndex - right.originalIndex
  );
}

/** Case-insensitive name-or-altName exact match (useCommandParser parity). */
function matchesCommandName(cmd: SlashCommand, part: string): boolean {
  return (
    cmd.name.toLowerCase() === part.toLowerCase() ||
    cmd.altNames?.some((alt) => alt.toLowerCase() === part.toLowerCase()) ||
    false
  );
}

/** Tree-parse result for one `/…` composer query (code-point positions). */
export interface CommandParseResult {
  hasTrailingSpace: boolean;
  /** Fully resolved command path parts (e.g. ['directory', 'add']). */
  commandPathParts: string[];
  /** The token currently being typed (after the resolved path). */
  partial: string;
  /** Commands to complete at this level (root list or a subCommands list). */
  currentLevel: readonly SlashCommand[] | undefined;
  /** Deepest command matched by the resolved path (argument-completion owner). */
  leafCommand: SlashCommand | null;
  /** Set when `partial` exactly names a command that itself has subCommands. */
  exactMatchAsParent: SlashCommand | undefined;
  /** True when the leaf command's `completion()` should supply suggestions. */
  isArgumentCompletion: boolean;
  /** Argument string passed to `completion()` (the in-progress last word). */
  argumentString: string;
  /** `invocation.raw` parity for the completion context. */
  invocationRaw: string;
}

/**
 * Port of useSlashCompletion's useCommandParser: walks the command tree part
 * by part (`/cmd sub partial`), drilling into `subCommands`, so `/directory `
 * offers `add` and `/curator pin ` reaches the pin subcommand's argument
 * completion. MCP prompt commands stop the walk like the original.
 */
export function parseSlashCommandQuery(
  query: string | null,
  slashCommands: readonly SlashCommand[],
): CommandParseResult {
  if (!query) {
    return {
      hasTrailingSpace: false,
      commandPathParts: [],
      partial: '',
      currentLevel: slashCommands,
      leafCommand: null,
      exactMatchAsParent: undefined,
      isArgumentCompletion: false,
      argumentString: '',
      invocationRaw: '/',
    };
  }

  const fullPath = query.startsWith('/') ? query.substring(1) : query;
  const hasTrailingSpace = query.endsWith(' ');
  const rawParts = fullPath.split(/\s+/).filter((p) => p);
  let commandPathParts = rawParts;
  let partial = '';

  if (!hasTrailingSpace && rawParts.length > 0) {
    partial = rawParts[rawParts.length - 1] ?? '';
    commandPathParts = rawParts.slice(0, -1);
  }

  let currentLevel: readonly SlashCommand[] | undefined = slashCommands;
  let leafCommand: SlashCommand | null = null;

  for (const part of commandPathParts) {
    if (!currentLevel) {
      leafCommand = null;
      currentLevel = [];
      break;
    }
    const found = currentLevel.find((cmd) => matchesCommandName(cmd, part));
    if (found) {
      leafCommand = found;
      currentLevel = found.subCommands as readonly SlashCommand[] | undefined;
      if (found.kind === CommandKind.MCP_PROMPT) {
        break;
      }
    } else {
      leafCommand = null;
      currentLevel = [];
      break;
    }
  }

  let exactMatchAsParent: SlashCommand | undefined;
  if (!hasTrailingSpace && currentLevel) {
    exactMatchAsParent = currentLevel.find(
      (cmd) => matchesCommandName(cmd, partial) && cmd.subCommands,
    );
    if (exactMatchAsParent) {
      leafCommand = exactMatchAsParent;
      currentLevel = exactMatchAsParent.subCommands;
      partial = '';
    }
  }

  const depth = commandPathParts.length;
  const isArgumentCompletion = !!(
    leafCommand?.completion &&
    (hasTrailingSpace ||
      (rawParts.length > depth && depth > 0 && partial !== ''))
  );

  const invocationParts = [...commandPathParts];
  if (partial) invocationParts.push(partial);

  return {
    hasTrailingSpace,
    commandPathParts,
    partial,
    currentLevel,
    leafCommand,
    exactMatchAsParent,
    isArgumentCompletion,
    // useCommandParser feeds only the in-progress last word to completion().
    argumentString: partial,
    invocationRaw: `/${invocationParts.join(' ')}`,
  };
}

/**
 * Port of useSlashCompletion's useCompletionPositions: the replacement range
 * RELATIVE TO THE QUERY string (query[0] is the leading '/'), in code points.
 */
export function slashCompletionPositions(
  query: string,
  parsed: CommandParseResult,
): { start: number; end: number } {
  const queryLength = toCodePoints(query).length;
  const { hasTrailingSpace, partial, exactMatchAsParent } = parsed;

  if (hasTrailingSpace || exactMatchAsParent) {
    return { start: queryLength, end: queryLength };
  }
  if (partial) {
    if (parsed.isArgumentCompletion) {
      const commandSoFar = `/${parsed.commandPathParts.join(' ')}`;
      const argStartIndex =
        toCodePoints(commandSoFar).length +
        (parsed.commandPathParts.length > 0 ? 1 : 0);
      return { start: argStartIndex, end: queryLength };
    }
    return {
      start: queryLength - toCodePoints(partial).length,
      end: queryLength,
    };
  }
  return { start: 1, end: queryLength };
}

/**
 * Port of useSlashCompletion's usePerfectMatch: the typed query already names
 * a runnable command exactly, so Enter should submit instead of accepting a
 * suggestion.
 */
export function isPerfectSlashMatch(parsed: CommandParseResult): boolean {
  if (parsed.hasTrailingSpace) return false;
  if (parsed.leafCommand && parsed.partial === '') {
    return !!parsed.leafCommand.action;
  }
  if (parsed.currentLevel) {
    return parsed.currentLevel.some(
      (cmd) => matchesCommandName(cmd, parsed.partial) && cmd.action,
    );
  }
  return false;
}

/**
 * Suggestion builder over one command level, porting useSlashCompletion's
 * useCommandSuggestions: an empty partial lists every visible command with
 * recently-used ones first; a non-empty partial goes through the fzf fuzzy
 * matcher (names AND altNames indexed, case-insensitive, v2 algorithm) with
 * the prefix fallback when fzf cannot run. Ranking follows the original's
 * compareRankedCommandMatches (strength → completionPriority → name-over-
 * alias → recency → fzf score → position → length → registration order).
 */
export function subcommandSuggestions(
  parsed: CommandParseResult,
  recentCommands?: RecentSlashCommands,
): Suggestion[] {
  const level = parsed.currentLevel ?? [];
  const visible = level.filter((cmd) => cmd.description && !cmd.hidden);
  const partial = parsed.partial;

  if (partial === '') {
    const ranked = visible.map((cmd, originalIndex): RankedMatch => {
      const isAliasMatch = false;
      return {
        command: cmd,
        // Every candidate matches an empty query the same way; the recent-
        // first ordering below is what actually differentiates rows.
        strength: MatchStrength.PREFIX,
        completionPriority: cmd.completionPriority ?? 0,
        recentScore: getRecentScore(cmd, recentCommands),
        isAliasMatch,
        score: 0,
        start: 0,
        itemLength: cmd.name.length,
        originalIndex,
        matchedAlias: undefined,
      };
    });
    ranked.sort((left, right) => {
      // Recently used commands are the most prominent with no query typed.
      const recentDifference = right.recentScore - left.recentScore;
      if (recentDifference !== 0) {
        return recentDifference;
      }
      return compareRankedMatches(left, right);
    });
    return ranked.map((match) =>
      toCommandSuggestion(match.command, undefined, true),
    );
  }

  const ranked = fuzzyOrPrefixSuggestions(
    level,
    visible,
    partial,
    recentCommands,
  );
  return ranked.map((match) =>
    toCommandSuggestion(match.command, match.matchedAlias, false),
  );
}

interface FzfCommandCacheEntry {
  fzf: Fzf<string[]>;
  commandMap: Map<string, SlashCommand>;
}

// One Fzf instance per command-level array — keyed by the level's stable
// reference (a subCommands array or the root list), NOT the filtered copy
// the caller builds (which would defeat the WeakMap on every keystroke).
const fzfInstanceCache = new WeakMap<
  readonly SlashCommand[],
  FzfCommandCacheEntry
>();

function getFzfForCommands(
  commands: readonly SlashCommand[],
): FzfCommandCacheEntry | null {
  if (commands.length === 0) return null;
  const cached = fzfInstanceCache.get(commands);
  if (cached) return cached;

  const commandItems: string[] = [];
  const commandMap = new Map<string, SlashCommand>();
  commands.forEach((cmd) => {
    if (cmd.description && !cmd.hidden) {
      commandItems.push(cmd.name);
      commandMap.set(cmd.name, cmd);
      cmd.altNames?.forEach((alt) => {
        commandItems.push(alt);
        commandMap.set(alt, cmd);
      });
    }
  });
  if (commandItems.length === 0) return null;

  try {
    const entry: FzfCommandCacheEntry = {
      fzf: new Fzf(commandItems, {
        fuzzy: 'v2',
        casing: 'case-insensitive',
      }),
      commandMap,
    };
    fzfInstanceCache.set(commands, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * fzf-ranked matches with the prefix fallback (useCommandSuggestions's
 * performFuzzySearch + getPrefixSuggestions), keeping the best match per
 * command when both a name and an alias hit. `level` is the cache-key
 * source; `visible` its description/hidden-filtered view.
 */
function fuzzyOrPrefixSuggestions(
  level: readonly SlashCommand[],
  visible: readonly SlashCommand[],
  partial: string,
  recentCommands?: RecentSlashCommands,
): RankedMatch[] {
  const fzfInstance = getFzfForCommands(level);
  if (fzfInstance) {
    try {
      const results = fzfInstance.fzf.find(partial);
      // Registration order over the full level (the original indexes
      // commandsToSearch the same way; fzf only holds visible items).
      const commandOrder = new Map(level.map((cmd, index) => [cmd, index]));
      const best = new Map<SlashCommand, RankedMatch>();
      results.forEach((result: FzfResultItem) => {
        const cmd = fzfInstance.commandMap.get(result.item);
        const originalIndex = cmd ? commandOrder.get(cmd) : undefined;
        if (!cmd || originalIndex === undefined) return;
        const match: RankedMatch = {
          command: cmd,
          strength: getMatchStrength(result.item, partial, result.start),
          completionPriority: cmd.completionPriority ?? 0,
          recentScore: getRecentScore(cmd, recentCommands),
          isAliasMatch: result.item !== cmd.name,
          score: result.score,
          start: result.start,
          itemLength: result.item.length,
          originalIndex,
          matchedAlias: getMatchedAlias(cmd, result.item),
        };
        const existing = best.get(cmd);
        if (!existing || compareRankedMatches(match, existing) < 0) {
          best.set(cmd, match);
        }
      });
      return Array.from(best.values()).sort(compareRankedMatches);
    } catch {
      // fall through to the prefix path
    }
  }
  return prefixSuggestions(visible, partial, recentCommands);
}

/**
 * The deterministic prefix fallback (useSlashCompletion's
 * getPrefixSuggestions): exact matches score 100, plain prefixes 80.
 */
function prefixSuggestions(
  visible: readonly SlashCommand[],
  partial: string,
  recentCommands?: RecentSlashCommands,
): RankedMatch[] {
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
          completionPriority: cmd.completionPriority ?? 0,
          recentScore: getRecentScore(cmd, recentCommands),
          isAliasMatch,
          score: exact ? 100 : 80,
          start: 0,
          itemLength: matchedValue.length,
          originalIndex,
          matchedAlias: isAliasMatch ? matchedValue : undefined,
        };
      })
      .sort(compareRankedMatches)[0];
    if (best) ranked.push(best);
  });
  return ranked.sort(compareRankedMatches);
}

/**
 * One-shot synchronous slash suggestions for a query. Argument completion is
 * async (per-command `completion()` calls) and owned by the composer, so it
 * reports no suggestions here — check `parseSlashCommandQuery(...).
 * isArgumentCompletion` first.
 */
export function slashSuggestions(
  query: string,
  commands: readonly SlashCommand[],
  recentCommands?: RecentSlashCommands,
): Suggestion[] {
  const parsed = parseSlashCommandQuery(query, commands);
  if (parsed.isArgumentCompletion) return [];
  return subcommandSuggestions(parsed, recentCommands);
}

/** Maps `command.completion()` results onto suggestions (ink toSuggestion). */
export function commandCompletionItemsToSuggestions(
  items: ReadonlyArray<string | CommandCompletionItem>,
): Suggestion[] {
  return items
    .map((item): Suggestion | null => {
      if (typeof item === 'string') {
        return { label: item, value: item };
      }
      if (!item.value) {
        return null;
      }
      return {
        label: item.label ?? item.value,
        value: item.value,
        description: item.description,
        ...(item.isDirectory !== undefined && {
          isDirectory: item.isDirectory,
        }),
      };
    })
    .filter((suggestion): suggestion is Suggestion => suggestion !== null);
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
 *
 * For SLASH targets, `slashRange` carries the query-relative replacement
 * positions computed by `slashCompletionPositions` (sub-command and argument
 * completion insert AFTER the leading '/', so the value is used verbatim).
 * Without it, the whole-token range is replaced and the leading '/' is
 * re-added (top-level command and `@` behavior).
 */
export function applyCompletion(
  currentLine: string,
  target: CompletionTarget,
  suggestion: Suggestion,
  viaEnter: boolean,
  slashRange?: { start: number; end: number },
): AppliedCompletion {
  const lineCodePoints = toCodePoints(currentLine);
  let start: number;
  let end: number;

  let suggestionText = suggestion.value;
  if (target.mode === CompletionMode.SLASH && slashRange) {
    start = target.start + slashRange.start;
    end = target.start + slashRange.end;
    if (
      start === end &&
      start > 1 &&
      lineCodePoints[start - 1] !== ' ' &&
      lineCodePoints[start - 1] !== '/'
    ) {
      suggestionText = ` ${suggestionText}`;
    }
  } else {
    ({ start, end } = target);
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

// ── large-paste collapsing (ink useBracketedPaste parity) ─────────────────
//
// Pastes over the thresholds fold into a `[Pasted Content N chars]`
// placeholder in the composer; the full text is restored when the buffer is
// submitted (InputPrompt.tsx LARGE_PASTE_* thresholds + pendingPastes).

export const LARGE_PASTE_CHAR_THRESHOLD = 1000;
export const LARGE_PASTE_LINE_THRESHOLD = 10;

/** Normalizes CRLF/CR pastes onto LF exactly like the original. */
export function normalizePastedText(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Whether a normalized paste must collapse into a placeholder. */
export function isLargePaste(pasted: string): boolean {
  const charCount = [...pasted].length; // Unicode-aware, like the original
  const lineCount = pasted.split('\n').length;
  return (
    charCount > LARGE_PASTE_CHAR_THRESHOLD ||
    lineCount > LARGE_PASTE_LINE_THRESHOLD
  );
}

/** The placeholder for one collapsed paste (ink nextLargePastePlaceholder). */
export function largePastePlaceholder(charCount: number, id: number): string {
  const base = `[Pasted Content ${charCount} chars]`;
  return id === 1 ? base : `${base} #${id}`;
}

/**
 * Allocates the next free placeholder id for a char count, marking it active
 * in `activeIds` so concurrent pastes of identical size get distinct ids
 * (ids freed by `freePastePlaceholderId` are reused, like the original).
 */
export function nextLargePastePlaceholder(
  charCount: number,
  activeIds: Map<number, Set<number>>,
): string {
  const ids = activeIds.get(charCount) ?? new Set<number>();
  let id = 1;
  while (ids.has(id)) id++;
  ids.add(id);
  activeIds.set(charCount, ids);
  return largePastePlaceholder(charCount, id);
}

/** Parses a placeholder back into its char count and id. */
export function parsePastePlaceholder(
  placeholder: string,
): { charCount: number; id: number } | null {
  const match = /^\[Pasted Content (\d+) chars\](?: #(\d+))?$/.exec(
    placeholder,
  );
  if (!match) return null;
  return {
    charCount: Number(match[1]),
    id: match[2] ? Number(match[2]) : 1,
  };
}

/** Frees a placeholder id for reuse (backspace deleted the placeholder). */
export function freePastePlaceholderId(
  activeIds: Map<number, Set<number>>,
  charCount: number,
  id: number,
): void {
  activeIds.get(charCount)?.delete(id);
}

/** Restores every placeholder in `value` to its pasted content on submit. */
export function expandPendingPastePlaceholders(
  value: string,
  pendingPastes: ReadonlyMap<string, string>,
): string {
  if (pendingPastes.size === 0) {
    return value;
  }
  const placeholders = Array.from(pendingPastes.keys()).sort(
    (a, b) => b.length - a.length,
  );
  const escapedPlaceholders = placeholders.map((placeholderValue) =>
    placeholderValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const placeholderRegex = new RegExp(escapedPlaceholders.join('|'), 'g');
  return value.replace(
    placeholderRegex,
    (matchedPlaceholder) =>
      pendingPastes.get(matchedPlaceholder) ?? matchedPlaceholder,
  );
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
