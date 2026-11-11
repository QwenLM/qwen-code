/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from '@qwen-code/core';

import { useState, useEffect, useMemo, useRef } from 'react';
import { AsyncFzf } from 'fzf';
import type { Suggestion } from '../components/SuggestionsDisplay.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from '../commands/types.js';
import { runLogger, type UiLocale } from '@qwen-code/core';
import { findCommandByPart } from '../../utils/commandMatching.js';
import { MCP_PROMPT_MARKER } from '../../utils/commands.js';
import { resolveCommandDescription } from '../i18n/index.js';
import { useCommandDescriptionKeys } from '../contexts/CommandDescriptionContext.js';

// fzf 索引项：每个搜索词都关联到原始 cmd 对象，避免字符串键冲突（CC 对齐）
type CommandSearchItem = {
  cmd: SlashCommand;
  searchText: string;
  source: 'name' | 'displayName' | 'altName';
};

// Type alias for improved type safety based on actual fzf result structure
type FzfCommandResult = {
  item: CommandSearchItem;
  start: number;
  end: number;
  score: number;
  positions?: number[]; // Optional - fzf doesn't always provide match positions depending on algorithm/options used
};

// Interface for FZF command cache entry
interface FzfCommandCacheEntry {
  fzf: AsyncFzf<CommandSearchItem[]>;
}

// Utility function to safely handle errors without information disclosure
function logErrorSafely(error: unknown, context: string): void {
  if (error instanceof Error) {
    // Log full error details securely for debugging
    runLogger.warn(`[${context}]`, error);
  } else {
    runLogger.warn(`[${context}] Non-error thrown:`, error);
  }
}

// Tier order mirrors findCommandByPart: name → displayName → altName.
function commandMatchTier(cmd: SlashCommand, lowerPartial: string): number {
  const name = cmd.name.toLowerCase();
  if (name === lowerPartial) return 0;
  const display = cmd.displayName?.toLowerCase();
  if (display === lowerPartial) return 1;
  if (cmd.altNames?.some((a) => a.toLowerCase() === lowerPartial)) return 2;
  if (name.startsWith(lowerPartial)) return 3;
  if (display?.startsWith(lowerPartial)) return 4;
  if (cmd.altNames?.some((a) => a.toLowerCase().startsWith(lowerPartial)))
    return 5;
  return 6;
}

interface CommandParserResult {
  hasTrailingSpace: boolean;
  commandPathParts: string[];
  canonicalCommandPathParts: string[];
  partial: string;
  currentLevel: readonly SlashCommand[] | undefined;
  leafCommand: SlashCommand | null;
  isArgumentCompletion: boolean;
  /**
   * A runnable command followed by nothing but a space. Tab completion always
   * leaves that trailing space, so the command is still "fully typed" and
   * Enter should run it — without this it would submit the first subcommand
   * in the dropdown instead.
   *
   * This only affects `isPerfectMatch`; the subcommand suggestions stay
   * visible, and arrowing to one still selects it. Commands with a
   * `completion` function are excluded — for them the trailing space is the
   * cue to start offering arguments, so Enter belongs to the argument list.
   */
  isCompletedRunnableCommand: boolean;
}

