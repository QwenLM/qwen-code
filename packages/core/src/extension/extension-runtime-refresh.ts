/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { Config } from '../config/config.js';

const debugLogger = createDebugLogger('EXTENSION_RUNTIME_REFRESH');

export type ExtensionRuntimeRefreshConfig = Pick<
  Config,
  | 'getToolRegistry'
  | 'getSkillManager'
  | 'getSubagentManager'
  | 'refreshHierarchicalMemory'
>;

export async function refreshExtensionRuntime(
  config: ExtensionRuntimeRefreshConfig | undefined,
): Promise<void> {
  if (!config) return;

  // Error-handling contract:
  //   Tier 1 (fatal)   — restartMcpServers failure propagates. MCP is a
  //                       prerequisite for tool discovery; callers must know
  //                       if it failed so they can surface the error.
  //   Tier 2 (swallow)  — refreshCache failures (skills, subagents) are
  //                       logged via warn but swallowed by allSettled.
  //   Tier 3 (swallow)  — refreshHierarchicalMemory failure is logged via
  //                       error but swallowed by try/catch.
  // When adding new refresh steps, decide explicitly which tier applies.
  await config.getToolRegistry().restartMcpServers();

  // Refresh skills + subagents in parallel. Both `refreshCache` calls now
  // resolve only after their async change-listener chain settles — for skills,
  // that includes `SkillTool.refreshSkills()` rebuilding the model-facing tool
  // description and updating `geminiClient`'s tool list. Use allSettled (rather
  // than Promise.all) so a rejection from one leg does not cascade — the other
  // leg's result is still applied, refreshHierarchicalMemory below still runs,
  // and callers (`enableExtension`, etc.) don't unwind because of an unrelated
  // transient failure.
  const skillManager = config.getSkillManager();
  const settled = await Promise.allSettled([
    skillManager?.refreshCache(),
    config.getSubagentManager().refreshCache(),
  ]);

  for (const result of settled) {
    if (result.status === 'rejected') {
      debugLogger.warn(
        'refreshExtensionRuntime: a refreshCache leg failed:',
        result.reason,
      );
    }
  }

  // Await hierarchical memory refresh so callers only continue after the
  // extension refresh has settled. Wrap in try/catch so a transient failure
  // doesn't propagate up to `enableExtension` / `installExtension` callers,
  // which have already mutated their `isActive`/`installed` flags by the time
  // this function is invoked — a failed memory refresh leaves stale memory
  // but should not back out the surrounding extension transition.
  try {
    await config.refreshHierarchicalMemory();
  } catch (err) {
    debugLogger.error(
      'refreshExtensionRuntime: refreshHierarchicalMemory failed:',
      err,
    );
  }
}
