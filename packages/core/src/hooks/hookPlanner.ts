/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookRegistry, HookRegistryEntry } from './hookRegistry.js';
import type { HookExecutionPlan } from './types.js';
import { getHookKey, HookEventName } from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

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

    // Filter hooks by matcher - pass eventName for explicit dispatch
    // Then filter by `if` field for fine-grained tool arg matching
    const matchingEntries = hookEntries
      .filter((entry) => this.matchesContext(entry, eventName, context))
      .filter((entry) => this.matchesIfCondition(entry, context));

    if (matchingEntries.length === 0) {
      return null;
    }

    // Deduplicate identical hooks
    const deduplicatedEntries = this.deduplicateHooks(matchingEntries);

    // Extract hook configs
    const hookConfigs = deduplicatedEntries.map((entry) => entry.config);

    // Determine execution strategy - if ANY hook definition has sequential=true, run all sequentially
    const sequential = deduplicatedEntries.some(
      (entry) => entry.sequential === true,
    );

    const plan: HookExecutionPlan = {
      eventName,
      hookConfigs,
      sequential,
    };

    return plan;
  }

  /**
   * Check if a hook entry matches the given context.
   * Uses explicit event-based dispatch to avoid ambiguity between events
   * that share similar context fields (e.g., SessionStart and SubagentStart
   * both have agentType, but use different matcher semantics).
   */
  private matchesContext(
    entry: HookRegistryEntry,
    eventName: HookEventName,
    context?: HookEventContext,
  ): boolean {
    if (!entry.matcher || !context) {
      return true; // No matcher means match all
    }

    const matcher = entry.matcher.trim();

    if (matcher === '' || matcher === '*') {
      return true; // Empty string or wildcard matches all
    }

    // Explicit dispatch by event name to avoid ambiguity
    switch (eventName) {
      // Tool events: match against tool name
      case HookEventName.PreToolUse:
      case HookEventName.PostToolUse:
      case HookEventName.PostToolUseFailure:
      case HookEventName.PermissionRequest:
        return context.toolName
          ? this.matchesToolName(matcher, context.toolName)
          : true;

      // Subagent events: match against agent type
      case HookEventName.SubagentStart:
      case HookEventName.SubagentStop:
        return context.agentType
          ? this.matchesAgentType(matcher, context.agentType)
          : true;

      // PreCompact: match against trigger
      case HookEventName.PreCompact:
        return context.trigger
          ? this.matchesTrigger(matcher, context.trigger)
          : true;

      // Notification: match against notification type
      case HookEventName.Notification:
        return context.notificationType
          ? this.matchesNotificationType(matcher, context.notificationType)
          : true;

      // SessionStart/SessionEnd: match against source/reason
      case HookEventName.SessionStart:
        return context.trigger
          ? this.matchesSessionTrigger(matcher, context.trigger)
          : true;

      case HookEventName.SessionEnd:
        return context.trigger
          ? this.matchesSessionTrigger(matcher, context.trigger)
          : true;

      // Events that don't support matchers: always match
      case HookEventName.UserPromptSubmit:
      case HookEventName.Stop:
      default:
        return true;
    }
  }

  /**
   * Match notification type against matcher pattern
   */
  private matchesNotificationType(
    matcher: string,
    notificationType: string,
  ): boolean {
    return matcher === notificationType;
  }

  /**
   * Match session source or end reason against matcher pattern
   */
  private matchesSessionTrigger(matcher: string, trigger: string): boolean {
    try {
      // Attempt to treat the matcher as a regular expression.
      const regex = new RegExp(matcher);
      return regex.test(trigger);
    } catch (error) {
      // If it's not a valid regex, treat it as a literal string for an exact match.
      debugLogger.warn(
        `Invalid regex in hook matcher "${matcher}" for session trigger "${trigger}", falling back to exact match: ${error}`,
      );
      return matcher === trigger;
    }
  }

  /**
   * Match tool name against matcher pattern
   */
  private matchesToolName(matcher: string, toolName: string): boolean {
    try {
      // Attempt to treat the matcher as a regular expression.
      const regex = new RegExp(matcher);
      return regex.test(toolName);
    } catch (error) {
      // If it's not a valid regex, treat it as a literal string for an exact match.
      debugLogger.warn(
        `Invalid regex in hook matcher "${matcher}" for tool "${toolName}", falling back to exact match: ${error}`,
      );
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
   * Match agent type against matcher pattern.
   * Supports regex matching, same as tool name matching.
   */
  private matchesAgentType(matcher: string, agentType: string): boolean {
    try {
      const regex = new RegExp(matcher);
      return regex.test(agentType);
    } catch (error) {
      debugLogger.warn(
        `Invalid regex in hook matcher "${matcher}" for agent type "${agentType}", falling back to exact match: ${error}`,
      );
      return matcher === agentType;
    }
  }

  /**
   * Check if a hook entry's `if` condition matches the context.
   * The `if` field uses permission-rule syntax: "ToolName(glob pattern)".
   * Example: "Bash(git *)", "Edit(*.ts)".
   * Only applies to tool events — other events always pass.
   */
  private matchesIfCondition(
    entry: HookRegistryEntry,
    context?: HookEventContext,
  ): boolean {
    const ifCondition = entry.config.if;
    if (!ifCondition || !context?.toolName) return true;

    // Parse "ToolName(argPattern)" syntax
    const match = ifCondition.match(/^(\w+)\((.+)\)$/);
    if (!match) {
      // No parentheses — treat as simple tool name match
      return context.toolName === ifCondition;
    }

    const [, toolName, argPattern] = match;
    if (toolName !== context.toolName) return false;

    // Convert glob pattern to regex for matching against tool input
    const input = context.toolInput;
    if (!input) return false;

    // Match against the primary string argument (command for Bash, file_path for Edit/Write)
    const primaryArg =
      (input['command'] as string) ??
      (input['file_path'] as string) ??
      (input['pattern'] as string) ??
      '';

    try {
      const globRegex = new RegExp(
        '^' + argPattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      );
      return globRegex.test(primaryArg);
    } catch {
      return primaryArg.includes(argPattern);
    }
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
  /** Tool input arguments — used by `if` field for fine-grained matching. */
  toolInput?: Record<string, unknown>;
  trigger?: string;
  notificationType?: string;
  /** Agent type for SubagentStart/SubagentStop matcher filtering */
  agentType?: string;
}
