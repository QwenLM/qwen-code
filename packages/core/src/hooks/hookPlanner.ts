/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookRegistry, HookRegistryEntry } from './hookRegistry.js';
import {
  getHookKey,
  type HookConfig,
  type HookExecutionPlan,
  type HookEventName,
} from './types.js';
import { runLogger } from '../utils/runLogger.js';
import { getToolAliases, resolveToolName } from '../tools/tool-names.js';
import { parseBashCommandDetails } from '../utils/shell-utils.js';
import {
  parsePermissionRule,
  matchWildcardPattern,
} from '../tools/shell-permissions/shellRuleMatching.js';

/**
 * Parsed representation of an `if` condition string.
 * Format: "ToolName(arg_pattern)" or just "ToolName".
 */
interface IfCondition {
  toolName: string;
  argPattern?: string;
}

/**
 * Hook planner that selects matching hooks and creates execution plans
 */
export class HookPlanner {
  private readonly hookRegistry: HookRegistry;

  constructor(hookRegistry: HookRegistry) {
    this.hookRegistry = hookRegistry;
  }

  /**
   * Create execution plan for a hook event.
   * @param canConsumeRewake When true, asyncRewake hooks can run in background
   *   (a persistent consumer exists to process rewake notifications).
   *   False only for one-shot headless mode where no next turn exists.
   */
  createExecutionPlan(
    eventName: HookEventName,
    context?: HookEventContext,
    canConsumeRewake: boolean = true,
  ): HookExecutionPlan | null {
    const hookEntries = this.hookRegistry.getHooksForEvent(eventName);

    // Merge session hooks: for subagents use their agentId; for the main agent
    // (no agentId) include inline skill hooks registered under "skill:<name>".
    // Subagents do NOT inherit inline skill hooks (matching upstream semantics).
    const agentId = context?.agentId;
    const sessionEntries = agentId
      ? this.hookRegistry.getSessionHooksForEvent(agentId, eventName)
      : this.hookRegistry.getInlineSkillSessionHooksForEvent(eventName);

    const allEntries =
      sessionEntries.length > 0
        ? [...hookEntries, ...sessionEntries]
        : hookEntries;

    if (allEntries.length === 0) {
      return null;
    }

    // Filter hooks by matcher (entry-level)
    const matchingEntries = allEntries.filter((entry) =>
      this.matchesContext(entry, context),
    );

    if (matchingEntries.length === 0) {
      return null;
    }

    // Deduplicate identical hooks
    const deduplicatedEntries = this.deduplicateHooks(matchingEntries);

    // Second-level filter: per-hook-config `if` condition
    const ifFilteredEntries = deduplicatedEntries.filter((entry) =>
      this.matchesHookConfigIf(entry.config, context),
    );

    if (ifFilteredEntries.length === 0) {
      return null;
    }

    // Split into sync and async hooks (single pass).
    // asyncRewake hooks downgrade to sync when !canConsumeRewake (no persistent consumer).
    const syncEntries: HookRegistryEntry[] = [];
    const asyncEntries: HookRegistryEntry[] = [];
    for (const entry of ifFilteredEntries) {
      const isRewake =
        entry.config.type === 'command' && !!entry.config.asyncRewake;
      const isAsync =
        isRewake
          ? canConsumeRewake // rewake → async only when a consumer exists
          : !!entry.async; // non-rewake → respect definition-level async
      if (isAsync) {
        asyncEntries.push(entry);
      } else {
        syncEntries.push(entry);
      }
    }

    // Extract hook configs
    const hookConfigs = syncEntries.map((entry) => entry.config);
    const asyncHookConfigs = asyncEntries.map((entry) => entry.config);

    if (hookConfigs.length === 0 && asyncHookConfigs.length === 0) {
      return null;
    }

    // Determine execution strategy - if ANY sync hook definition has sequential=true, run all sequentially
    const sequential = syncEntries.some((entry) => entry.sequential === true);

    const plan: HookExecutionPlan = {
      eventName,
      hookConfigs,
      sequential,
      asyncHookConfigs,
      matchQuery: context?.toolName || context?.trigger,
    };

    runLogger.debug(
      `Created execution plan for ${eventName}: ${hookConfigs.length} sync hook(s) ${sequential ? 'sequentially' : 'in parallel'}` +
        (asyncHookConfigs.length > 0
          ? `, ${asyncHookConfigs.length} async hook(s)`
          : ''),
    );

    return plan;
  }