function useCommandParser(
  query: string | null,
  slashCommands: readonly SlashCommand[],
): CommandParserResult {
  return useMemo(() => {
    if (!query) {
      return {
        hasTrailingSpace: false,
        commandPathParts: [],
        canonicalCommandPathParts: [],
        partial: '',
        currentLevel: slashCommands,
        leafCommand: null,
        isArgumentCompletion: false,
        isCompletedRunnableCommand: false,
      };
    }

    const fullPath = query.substring(1) || '';
    const hasTrailingSpace = !!query.endsWith(' ');
    const rawParts = fullPath.split(/\s+/).filter((p) => p);
    // MCP prompt display names contain a space + "(MCP)" suffix (e.g.
    // "server:prompt (MCP)"). Re-merge the marker into the command token so
    // the display name resolves as a single part — mirrors parseSlashCommand.
    // The merged token preserves its literal text ("name (MCP)", single
    // space), so partial-based offset math below stays correct.
    if (rawParts.length >= 2 && rawParts[1] === MCP_PROMPT_MARKER) {
      rawParts.splice(0, 2, `${rawParts[0]} ${MCP_PROMPT_MARKER}`);
    }
    let commandPathParts = rawParts;
    let partial = '';

    if (!hasTrailingSpace && rawParts.length > 0) {
      partial = rawParts[rawParts.length - 1];
      commandPathParts = rawParts.slice(0, -1);
    }

    let currentLevel: readonly SlashCommand[] | undefined = slashCommands;
    let leafCommand: SlashCommand | null = null;
    const canonicalCommandPathParts: string[] = [];

    for (const part of commandPathParts) {
      if (!currentLevel) {
        leafCommand = null;
        currentLevel = [];
        break;
      }
      // Use level-wide tier matching so parser agrees with routing in
      // commands.ts: name first across all cmds, then displayName, then
      // altName. Per-command find() would let an earlier displayName match
      // beat a later name match, diverging from routing.
      const found: SlashCommand | undefined = findCommandByPart(
        currentLevel,
        part,
      )?.cmd;

      if (found) {
        canonicalCommandPathParts.push(found.name);
        leafCommand = found;
        currentLevel = found.subCommands;
        if (found.kind === CommandKind.MCP_PROMPT) {
          break;
        }
      } else {
        leafCommand = null;
        currentLevel = [];
        break;
      }
    }

    const depth = commandPathParts.length;
    const isArgumentCompletion = !!(
      leafCommand?.completion &&
      (hasTrailingSpace ||
        (rawParts.length > depth && depth > 0 && partial !== ''))
    );

    const isCompletedRunnableCommand = !!(
      hasTrailingSpace &&
      leafCommand?.action &&
      !leafCommand.completion
    );

    return {
      hasTrailingSpace,
      commandPathParts,
      canonicalCommandPathParts,
      partial,
      currentLevel,
      leafCommand,
      isArgumentCompletion,
      isCompletedRunnableCommand,
    };
  }, [query, slashCommands]);
}

interface SuggestionsResult {
  suggestions: Suggestion[];
  isLoading: boolean;
}

interface CompletionPositions {
  start: number;
  end: number;
}

interface PerfectMatchResult {
  isPerfectMatch: boolean;
}

