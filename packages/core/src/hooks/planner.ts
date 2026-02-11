/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HookEventName,
  HookConfig,
  HookDefinition,
  HookExecutionPlan,
} from './types.js';

/**
 * Match pattern types for hook matching
 */
export type MatchPatternType = 'exact' | 'regex' | 'wildcard';

/**
 * Match pattern configuration
 */
export interface MatchPattern {
  /** The pattern string */
  pattern: string;
  /** Type of pattern matching */
  type: MatchPatternType;
}

/**
 * Hook match result
 */
export interface HookMatchResult {
  /** Whether the hook matches */
  matched: boolean;
  /** The matched hook definition */
  definition?: HookDefinition;
  /** The pattern that matched */
  pattern?: string;
}

/**
 * Options for creating execution plan
 */
export interface PlanOptions {
  /** Event name */
  eventName: HookEventName;
  /** Tool name (for tool-related events) */
  toolName?: string;
  /** Tool display name (for matching) */
  displayName?: string;
  /** Available hook definitions */
  hookDefinitions: HookDefinition[];
  /** Whether to enable deduplication */
  deduplicate?: boolean;
}

/**
 * HookPlanner is responsible for:
 * 1. Matching hooks to events (exact, regex, wildcard)
 * 2. Deduplicating hooks to avoid redundant execution
 * 3. Creating optimized execution plans (sequential/parallel)
 */
export class HookPlanner {
  /**
   * Match a tool name against a pattern
   * Supports: exact match, regex match, wildcard match
   */
  match(toolName: string, pattern: string): boolean {
    // Empty pattern matches nothing
    if (!pattern || pattern.length === 0) {
      return false;
    }

    // Wildcard pattern matches everything
    if (pattern === '*') {
      return true;
    }

    // Check if it's a regex pattern (contains regex special chars)
    if (this.isRegexPattern(pattern)) {
      return this.matchRegex(toolName, pattern);
    }

    // Exact match
    return toolName === pattern;
  }

  /**
   * Detect if a pattern should be treated as regex
   */
  private isRegexPattern(pattern: string): boolean {
    // Regex special characters that indicate regex pattern
    const regexChars = /[.*+?^${}()|[\]\\]/;
    return regexChars.test(pattern);
  }

  /**
   * Match using regex pattern
   */
  private matchRegex(toolName: string, pattern: string): boolean {
    try {
      // Convert glob-like wildcards to regex
      let regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');

      // If pattern doesn't have anchors, add them
      if (!regexPattern.startsWith('^')) {
        regexPattern = '^' + regexPattern;
      }
      if (!regexPattern.endsWith('$')) {
        regexPattern = regexPattern + '$';
      }

      const regex = new RegExp(regexPattern);
      return regex.test(toolName);
    } catch {
      // If regex is invalid, fall back to exact match
      return toolName === pattern;
    }
  }

  /**
   * Match a tool name against a hook definition
   */
  matchDefinition(
    toolName: string,
    definition: HookDefinition,
  ): HookMatchResult {
    // If no matcher defined, it matches everything
    if (!definition.matcher || definition.matcher === '*') {
      return {
        matched: true,
        definition,
        pattern: '*',
      };
    }

    const matched = this.match(toolName, definition.matcher);
    return {
      matched,
      definition: matched ? definition : undefined,
      pattern: matched ? definition.matcher : undefined,
    };
  }

  /**
   * Find all matching hook definitions for a given tool
   */
  findMatchingHooks(
    toolName: string,
    definitions: HookDefinition[],
  ): HookDefinition[] {
    return definitions.filter(
      (def) => this.matchDefinition(toolName, def).matched,
    );
  }

  /**
   * Deduplicate hooks to avoid redundant execution
   * Two hooks are considered duplicates if they have the same command
   */
  deduplicate(hookConfigs: HookConfig[]): HookConfig[] {
    const seen = new Set<string>();
    const deduplicated: HookConfig[] = [];

    for (const config of hookConfigs) {
      const key = this.getHookKey(config);
      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(config);
      }
    }

    return deduplicated;
  }

  /**
   * Generate a unique key for a hook config (for deduplication)
   */
  private getHookKey(config: HookConfig): string {
    if (config.type === 'command') {
      return `command:${config.command}`;
    }
    // For future extension types
    return `unknown:${JSON.stringify(config)}`;
  }

  /**
   * Create an execution plan for the given event and tool
   */
  createPlan(options: PlanOptions): HookExecutionPlan {
    const {
      eventName,
      toolName,
      hookDefinitions,
      deduplicate = true,
    } = options;

    // If no tool name provided or no definitions, return empty plan
    if (!toolName || hookDefinitions.length === 0) {
      return {
        eventName,
        hookConfigs: [],
        sequential: false,
      };
    }

    // Find matching hook definitions
    const matchingDefs = this.findMatchingHooks(toolName, hookDefinitions);

    // Collect all hook configs from matching definitions
    let allHooks: HookConfig[] = [];
    for (const def of matchingDefs) {
      allHooks = allHooks.concat(def.hooks);
    }

    // Deduplicate if enabled
    if (deduplicate) {
      allHooks = this.deduplicate(allHooks);
    }

    // Determine if hooks should run sequentially
    // Sequential if any matching definition specifies sequential: true
    const sequential = matchingDefs.some((def) => def.sequential === true);

    return {
      eventName,
      hookConfigs: allHooks,
      sequential,
    };
  }

  /**
   * Create execution plans for multiple tools at once
   */
  createPlans(
    eventName: HookEventName,
    toolNames: string[],
    hookDefinitions: HookDefinition[],
  ): Map<string, HookExecutionPlan> {
    const plans = new Map<string, HookExecutionPlan>();

    for (const toolName of toolNames) {
      const plan = this.createPlan({
        eventName,
        toolName,
        hookDefinitions,
      });
      plans.set(toolName, plan);
    }

    return plans;
  }

  /**
   * Check if any hooks would match for the given tool
   */
  hasMatchingHooks(toolName: string, definitions: HookDefinition[]): boolean {
    return definitions.some(
      (def) => this.matchDefinition(toolName, def).matched,
    );
  }

  /**
   * Get all unique matchers from hook definitions
   */
  getAllMatchers(definitions: HookDefinition[]): string[] {
    const matchers = new Set<string>();
    for (const def of definitions) {
      if (def.matcher) {
        matchers.add(def.matcher);
      }
    }
    return Array.from(matchers);
  }
}

/**
 * Convenience function to create a hook planner
 */
export function createHookPlanner(): HookPlanner {
  return new HookPlanner();
}

/**
 * Match a tool name against a pattern (standalone function)
 */
export function matchToolName(toolName: string, pattern: string): boolean {
  const planner = new HookPlanner();
  return planner.match(toolName, pattern);
}
