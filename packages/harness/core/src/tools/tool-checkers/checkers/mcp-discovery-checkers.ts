/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission checks for the lazy MCP discovery helpers, `mcp_list` and
 * `mcp_get`.
 *
 * They only describe what is connected. They stay rule-governed — a user can
 * deny one — but need no prompt of their own; refusing them would make lazy
 * MCP unusable before the first dispatch could even be asked about.
 */

import { alwaysAllowChecker, type HostToolChecker } from '../rule-precedence.js';

export function createMcpListToolChecker(toolName: string): HostToolChecker {
  return alwaysAllowChecker(toolName, 'mcp.list.allow');
}

export function createMcpGetToolChecker(toolName: string): HostToolChecker {
  return alwaysAllowChecker(toolName, 'mcp.get.allow');
}
