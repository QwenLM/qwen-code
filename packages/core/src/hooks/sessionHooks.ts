/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  HookEventName,
  isHookEventName,
  type HookConfig,
} from './types.js';
import type { HookSystem } from './hookSystem.js';
import { runLogger } from '../utils/runLogger.js';

/**
 * Register per-agent frontmatter hooks as session-scoped hooks.
 *
 * When `isAgent` is true and the frontmatter defines a `Stop` hook, it is
 * remapped to `SubagentStop` so it fires when the subagent finishes rather
 * than when the main session stops.
 *
 * The `once` flag is only honored for skill frontmatter hooks. When
 * `fromSkill` is false (agent frontmatter), `once` is stripped from configs
 * before registration so the downstream registry never sees it.
 *
 * @param hookSystem The HookSystem proxy (avoids exposing the registry).
 * @param agentId   Unique identifier for the agent session.
 * @param hooks     The parsed `hooks` record from agent frontmatter.
 * @param isAgent   Whether this is a subagent (true) or the main session (false).
 * @param fromSkill Whether the hooks originate from a skill frontmatter.
 */
export function registerFrontmatterHooks(
  hookSystem: HookSystem,
  agentId: string,
  hooks: Record<string, unknown>,
  isAgent: boolean,
  fromSkill: boolean = false,
): void {
  let registeredCount = 0;

  for (const eventName of Object.keys(hooks)) {
    // Validate against the global HOOK_EVENTS source of truth. Unknown keys
    // are warned about (not silently dropped) because skill hooks reach this
    // point as a raw frontmatter record without a schema-validation layer.
    if (!isHookEventName(eventName)) {
      runLogger.warn(
        `Ignoring unknown frontmatter hook event "${eventName}" for agent "${agentId}"`,
      );
      continue;
    }

    // Remap Stop → SubagentStop for subagents
    let targetEvent: HookEventName = eventName;
    if (isAgent && eventName === 'Stop') {
      targetEvent = HookEventName.SubagentStop;
    }

    const matchers = hooks[eventName];
    if (!Array.isArray(matchers)) {
      runLogger.warn(
        `Frontmatter hook "${eventName}" for agent "${agentId}" is not an array. Skipping.`,
      );
      continue;
    }

    for (const matcher of matchers) {
      if (
        !matcher ||
        typeof matcher !== 'object' ||
        !Array.isArray(matcher.hooks)
      ) {
        runLogger.warn(
          `Invalid matcher in frontmatter hook "${eventName}" for agent "${agentId}". Skipping.`,
        );
        continue;
      }

      for (let hookConfig of matcher.hooks as HookConfig[]) {
        // `once` is only honored for skill frontmatter; strip it for agents.
        // Clone to avoid mutating the shared frontmatter parse result.
        if (!fromSkill && 'once' in hookConfig) {
          const { once: _, ...rest } = hookConfig as unknown as Record<
            string,
            unknown
          >;
          hookConfig = rest as unknown as HookConfig;
        }
        hookSystem.registerSessionHook(agentId, hookConfig, targetEvent, {
          matcher: matcher.matcher as string | undefined,
        });
        registeredCount++;
      }
    }
  }

  if (registeredCount > 0) {
    runLogger.debug(
      `Registered ${registeredCount} frontmatter hook(s) for agent "${agentId}"`,
    );
  }
}

/**
 * Clear all session-scoped frontmatter hooks for the given agent.
 * Should be called in the agent's finally block.
 */
export function clearFrontmatterHooks(
  hookSystem: HookSystem,
  agentId: string,
): void {
  hookSystem.clearSessionHooks(agentId);
}