  /**
   * Check if a hook entry matches the given context (entry-level `matcher`)
   */
  private matchesContext(
    entry: HookRegistryEntry,
    context?: HookEventContext,
  ): boolean {
    if (!entry.matcher || !context) {
      return true; // No matcher means match all
    }

    const matcher = entry.matcher.trim();

    if (matcher === '' || matcher === '*') {
      return true; // Empty string or wildcard matches all
    }

    // For tool events, match against tool name
    if (context.toolName) {
      return this.matchesToolName(matcher, context.toolName);
    }

    // For other events, match against trigger/source
    if (context.trigger) {
      return this.matchesTrigger(matcher, context.trigger);
    }

    return true;
  }

  /**
   * Check if a hook config's `if` condition matches the current context.
   * Format: "ToolName(arg_pattern)" or "ToolName".
   * Hooks without an `if` field always match.
   */
  private matchesHookConfigIf(
    config: HookConfig,
    context?: HookEventContext,
  ): boolean {
    // Only command, http, prompt, agent configs can have `if`
    if (!('if' in config) || !config.if || !context) {
      return true;
    }

    const condition = this.parseIfCondition(config.if);
    return this.matchesIfCondition(condition, context);
  }

  /**
   * Parse an `if` condition string.
   * Examples:
   *   "Bash"            → { toolName: "Bash" }
   *   "Bash(git *)"     → { toolName: "Bash", argPattern: "git *" }
   *   "Edit(*.ts)"      → { toolName: "Edit", argPattern: "*.ts" }
   */
  private parseIfCondition(ifString: string): IfCondition {
    const parenIdx = ifString.indexOf('(');
    if (parenIdx === -1) {
      return { toolName: ifString.trim() };
    }

    const toolName = ifString.slice(0, parenIdx).trim();
    let argPattern = ifString.slice(parenIdx + 1).trim();

    // Remove trailing ')' if present
    if (argPattern.endsWith(')')) {
      argPattern = argPattern.slice(0, -1).trim();
    }

    return { toolName, argPattern: argPattern || undefined };
  }

  /**
   * Check if a parsed `if` condition matches the current event context.
   */
  private matchesIfCondition(
    condition: IfCondition,
    context: HookEventContext,
  ): boolean {
    // Match tool name
    if (context.toolName) {
      if (!this.matchesToolName(condition.toolName, context.toolName)) {
        return false;
      }
    } else {
      // If the condition specifies a tool name but context has none, no match
      return false;
    }

    // Match argument pattern (if specified)
    if (condition.argPattern && context.toolInput) {
      return this.matchesArgPattern(condition.argPattern, context.toolInput);
    }

    // If there's an arg pattern but no toolInput in context, skip the arg check
    // (match on tool name alone)
    return true;
  }

  /**
   * Match a glob-like argument pattern against tool input.
   * Extracts the primary argument value (e.g. `command` for Bash, `file_path`
   * for file tools) and tests it against the pattern using simple glob matching.
   */
  private matchesArgPattern(
    pattern: string,
    toolInput: Record<string, unknown>,
  ): boolean {
    // Extract the primary argument value to match against
    const primaryValue = this.extractPrimaryArg(toolInput);
    if (!primaryValue) {
      return false;
    }

    // For shell commands, use tree-sitter parsing to handle variable assignments
    // and compound commands (e.g., "VAR=1 git push" or "ls && git push")
    if ('command' in toolInput) {
      const parseResult = parseBashCommandDetails(primaryValue);
      if (parseResult && parseResult.details.length > 0) {
        return parseResult.details.some((detail) => {
          const argv = detail.args
            ? `${detail.name} ${detail.args.join(' ')}`
            : detail.name;
          return this.matchPermissionPattern(pattern, argv);
        });
      }
      // Fall through to raw match if parsing fails
    }

    return this.matchPermissionPattern(pattern, primaryValue);
  }

  /**
   * Extract the primary argument string from tool input for `if` matching.
   * Convention: `command` field for shell tools, `file_path` for
   * file tools, or the first string value.
   */
  /** Priority order of known primary argument fields for `if` matching */
  private static readonly PRIMARY_ARG_KEYS = [
    'command',
    'file_path',
    'filePath',
    'path',
    'url',
    'query',
    'pattern',
  ];

