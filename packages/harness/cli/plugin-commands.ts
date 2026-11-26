/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Shared command syntax; products can replace actions on their own tree. */
export { createPluginsCommand } from './src/commands/plugins/index.js';
export { createSkillsCommand } from './src/commands/skills/index.js';
export { createAgentsCommand } from './src/commands/agents/index.js';
export { createMcpCommand } from './src/commands/mcp/index.js';
export { createRemoveCommand as createMcpRemoveCommand } from './src/commands/mcp/remove.js';
export {
  buildMcpServerConfig,
  createAddCommand,
  createMcpAddCommandBase,
  readAddCommandOptions,
  type AddCommandParsedOptions,
  type AddServerConfig,
  type AddServerOptions,
} from './src/commands/mcp/add.js';
export {
  applyAddJsonClientSecret,
  createAddJsonCommand,
  createMcpAddJsonCommandBase,
  parseAddJsonConfig,
} from './src/commands/mcp/addJson.js';
export {
  saveNewMcpServer,
  type SaveNewMcpServerOptions,
} from './src/commands/mcp/save.js';
export {
  getMcpServersFromConfig,
  getServerStatus,
  loadMcpCommandContext,
  type McpCommandContext,
} from './src/commands/mcp/list.js';
export {
  resolveMcpServerForCommand,
  type ResolvedMcpServer,
} from './src/commands/mcp/get.js';
export type { SettingSource } from './src/config/settings.js';

export {
  pluginsCommand,
  marketplaceCommand,
} from './src/ui/commands/pluginsCommand.js';
