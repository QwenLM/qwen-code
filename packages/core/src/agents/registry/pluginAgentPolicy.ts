/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition } from '../types.js';

/**
 * Drops frontmatter fields that a plugin author must not be allowed to set on a
 * shipped agent: lifecycle hooks, MCP servers, permission mode, and any
 * isolation mode other than `worktree`. Silent on purpose — plugin authors
 * learn the rule from the changelog rather than warnings the model would
 * reflect back to users.
 */
export function stripUnsafePluginFields(agent: AgentDefinition): void {
  agent.hooks = undefined;
  agent.mcpServers = undefined;
  agent.permissionMode = undefined;
  agent.isolation = agent.isolation === 'worktree' ? 'worktree' : undefined;
}