function useCommandSuggestions(
  query: string | null,
  parserResult: CommandParserResult,
  commandContext: CommandContext,
  getFzfForCommands: (
    commands: readonly SlashCommand[],
  ) => FzfCommandCacheEntry | null,
  getPrefixSuggestions: (
    commands: readonly SlashCommand[],
    partial: string,
  ) => SlashCommand[],
  translate?: I18nService['get'],
  locale?: UiLocale,
  descriptionKeys?: Readonly<Record<string, string>>,
): SuggestionsResult {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Use a ref for commandContext so it doesn't trigger effect re-runs.
  // commandContext is only used as input to leafCommand.completion() and
  // should not be a reactive dependency — its identity can change on every
  // render due to its many useMemo dependencies, which otherwise causes an
  // infinite loop: setIsLoading → re-render → new commandContext → re-run effect.
  const commandContextRef = useRef(commandContext);
  commandContextRef.current = commandContext;

  useEffect(() => {
    const abortController = new AbortController();
    const { signal } = abortController;

    const {
      isArgumentCompletion,
      leafCommand,
      commandPathParts,
      canonicalCommandPathParts,
      partial,
      currentLevel,
    } = parserResult;

    if (isArgumentCompletion) {
      const fetchAndSetSuggestions = async () => {
        if (signal.aborted) return;

        // Safety check: ensure leafCommand and completion exist
        if (!leafCommand?.completion) {
          runLogger.warn(
            'Attempted argument completion without completion function',
          );
          return;
        }

        const showLoading = leafCommand.showCompletionLoading !== false;
        if (showLoading) {
          setIsLoading(true);
        }
        try {
          const rawParts = [...commandPathParts];
          if (partial) rawParts.push(partial);
          const depth = commandPathParts.length;
          const argString = rawParts.slice(depth).join(' ');
          const results =
            (await leafCommand.completion(
              {
                ...commandContextRef.current,
                invocation: {
                  raw: query || `/${rawParts.join(' ')}`,
                  name: leafCommand.name,
                  args: argString,
                },
              },
              argString,
            )) || [];

          if (!signal.aborted) {
            const finalSuggestions = results.map((s) =>
              typeof s === 'string' ? { label: s, value: s } : s,
            );
            setSuggestions(finalSuggestions);
            setIsLoading(false);
          }
        } catch (error) {
          if (!signal.aborted) {
            logErrorSafely(error, 'Argument completion');
            setSuggestions([]);
            setIsLoading(false);
          }
        }
      };
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      fetchAndSetSuggestions();
      return () => abortController.abort();
    }

    const commandsToSearch = currentLevel || [];
    if (commandsToSearch.length > 0) {
      const performFuzzySearch = async () => {
        if (signal.aborted) return;
        let potentialSuggestions: SlashCommand[] = [];

        if (partial === '') {
          // If no partial query, show all available commands sorted alphabetically
          potentialSuggestions = commandsToSearch
            .filter((cmd) => !cmd.hidden)
            .sort((a, b) => a.name.localeCompare(b.name));
        } else {
          // Use fuzzy search for non-empty partial queries with fallback
          const fzfInstance = getFzfForCommands(commandsToSearch);
          if (fzfInstance) {
            try {
              const fzfResults = await fzfInstance.fzf.find(partial);
              if (signal.aborted) return;
              const uniqueCommands = new Set<SlashCommand>();
              fzfResults.forEach((result: FzfCommandResult) => {
                const cmd = result.item.cmd;
                if (cmd) {
                  uniqueCommands.add(cmd);
                }
              });
              potentialSuggestions = Array.from(uniqueCommands);
            } catch (error) {
              logErrorSafely(
                error,
                'Fuzzy search - falling back to prefix matching',
              );
              // Fallback to prefix-based filtering
              potentialSuggestions = getPrefixSuggestions(
                commandsToSearch,
                partial,
              );
            }
          } else {
            // Fallback to prefix-based filtering when fzf instance creation fails
            potentialSuggestions = getPrefixSuggestions(
              commandsToSearch,
              partial,
            );
          }
        }

        if (!signal.aborted) {
          // When partial is non-empty, re-sort so exact/prefix matches come first.
          // When partial is empty (showing all commands), keep the alphabetical order.
          const sortedSuggestions =
            partial === ''
              ? potentialSuggestions
              : (() => {
                  const lp = partial.toLowerCase();
                  const decorated = potentialSuggestions.map((cmd) => ({
                    cmd,
                    tier: commandMatchTier(cmd, lp),
                  }));
                  decorated.sort((a, b) => a.tier - b.tier);
                  return decorated.map((d) => d.cmd);
                })();

          const finalSuggestions = sortedSuggestions.map((cmd) => {
            // MCP prompt display names ("server:prompt (MCP)") are
            // self-identifying, so no source label. The popup shows the
            // user-facing displayName, but the inserted value is always the
            // canonical internal name (e.g. "mcp__server__prompt") — the
            // space-containing display form is fragile in the input buffer.
            // Users who manually type the display form still resolve via the
            // parser's (MCP) token merge.
            const isMcpPrompt = cmd.kind === CommandKind.MCP_PROMPT;
            const sourceLabel = isMcpPrompt
              ? undefined
              : (cmd.pluginName ?? cmd.mcpServerName);

            const suggestion: Suggestion = {
              label: cmd.displayName ?? cmd.name,
              value: cmd.name,
              description: translate
                ? resolveCommandDescription(
                    cmd,
                    [...canonicalCommandPathParts, cmd.name].join(' '),
                    translate,
                    locale ?? 'en',
                    descriptionKeys,
                  )
                : cmd.description,
              commandKind: cmd.kind,
              ...(sourceLabel ? { sourceLabel } : {}),
            };

            return suggestion;
          });

          setSuggestions(finalSuggestions);
        }
      };

      performFuzzySearch().catch((error) => {
        logErrorSafely(error, 'Unexpected fuzzy search error');
        if (!signal.aborted) {
          // Ultimate fallback: show no suggestions rather than confusing the user
          // with all available commands when their query clearly doesn't match anything
          setSuggestions([]);
        }
      });
      return () => abortController.abort();
    }

    setSuggestions([]);
    return () => abortController.abort();
  }, [
    query,
    parserResult,
    // commandContext is accessed via commandContextRef to avoid re-running
    // this effect when its identity changes (which would cause a render loop).
    getFzfForCommands,
    getPrefixSuggestions,
    translate,
    locale,
    descriptionKeys,
  ]);

  // Stabilize the suggestions reference: only produce a new array identity when
  // the suggestion content actually changes. The async fuzzy search creates new
  // array references on every run even when results are identical, which cascades
  // through useSlashCompletion → useCommandCompletion's reset effect and resets
  // activeSuggestionIndex to 0, breaking ↑↓ suggestion navigation.
  const stableSuggestionsRef = useRef<Suggestion[]>([]);
  const stableSuggestions = useMemo(() => {
    const prev = stableSuggestionsRef.current;
    if (
      prev.length === suggestions.length &&
      prev.every(
        (s, i) =>
          s.value === suggestions[i].value &&
          s.label === suggestions[i].label &&
          s.description === suggestions[i].description &&
          s.sourceLabel === suggestions[i].sourceLabel,
      )
    ) {
      return prev;
    }
    stableSuggestionsRef.current = suggestions;
    return suggestions;
  }, [suggestions]);

  return { suggestions: stableSuggestions, isLoading };
}

