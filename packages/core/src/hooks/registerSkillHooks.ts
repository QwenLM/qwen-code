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

import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
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
 * Session-active marker path for the `/review` skill. Written when the skill
 * is registered so `guard.sh` knows a review session is in progress even
 * before `qwen review fetch-pr` has had a chance to write its
 * `qwen-review-pr-<n>-fetch.json`. Closes the pre-fetch-pr gap where a
 * weakly-instruction-following model could call `git checkout FETCH_HEAD`
 * straight away — at that moment the fetch-pr marker doesn't exist yet,
 * so guard.sh's self-disable branch would otherwise fire and the bad
 * `git checkout` would slide through.
 *
 * The path is computed against `process.cwd()` because skill registration
 * happens at the project root in normal interactive flow. The marker is
 * project-scoped (lives under `.qwen/tmp/`) so concurrent /review sessions
 * in different projects don't trample each other.
 */
const REVIEW_ACTIVE_MARKER = join('.qwen', 'tmp', 'qwen-review-active');

function writeReviewActiveMarker(): void {
  try {
    mkdirSync(join('.qwen', 'tmp'), { recursive: true });
    writeFileSync(REVIEW_ACTIVE_MARKER, '');
    debugLogger.debug(
      `Wrote /review session marker at ${REVIEW_ACTIVE_MARKER}`,
    );
  } catch (err) {
    // Defensive: marker is a hint for guard.sh, not a hard prerequisite —
    // failure to write must not block skill activation. CLI gates
    // (`requireFetchReport` in pr-context / presubmit / load-rules --pr /
    // deterministic --pr) stay deterministic even if the marker is absent.
    debugLogger.warn(
      `Failed to write /review session marker: ${(err as Error).message}`,
    );
  }
}

/** @internal Removes the /review session marker — called by `qwen review cleanup`. */
export function removeReviewActiveMarker(): boolean {
  try {
    unlinkSync(REVIEW_ACTIVE_MARKER);
    return true;
  } catch {
    // ENOENT / EACCES → already gone or we don't care; cleanup is best-effort.
    return false;
  }
}

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

  // /review-specific: write the session-active marker so `guard.sh`'s
  // self-disable check (which keys off `.qwen/tmp/` markers) fires from
  // the very first `run_shell_command`, not just after `fetch-pr` has
  // already written its own marker. See `REVIEW_ACTIVE_MARKER` JSDoc
  // above for the threat model this closes.
  if (skill.name === 'review') {
    writeReviewActiveMarker();
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
