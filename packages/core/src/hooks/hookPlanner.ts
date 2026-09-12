/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookRegistry, HookRegistryEntry } from './hookRegistry.js';
import type { HookExecutionPlan } from './types.js';
import { getHookKey, HookEventName } from './types.js';
import { getAliasSetForTool } from '../tools/tool-utils.js';
import { matchesHookPattern } from './hook-matcher.js';

export function getToolMatcherTargets(toolName: string): string[] {
  return [...getAliasSetForTool(toolName)];
}

type HookMatcherTargetKind =
  | 'toolName'
  | 'commandName'
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

    case HookEventName.UserPromptExpansion:
      // Unlike UserPromptSubmit, command expansions are matchable by the slash
      // command name that produced the submitted prompt.
      return { kind: 'commandName', target: context?.commandName ?? '' };

    case HookEventName.UserPromptSubmit:
    case HookEventName.Stop:
    case HookEventName.MessageDisplay:
    case HookEventName.PostToolBatch:
    case HookEventName.SessionDelete:
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
   * Check if a hook entry matches the given context. Every event with a
   * matcher target uses the shared matchesHookPattern rule; tool events also
   * match display-name and legacy aliases exactly.
   */
  private matchesContext(
    entry: HookRegistryEntry,
    eventName: HookEventName,
    context?: HookEventContext,
  ): boolean {
    if (!entry.matcher || !context) {
      return true; // No matcher means match all
    }

    const matcherTarget = getHookMatcherTarget(eventName, context);
    if (!matcherTarget || !matcherTarget.target) {
      return true;
    }

    return matchesHookPattern(
      entry.matcher,
      matcherTarget.target,
      matcherTarget.kind === 'toolName'
        ? { aliases: getToolMatcherTargets(matcherTarget.target) }
        : {},
    );
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
  /** Command name for UserPromptExpansion matcher filtering */
  commandName?: string;
  trigger?: string;
  notificationType?: string;
  /** Agent type for SubagentStart/SubagentStop matcher filtering */
  agentType?: string;
  /** Error type for StopFailure matcher filtering (fieldToMatch: 'error') */
  error?: string;
  /** Loaded instruction/context file path for InstructionsLoaded matcher filtering */
  filePath?: string;
}
