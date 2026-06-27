/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export { ComputerUseTool } from './tool.js';
export { ComputerUseClient } from './client.js';
export type { ComputerUseToolName, ComputerUseToolSchema } from './schemas.js';
export { COMPUTER_USE_TOOL_NAMES, COMPUTER_USE_SCHEMAS } from './schemas.js';

import { ComputerUseTool } from './tool.js';
import { COMPUTER_USE_SCHEMAS, COMPUTER_USE_TOOL_NAMES } from './schemas.js';
import type { ToolFactory } from '../tool-registry.js';
import type { ToolName } from '../../utils/tool-utils.js';
import type { Config } from '../../config/config.js';

/**
 * Register the full cua-driver computer-use tool surface as lazy factories.
 * Each tool is deferred (`shouldDefer=true`), so they surface only via
 * ToolSearch keyword match. The first invocation triggers the bootstrap state
 * machine (install confirm → install → permission flow) before forwarding to
 * the cua-driver MCP server.
 *
 * Caller MUST supply the `registerLazy` helper from
 * `Config.createToolRegistry()` (NOT the bare `registry.registerFactory`)
 * so that `PermissionManager.isToolEnabled()` runs — this honors the
 * `coreTools` allowlist and whole-tool deny rules uniformly with the
 * rest of the built-in tools. Bypassing it would silently expose these
 * tools regardless of permission configuration; flagged in PR #4590
 * review.
 *
 * Should only be called when `Config.isComputerUseEnabled()` is true.
 *
 * `config` is forwarded to each tool so execute() can read the active
 * approval mode. In YOLO the scheduler auto-approves the tool call and skips
 * the install-confirmation dialog (whose onConfirm records install approval),
 * so the tool must auto-approve the first-use install itself instead of
 * letting the bootstrap fallback refuse with "install declined by user".
 */
export async function registerComputerUseTools(
  registerLazy: (name: ToolName, factory: ToolFactory) => Promise<void>,
  config?: Config,
): Promise<void> {
  for (const upstreamName of COMPUTER_USE_TOOL_NAMES) {
    const schema = COMPUTER_USE_SCHEMAS[upstreamName];
    const qwenName = `computer_use__${upstreamName}` as ToolName;
    await registerLazy(
      qwenName,
      async () => new ComputerUseTool(upstreamName, schema, config),
    );
  }
}