function useCompletionPositions(
  query: string | null,
  parserResult: CommandParserResult,
): CompletionPositions {
  return useMemo(() => {
    if (!query) {
      return { start: -1, end: -1 };
    }

    const { hasTrailingSpace, partial } = parserResult;

    // Set completion start/end positions
    if (hasTrailingSpace) {
      return { start: query.length, end: query.length };
    } else if (partial) {
      if (parserResult.isArgumentCompletion) {
        const commandSoFar = `/${parserResult.commandPathParts.join(' ')}`;
        const argStartIndex =
          commandSoFar.length +
          (parserResult.commandPathParts.length > 0 ? 1 : 0);
        return { start: argStartIndex, end: query.length };
      } else {
        return { start: query.length - partial.length, end: query.length };
      }
    } else {
      return { start: 1, end: query.length };
    }
  }, [query, parserResult]);
}

function usePerfectMatch(
  parserResult: CommandParserResult,
): PerfectMatchResult {
  return useMemo(() => {
    const { hasTrailingSpace, partial, leafCommand, currentLevel } =
      parserResult;

    // Tab leaves a trailing space on every completion, so a runnable command
    // followed by one is still "fully typed" — Enter should run it.
    if (parserResult.isCompletedRunnableCommand) {
      return { isPerfectMatch: true };
    }

    if (hasTrailingSpace) {
      return { isPerfectMatch: false };
    }

    if (leafCommand && partial === '' && leafCommand.action) {
      return { isPerfectMatch: true };
    }

    if (currentLevel) {
      const matched = findCommandByPart(currentLevel, partial)?.cmd;
      if (matched?.action) {
        return { isPerfectMatch: true };
      }
    }

    return { isPerfectMatch: false };
  }, [parserResult]);
}

/**
 * Gets the SlashCommand object for a given suggestion by navigating the command hierarchy
 * based on the current parser state.
 * @param suggestion The suggestion object
 * @param parserResult The current parser result with hierarchy information
 * @returns The matching SlashCommand or undefined
 */
function getCommandFromSuggestion(
  suggestion: Suggestion,
  parserResult: CommandParserResult,
): SlashCommand | undefined {
  // When the popup is showing argument completions, suggestion.value is the
  // argument text — not a command identifier — so it must never be looked up
  // against the command registry.
  if (parserResult.isArgumentCompletion) {
    return undefined;
  }

  const { currentLevel } = parserResult;
  if (!currentLevel) {
    return undefined;
  }

  // finalSuggestions now always sets suggestion.value = cmd.name, so the
  // first pass covers the normal path. The displayName pass is kept as a
  // fallback (mirrors upstream semantics) in case a value ever carries the
  // display form. Two passes (name first, then displayName) preserve the
  // name-first tier ordering findCommandByPart enforces: a command's
  // displayName must never shadow another command's canonical name.
  return (
    currentLevel.find((cmd) => cmd.name === suggestion.value) ??
    currentLevel.find((cmd) => cmd.displayName === suggestion.value)
  );
}

export interface UseSlashCompletionProps {
  enabled: boolean;
  query: string | null;
  slashCommands: readonly SlashCommand[];
  commandContext: CommandContext;
  setSuggestions: (suggestions: Suggestion[]) => void;
  setIsLoadingSuggestions: (isLoading: boolean) => void;
  setIsPerfectMatch: (isMatch: boolean) => void;
  translate?: I18nService['get'];
  locale?: UiLocale;
}