  private extractPrimaryArg(toolInput: Record<string, unknown>): string | null {
    const knownKeys = HookPlanner.PRIMARY_ARG_KEYS;

    for (const key of knownKeys) {
      if (key in toolInput && typeof toolInput[key] === 'string') {
        return toolInput[key];
      }
    }

    // Fallback: first string value
    for (const value of Object.values(toolInput)) {
      if (typeof value === 'string') {
        return value;
      }
    }

    return null;
  }

  private matchPermissionPattern(pattern: string, value: string): boolean {
    const rule = parsePermissionRule(pattern);
    switch (rule.type) {
      case 'prefix':
        return value === rule.prefix || value.startsWith(`${rule.prefix} `);
      case 'wildcard':
        return matchWildcardPattern(rule.pattern, value);
      case 'exact': {
        // Hook `if` conditions also support `?` as single-char wildcard.
        if (rule.command.includes('?')) {
          const escaped = rule.command.replace(/[.+^${}()|[\]\\*]/g, '\\$&');
          const regexStr = '^' + escaped.replace(/\?/g, '.') + '$';
          try {
            return new RegExp(regexStr, 's').test(value);
          } catch {
            return rule.command === value;
          }
        }
        // Un-escape `\*` and `\\` for exact matching.
        const literal = rule.command
          .replace(/\\\*/g, '*')
          .replace(/\\\\/g, '\\');
        return literal === value;
      }
      default:
        return pattern === value;
    }
  }

  /**
   * Match tool name against matcher pattern
   */
  private matchesToolName(matcher: string, toolName: string): boolean {
    try {
      // Attempt to treat the matcher as a regular expression.
      // Uses partial matching so patterns like "Edit|Write" can match
      // tool names like "EditTool" or "WriteTool".
      const regex = new RegExp(matcher);
      // Test against all aliases of the tool name (CC compat)
      const allNames = getToolAliases(toolName);
      return allNames.some((alias) => regex.test(alias));
    } catch {
      // If it's not a valid regex, resolve both sides to canonical names.
      return resolveToolName(matcher) === resolveToolName(toolName);
    }
  }

  /**
   * Match trigger/source against matcher pattern.
   * Supports pipe-separated literals (e.g. "manual|auto"),
   * regex patterns (when the string contains regex metacharacters beyond |),
   * and plain exact matching as fallback.
   */
  private matchesTrigger(matcher: string, trigger: string): boolean {
    // Pipe-separated literal values (e.g. "manual|auto") — only when no
    // other regex metacharacters are present besides `|`.
    if (matcher.includes('|')) {
      const hasRegexMeta = /[.*+?^${}()[\]\\]/.test(matcher);
      if (!hasRegexMeta) {
        const options = matcher.split('|').map((s) => s.trim());
        return options.includes(trigger);
      }
      // Has `|` plus other metacharacters — treat entire string as regex
    }

    // Treat as regex if any metacharacters are present (including `|`)
    if (/[.*+?^${}()|[\]\\]/.test(matcher)) {
      try {
        return new RegExp(matcher).test(trigger);
      } catch {
        return matcher === trigger;
      }
    }

    // Plain exact match
    return matcher === trigger;
  }

  /**
   * Deduplicate identical hook configurations
   */
  private deduplicateHooks(entries: HookRegistryEntry[]): HookRegistryEntry[] {
    const seen = new Set<string>();
    const deduplicated: HookRegistryEntry[] = [];

    for (const entry of entries) {
      // Namespace by pluginRoot so different plugins sharing the same
      // command template don't collapse (aligned with reference hookDedupKey).
      const prefix =
        entry.config.type === 'command' && entry.config.pluginRoot
          ? entry.config.pluginRoot
          : '';
      const key = `${prefix}\0${getHookKey(entry.config)}`;

      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(entry);
      } else {
        runLogger.debug(`Deduplicated hook: ${key}`);
      }
    }

    return deduplicated;
  }
}

/**
 * Context information for hook event matching
 */
export interface HookEventContext {
  toolName?: string;
  trigger?: string;
  /** Tool input parameters, used for `if` field argument matching */
  toolInput?: Record<string, unknown>;
  /** When set, session hooks registered for this agent are merged into the plan. */
  agentId?: string;
}
