/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { discoverAndRegisterDynamicSkills } from '../skills/dynamicSkillDiscovery.js';
import { runLogger } from '../utils/runLogger.js';
import { isSubpath } from '../utils/paths.js';
import { resolveWorktreeResourcePath } from '../services/worktree/pathIdentity.js';

/**
 * Discovers and loads JIT (Just-In-Time) subdirectory context for a given
 * file or directory path. This is used by "high-intent" tools (Read,
 * Write, Edit) to dynamically load GEMINI.md context files from
 * subdirectories when the agent accesses them.
 *
 * The discovered content is stored in MemoryContextManager and delivered
 * to the model via the attachment pipeline (RelevantMemoriesAttachment).
 * Tools only need to call this for the side effect of updating loadedPaths.
 *
 * @param config - The runtime configuration.
 * @param accessedPath - The absolute path being accessed by the tool.
 */
export async function discoverJitContext(
  config: Config,
  accessedPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const memoryContextManager = config.getMemoryContextManager();
  const skillDiscoveryAllowed =
    config.isTrustedFolder() && config.isAgentSourceAllowed('project');

  // Run memory context and skill discovery concurrently — both are supplementary.
  const [, skillDiscoveryResult] = await Promise.allSettled([
    memoryContextManager
      ? memoryContextManager.discoverContext(
          accessedPath,
          [...config.getWorkspaceContext().getDirectories()],
          signal,
        )
      : Promise.resolve(),
    skillDiscoveryAllowed
      ? discoverAndRegisterDynamicSkills({
          accessedPaths: [
            resolveWorktreeResourcePath(
              accessedPath,
              config.getWorktreeSettings(),
            ),
          ],
          cwd: resolveWorktreeResourcePath(
            config.getTargetDir(),
            config.getWorktreeSettings(),
          ),
          loadFromAgentsDirectory: config.shouldLoadSkillsFromAgentsDirectory(),
          skillManager: config.getSkillManager(),
          signal,
        })
      : Promise.resolve(),
  ]);

  signal?.throwIfAborted();
  if (
    skillDiscoveryResult.status === 'fulfilled' &&
    skillDiscoveryResult.value
  ) {
    // Newly discovered conditional skills were not present during the
    // pre-operation activation pass. Activate them now for the tool result's
    // continuation, then refresh consumers such as the slash-command catalog.
    activateConditionalSkillsForPath(config, accessedPath);
    config.notifySkillsChanged();
  }
}

/**
 * Activates conditional skills whose `paths` patterns match the accessed
 * file path. This is a lightweight, synchronous-friendly check that should
 * be called **before** a file operation so that newly activated skills are
 * visible to the model in the current turn.
 *
 * @param config - The runtime configuration.
 * @param accessedPath - The absolute path being accessed by the tool.
 */
export function activateConditionalSkillsForPath(
  config: Config,
  accessedPath: string,
): void {
  const skillManager = config.getSkillManager();
  const cwd = config.getTargetDir();

  if (isSubpath(cwd, accessedPath)) {
    const relativePath = path.relative(cwd, accessedPath);
    const newlyActivated = skillManager.activateConditionalSkillsForPaths([
      relativePath,
    ]);
    if (newlyActivated.length > 0) {
      runLogger.debug(
        `Activated conditional skills: ${newlyActivated.join(', ')}`,
      );
    }
  }
}