export function useSlashCompletion(props: UseSlashCompletionProps): {
  completionStart: number;
  completionEnd: number;
  getCommandFromSuggestion: (
    suggestion: Suggestion,
  ) => SlashCommand | undefined;
  isArgumentCompletion: boolean;
  leafCommand: SlashCommand | null;
  /**
   * See {@link CommandParserResult.isCompletedRunnableCommand}. Exposed so the
   * Enter key can be routed to the command itself rather than to the
   * auto-highlighted first subcommand.
   */
  isCompletedRunnableCommand: boolean;
} {
  const builtinCommandDescriptionKeys = useCommandDescriptionKeys();
  const {
    enabled,
    query,
    slashCommands,
    commandContext,
    setSuggestions,
    setIsLoadingSuggestions,
    setIsPerfectMatch,
    translate,
    locale,
  } = props;
  const [completionStart, setCompletionStart] = useState(-1);
  const [completionEnd, setCompletionEnd] = useState(-1);

  // Simplified cache for AsyncFzf instances - WeakMap handles automatic cleanup
  const fzfInstanceCache = useMemo(
    () => new WeakMap<readonly SlashCommand[], FzfCommandCacheEntry>(),
    [],
  );

  // Helper function to create or retrieve cached AsyncFzf instance for a command level
  const getFzfForCommands = useMemo(
    () => (commands: readonly SlashCommand[]) => {
      if (!commands || commands.length === 0) {
        return null;
      }

      // Check if we already have a cached instance
      const cached = fzfInstanceCache.get(commands);
      if (cached) {
        return cached;
      }

      // Create new fzf instance — index name + displayName + altNames per cmd (CC 对齐)
      const items: CommandSearchItem[] = [];

      commands.forEach((cmd) => {
        if (!cmd.hidden) {
          items.push({ cmd, searchText: cmd.name, source: 'name' });

          if (cmd.displayName && cmd.displayName !== cmd.name) {
            items.push({
              cmd,
              searchText: cmd.displayName,
              source: 'displayName',
            });
          }

          if (cmd.altNames) {
            cmd.altNames.forEach((alt) => {
              items.push({ cmd, searchText: alt, source: 'altName' });
            });
          }
        }
      });

      if (items.length === 0) {
        return null;
      }

      try {
        const instance: FzfCommandCacheEntry = {
          fzf: new AsyncFzf(items, {
            fuzzy: 'v2',
            casing: 'case-insensitive', // 模糊搜索容错，与路由的精确匹配独立
            selector: (it: CommandSearchItem) => it.searchText,
          }),
        };

        // Cache the instance - WeakMap will handle automatic cleanup
        fzfInstanceCache.set(commands, instance);

        return instance;
      } catch (error) {
        logErrorSafely(error, 'FZF instance creation');
        return null;
      }
    },
    [fzfInstanceCache],
  );

  // Memoized helper function for prefix-based filtering to improve performance
  const getPrefixSuggestions = useMemo(
    () => (commands: readonly SlashCommand[], partial: string) => {
      const lowerPartial = partial.toLowerCase();
      return commands.filter(
        (cmd) =>
          !cmd.hidden &&
          (cmd.name.toLowerCase().startsWith(lowerPartial) ||
            cmd.displayName?.toLowerCase().startsWith(lowerPartial) ||
            cmd.altNames?.some((alt) =>
              alt.toLowerCase().startsWith(lowerPartial),
            )),
      );
    },
    [],
  );

  // Use extracted hooks for better separation of concerns
  const parserResult = useCommandParser(query, slashCommands);
  const { suggestions: hookSuggestions, isLoading } = useCommandSuggestions(
    query,
    parserResult,
    commandContext,
    getFzfForCommands,
    getPrefixSuggestions,
    translate,
    locale,
    builtinCommandDescriptionKeys,
  );
  const { start: calculatedStart, end: calculatedEnd } = useCompletionPositions(
    query,
    parserResult,
  );
  const { isPerfectMatch } = usePerfectMatch(parserResult);

  // Clear internal state when disabled
  useEffect(() => {
    if (!enabled) {
      setSuggestions([]);
      setIsLoadingSuggestions(false);
      setIsPerfectMatch(false);
      setCompletionStart(-1);
      setCompletionEnd(-1);
    }
  }, [enabled, setSuggestions, setIsLoadingSuggestions, setIsPerfectMatch]);

  // Update external state only when enabled
  useEffect(() => {
    if (!enabled || query === null) {
      return;
    }

    setSuggestions(hookSuggestions);
    setIsLoadingSuggestions(isLoading);
    setIsPerfectMatch(isPerfectMatch);
    setCompletionStart(calculatedStart);
    setCompletionEnd(calculatedEnd);
  }, [
    enabled,
    query,
    hookSuggestions,
    isLoading,
    isPerfectMatch,
    calculatedStart,
    calculatedEnd,
    setSuggestions,
    setIsLoadingSuggestions,
    setIsPerfectMatch,
  ]);

  return {
    completionStart,
    completionEnd,
    getCommandFromSuggestion: (suggestion: Suggestion) =>
      getCommandFromSuggestion(suggestion, parserResult),
    isArgumentCompletion: parserResult.isArgumentCompletion,
    leafCommand: parserResult.leafCommand,
    // Gated on `enabled`: useCommandParser runs unconditionally, and in `@`
    // mode `query` is a path fragment rather than a slash command, which the
    // parser would still happily split on. `enabled` implies SLASH mode.
    isCompletedRunnableCommand:
      enabled && parserResult.isCompletedRunnableCommand,
  };
}
