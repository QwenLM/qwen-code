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

type HookMatcherTargetKind =
  | 'toolName'
  | 'agentType'
  | 'trigger'
  | 'sessionTrigger'
  | 'error'
  | 'notificationType'
  | 'filePath';

interface HookMatcherTarget {
  kind: HookMatcherTargetKind;
  target: string;
}

export function getHookMatcherTarget(
  eventName: HookEventName,
  context?: HookEventContext,
): HookMatcherTarget | undefined {
  switch (eventName) {
    case HookEventName.PreToolUse:
    case HookEventName.PostToolUse:
    case HookEventName.PostToolUseFailure:
    case HookEventName.PermissionRequest:
    case HookEventName.PermissionDenied:
      return { kind: 'toolName', target: context?.toolName ?? '' };

    case HookEventName.SubagentStart:
    case HookEventName.SubagentStop:
      return { kind: 'agentType', target: context?.agentType ?? '' };

    case HookEventName.PreCompact:
    case HookEventName.PostCompact:
      return { kind: 'trigger', target: context?.trigger ?? '' };

    case HookEventName.SessionStart:
    case HookEventName.SessionEnd:
      return { kind: 'sessionTrigger', target: context?.trigger ?? '' };

    case HookEventName.StopFailure:
      return { kind: 'error', target: context?.error ?? '' };

    case HookEventName.Notification:
      return {
        kind: 'notificationType',
        target: context?.notificationType ?? '',
      };

    case HookEventName.InstructionsLoaded:
      return { kind: 'filePath', target: context?.filePath ?? '' };

    case HookEventName.UserPromptSubmit:
    case HookEventName.Stop:
    case HookEventName.TodoCreated:
    case HookEventName.TodoCompleted:
      return undefined;

    default: {
      const exhaustive: never = eventName;
      return exhaustive;
    }
  }
}

export function hookEventSupportsMatcher(eventName: HookEventName): boolean {
  const target = getHookMatcherTarget(eventName);
  return typeof target === 'object' && target !== null;
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
    const matchingEntries = hookEntries.filter((entry) =>
      this.matchesContext(entry, eventName, context),
    );

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

    const matcherTarget = getHookMatcherTarget(eventName, context);
    if (!matcherTarget || !matcherTarget.target) {
      return true;
    }

    switch (matcherTarget.kind) {
      case 'toolName':
        return this.matchesToolName(matcher, matcherTarget.target);

      case 'agentType':
        return this.matchesAgentType(matcher, matcherTarget.target);

      case 'trigger':
      case 'error':
        return this.matchesTrigger(matcher, matcherTarget.target);

      case 'notificationType':
        return this.matchesNotificationType(matcher, matcherTarget.target);

      case 'filePath':
        return this.matchesFilePath(matcher, matcherTarget.target);

      case 'sessionTrigger':
        return this.matchesSessionTrigger(matcher, matcherTarget.target);

      default: {
        const exhaustive: never = matcherTarget.kind;
        return exhaustive;
      }
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
   * Match loaded instruction file path against matcher pattern.
   */
  private matchesFilePath(matcher: string, filePath: string): boolean {
    try {
      const regex = new RegExp(matcher);
      return regex.test(filePath);
    } catch (error) {
      debugLogger.warn(
        `Invalid regex in hook matcher "${matcher}" for file path "${filePath}", falling back to exact match: ${error}`,
      );
      return matcher === filePath;
    }
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
  notificationType?: string;
  /** Agent type for SubagentStart/SubagentStop matcher filtering */
  agentType?: string;
  /** Error type for StopFailure matcher filtering (fieldToMatch: 'error') */
  error?: string;
  /** Loaded instruction/context file path for InstructionsLoaded matcher filtering */
  filePath?: string;
}
