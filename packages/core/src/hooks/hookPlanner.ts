/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookRegistry, HookRegistryEntry } from './hookRegistry.js';
import type { HookExecutionPlan } from './types.js';
import { getHookKey, HookEventName } from './types.js';

/**
 * Hook planner that selects matching hooks and creates execution plans
 */
export class HookPlanner {
  private readonly hookRegistry: HookRegistry;

  constructor(hookRegistry: HookRegistry) {
    this.hookRegistry = hookRegistry;
  }

  /**
   * Create execution plan for a hook event
   */
  createExecutionPlan(
    eventName: HookEventName,
    context?: HookEventContext,
  ): HookExecutionPlan | null {
    const hookEntries = this.hookRegistry.getHooksForEvent(eventName);

    if (hookEntries.length === 0) {
      return null;
    }

    // Filter hooks by matcher
    const matchingEntries = hookEntries.filter((entry) =>
      this.matchesContext(entry, context),
    );

    if (matchingEntries.length === 0) {
      return null;
    }

    // Deduplicate identical hooks
    const deduplicatedEntries = this.deduplicateHooks(matchingEntries);

    // Extract hook configs
    const hookConfigs = deduplicatedEntries.map((entry) => entry.config);

    // Determine execution strategy
    // Default behavior: if ANY hook definition has sequential=true, run all sequentially
    const hasHookLevelSequential = deduplicatedEntries.some(
      (entry) => entry.sequential === true,
    );

    // If any hook has sequential=true, respect that setting
    let sequential = hasHookLevelSequential;

    // Override with hook-specific defaults ONLY if no hook-level override
    if (!hasHookLevelSequential) {
      switch (eventName) {
        case HookEventName.PreToolUse:
          // PreToolUse hooks need to run sequentially to allow input modifications to build upon each other
          sequential = true;
          break;
        case HookEventName.PostToolUse:
        case HookEventName.PostToolUseFailure:
        case HookEventName.Notification:
          // These can run in parallel for performance (they occur after main action is complete)
          sequential = false;
          break;
        case HookEventName.SessionStart:
        case HookEventName.SessionEnd:
        case HookEventName.PreCompact:
        case HookEventName.SubagentStart:
        case HookEventName.SubagentStop:
        case HookEventName.PermissionRequest:
        case HookEventName.UserPromptSubmit:
        case HookEventName.Stop:
          // These hooks typically don't modify shared state, can run in parallel
          sequential = false;
          break;
        default:
          // Other hook types maintain the default behavior determined above
          break;
      }
    }

    const plan: HookExecutionPlan = {
      eventName,
      hookConfigs,
      sequential,
    };

    return plan;
  }

  /**
   * Check if a hook entry matches the given context
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
   * Match tool name against matcher pattern
   */
  private matchesToolName(matcher: string, toolName: string): boolean {
    try {
      // Attempt to treat the matcher as a regular expression.
      const regex = new RegExp(matcher);
      return regex.test(toolName);
    } catch {
      // If it's not a valid regex, treat it as a literal string for an exact match.
      return matcher === toolName;
    }
  }

  /**
   * Match trigger/source against matcher pattern
   */
  private matchesTrigger(matcher: string, trigger: string): boolean {
    return matcher === trigger;
  }

  /**
   * Deduplicate identical hook configurations
   */
  private deduplicateHooks(entries: HookRegistryEntry[]): HookRegistryEntry[] {
    const seen = new Set<string>();
    const deduplicated: HookRegistryEntry[] = [];

    for (const entry of entries) {
      const key = getHookKey(entry.config);

      if (!seen.has(key)) {
        seen.add(key);
        deduplicated.push(entry);
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
}
