/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Hooks Registration
 *
 * Registers hooks from a skill's frontmatter as session-scoped hooks.
 * When a skill is invoked, its hooks are registered for the duration
 * of the session.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { SessionHooksManager } from './sessionHooksManager.js';
import type { SkillHooksSettings, SkillConfig } from '../skills/types.js';
import {
  HookType,
  type HookEventName,
  type CommandHookConfig,
  type HttpHookConfig,
} from './types.js';

const debugLogger = createDebugLogger('SKILL_HOOKS');

/**
 * Registers hooks from a skill's configuration as session hooks.
 *
 * Hooks are registered as session-scoped hooks that persist for the duration
 * of the session. If a hook has `once: true` in its configuration, it will be
 * automatically removed after its first successful execution.
 *
 * @param sessionHooksManager - The session hooks manager instance
 * @param sessionId - The current session ID
 * @param skill - The skill configuration containing hooks
 * @returns Number of hooks registered
 */
export function registerSkillHooks(
  sessionHooksManager: SessionHooksManager,
  sessionId: string,
  skill: SkillConfig,
): number {
  if (!skill.hooks) {
    debugLogger.debug(`Skill '${skill.name}' has no hooks to register`);
    return 0;
  }

  const hooksSettings: SkillHooksSettings = skill.hooks;
  let registeredCount = 0;

  for (const eventName of Object.keys(hooksSettings) as HookEventName[]) {
    const matchers = hooksSettings[eventName];
    if (!matchers) continue;

    for (const matcher of matchers) {
      const matcherPattern = matcher.matcher || '';

      for (const hook of matcher.hooks) {
        // Only register command and HTTP hooks (skip function hooks)
        if (hook.type === HookType.Function) {
          debugLogger.debug(
            'Skipping function hook from skill (not supported in frontmatter)',
          );
          continue;
        }

        // Register the hook with skillRoot for environment variable
        const hookConfig = prepareHookConfig(
          hook as CommandHookConfig | HttpHookConfig,
          skill.skillRoot,
        );

        sessionHooksManager.addSessionHook(
          sessionId,
          eventName,
          matcherPattern,
          hookConfig,
          { skillRoot: skill.skillRoot },
        );

        registeredCount++;
        debugLogger.debug(
          `Registered hook for ${eventName} with matcher '${matcherPattern}' from skill '${skill.name}'`,
        );
      }
    }
  }

  if (registeredCount > 0) {
    debugLogger.info(
      `Registered ${registeredCount} hooks from skill '${skill.name}'`,
    );
  }

  return registeredCount;
}

/**
 * Prepares hook config with skillRoot environment variable.
 *
 * @param hook - The hook configuration
 * @param skillRoot - The skill root directory
 * @returns Prepared hook configuration
 */
function prepareHookConfig(
  hook: CommandHookConfig | HttpHookConfig,
  skillRoot?: string,
): CommandHookConfig | HttpHookConfig {
  if (hook.type === 'command' && skillRoot) {
    // Add QWEN_SKILL_ROOT to environment variables
    return {
      ...hook,
      env: {
        ...hook.env,
        QWEN_SKILL_ROOT: skillRoot,
      },
    };
  }

  return hook;
}

/**
 * Unregisters all hooks from a skill.
 *
 * Note: This is typically not needed as session hooks are cleared
 * when the session ends. However, it can be useful for cleanup
 * in certain scenarios.
 *
 * @param sessionHooksManager - The session hooks manager instance
 * @param sessionId - The current session ID
 * @param skill - The skill configuration
 * @returns Number of hooks unregistered
 */
export function unregisterSkillHooks(
  sessionHooksManager: SessionHooksManager,
  sessionId: string,
  skill: SkillConfig,
): number {
  if (!skill.hooks) {
    return 0;
  }

  // Note: Current implementation doesn't track hook IDs per skill
  // Session hooks are cleared when session ends
  debugLogger.debug(
    `Skill hooks for '${skill.name}' will be cleared with session`,
  );

  return 0;
}
