/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolNames } from '../tool-names.js';
import type { ToolFactory } from '../tool-registry.js';
import type { ToolName } from '../../utils/tool-utils.js';
import type { Config } from '../../config/config.js';
import type { NodeReplSession } from './tool.js';

/**
 * Register the node_repl tool family as lazy factories. All three tools are
 * deferred (`shouldDefer=true`), so they surface via ToolSearch.
 *
 * The three tools share one NodeReplSession (created lazily on the first
 * factory invocation), which owns the per-session kernel process. The
 * session is torn down when ToolRegistry.stop() disposes any loaded member of
 * the family.
 *
 * Caller MUST supply the `registerLazy` helper from
 * `Config.createToolRegistry()` (NOT bare `registry.registerFactory`) so
 * that `PermissionManager.isToolEnabled()` runs — this honors the
 * `coreTools` allowlist and whole-tool deny rules uniformly with the rest
 * of the built-in tools.
 */
export async function registerNodeReplTools(
  registerLazy: (name: ToolName, factory: ToolFactory) => Promise<void>,
  config: Config,
): Promise<void> {
  let session: NodeReplSession | null = null;
  const load = () => import('./tool.js');
  const getSession = async () => {
    const module = await load();
    if (!session) session = new module.NodeReplSession(config);
    return { module, session };
  };

  await registerLazy(ToolNames.NODE_REPL as ToolName, async () => {
    const { module, session } = await getSession();
    return new module.NodeReplTool(session);
  });
  await registerLazy(ToolNames.NODE_REPL_RESET as ToolName, async () => {
    const { module, session } = await getSession();
    return new module.NodeReplResetTool(session);
  });
  await registerLazy(
    ToolNames.NODE_REPL_ADD_NODE_MODULE_DIR as ToolName,
    async () => {
      const { module, session } = await getSession();
      return new module.NodeReplAddNodeModuleDirTool(session);
    },
  );
}
