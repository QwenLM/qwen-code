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
import type { ToolRegistry } from '../tool-registry.js';

/**
 * Register all 9 computer-use tools as lazy factories on the registry.
 * Each tool is deferred (`shouldDefer=true`), so they surface only via
 * ToolSearch keyword match. The first invocation triggers the
 * bootstrap state machine (install confirm → install → permission flow)
 * before forwarding to the upstream MCP server.
 *
 * Should only be called when `Config.isComputerUseEnabled()` is true.
 */
export function registerComputerUseTools(registry: ToolRegistry): void {
  for (const upstreamName of COMPUTER_USE_TOOL_NAMES) {
    const schema = COMPUTER_USE_SCHEMAS[upstreamName];
    const qwenName = `computer_use__${upstreamName}`;
    registry.registerFactory(
      qwenName,
      async () => new ComputerUseTool(upstreamName, schema),
    );
  }
}
