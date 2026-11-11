/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProjectMcpConfigValidator } from '../../config/mcp/projectMcpJson.js';

export interface McpCommandOptions {
  readonly projectConfigValidator?: ProjectMcpConfigValidator;
}
